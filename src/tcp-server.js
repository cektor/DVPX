'use strict';

/**
 * DVPX Reflector — TCP sinyalleşme sunucusu / TCP signalling server
 *
 * Satır tabanlı metin protokolü (bkz. DVPX/README.md §2):
 *   DVPX 1 / LOGIN / SUBSCRIBE / UNSUBSCRIBE / TGLIST / PING / LOGOUT
 *
 * Dayanıklılık: her satır kendi try/catch'i içinde işlenir; bozuk bir istemci
 * yalnızca kendi bağlantısını düşürür, sunucuyu etkilemez.
 */

const net = require('net');

const { createLogger } = require('./logger');

const log = createLogger('tcp');

/** Tek satır üst sınırı — bellek şişmesine karşı. */
const MAX_LINE_BYTES = 512;
/** Login öncesi tolere edilen tampon (el sıkışma + LOGIN sığar). */
const MAX_BUFFER_BYTES = 4096;
/** Login yapılmadan bağlı kalınabilecek süre. */
const LOGIN_GRACE_MS = 15000;
/** Başarısız login denemesi üst sınırı (bağlantı başına). */
const MAX_LOGIN_ATTEMPTS = 5;

const PROTOCOL_VERSION = 1;

/**
 * Uzak reflektörlerin bir FDX davetini sahiplenmesi için tanınan süre (ms).
 *
 * Bu süre içinde `RINGING` gelmezse hedef ağın hiçbir yerinde değildir ve
 * arayana `NO_TARGET` yazılır. Kısa tutuldu: kullanıcı "aranıyor" ekranında
 * 30 saniye bekletilmemeli; peer bağı aynı ağda birkaç ms'de yanıt verir.
 */
const FDX_UZAK_YANIT_MS = 2000;

class TcpServer {
  /**
   * @param {object} cfg
   * @param {import('./control').Control} db kontrol katmanı (panel istemcisi)
   * @param {import('./sessions').SessionStore} sessions
   * @param {{onSessionClosed?:Function}} hooks
   */
  constructor(cfg, db, sessions, hooks) {
    this.cfg = cfg;
    this.db = db;
    this.sessions = sessions;
    this.hooks = hooks || {};
    this.server = null;
    this.stats = { accepted: 0, rejected: 0, logins: 0, loginFailures: 0 };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        try {
          this.handleConnection(socket);
        } catch (err) {
          log.error(`connection handler error: ${err.message}`);
          try { socket.destroy(); } catch (_) { /* yoksay */ }
        }
      });

      this.server.on('error', (err) => {
        if (!this.server.listening) {
          reject(err);
          return;
        }
        log.error(`server error: ${err.message}`);
      });

      this.server.listen(this.cfg.tcpPort, this.cfg.bindAddress, () => {
        log.info(`signalling listening on ${this.cfg.bindAddress}:${this.cfg.tcpPort}`);
        resolve();
      });
    });
  }

  handleConnection(socket) {
    const remote = socket.remoteAddress || '';

    if (this.sessions.size >= this.cfg.limits.maxSessions) {
      this.stats.rejected += 1;
      log.warn(`session limit reached (${this.cfg.limits.maxSessions}), refusing ${remote}`);
      this.safeWrite(socket, 'ERR SERVER_FULL');
      socket.end();
      return;
    }

    this.stats.accepted += 1;
    socket.setNoDelay(true);
    socket.setKeepAlive(true, 30000);

    const session = this.sessions.create(socket, remote);
    session.loginAttempts = 0;
    session.buffer = '';
    session.handshaken = false;

    log.debug(`connection from ${remote} (sessions: ${this.sessions.size})`);

    // Login yapılmayan bağlantıyı bekletmeyelim.
    session.loginTimer = setTimeout(() => {
      if (!session.loggedIn) {
        log.debug(`login grace expired for ${remote}`);
        this.safeWrite(socket, 'ERR LOGIN_TIMEOUT');
        socket.end();
      }
    }, LOGIN_GRACE_MS);

    socket.on('data', (chunk) => {
      try {
        this.onData(session, chunk);
      } catch (err) {
        log.warn(`data handling error from ${session.label}@${remote}: ${err.message}`);
        try { socket.destroy(); } catch (_) { /* yoksay */ }
      }
    });

    socket.on('error', (err) => {
      // ECONNRESET vb. istemci tarafı kopmaları normaldir.
      log.debug(`socket error ${remote}: ${err.message}`);
    });

    socket.on('close', () => {
      this.closeSession(session, 'socket closed');
    });
  }

  onData(session, chunk) {
    session.touchTcp();
    session.buffer += chunk.toString('utf8');

    if (session.buffer.length > MAX_BUFFER_BYTES) {
      this.safeWrite(session.socket, 'ERR LINE_TOO_LONG');
      session.socket.destroy();
      return;
    }

    let index = session.buffer.indexOf('\n');
    while (index !== -1) {
      const rawLine = session.buffer.slice(0, index).replace(/\r$/, '');
      session.buffer = session.buffer.slice(index + 1);

      if (rawLine.length > MAX_LINE_BYTES) {
        this.safeWrite(session.socket, 'ERR LINE_TOO_LONG');
        session.socket.destroy();
        return;
      }

      const line = rawLine.trim();
      if (line !== '') {
        // Komut işlemesi eşzamansız (DB erişimi olabilir); hatalar yutulmaz,
        // loglanır ve istemciye ERR gider.
        this.handleLine(session, line).catch((err) => {
          log.warn(`command error from ${session.label}: ${err.message}`);
          this.safeWrite(session.socket, 'ERR SERVER_ERROR');
        });
      }

      index = session.buffer.indexOf('\n');
    }
  }

  async handleLine(session, line) {
    const parts = line.split(/\s+/);
    const command = (parts[0] || '').toUpperCase();

    switch (command) {
      case 'DVPX':
        return this.cmdHandshake(session, parts);
      case 'LOGIN':
        return this.cmdLogin(session, parts);
      case 'SUBSCRIBE':
        return this.cmdSubscribe(session, parts);
      case 'UNSUBSCRIBE':
        return this.cmdUnsubscribe(session, parts);
      case 'TGLIST':
        return this.cmdTgList(session);
      case 'PING':
        this.safeWrite(session.socket, `PONG ${Date.now()}`);
        return undefined;
      case 'FDX':
        return this.cmdFdx(session, parts);
      case 'LOGOUT':
        this.safeWrite(session.socket, 'BYE');
        session.socket.end();
        return undefined;
      default:
        this.safeWrite(session.socket, 'ERR UNKNOWN_COMMAND');
        return undefined;
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
   * FDX — full-duplex özel çağrı sinyalleşmesi
   *
   * Reflektör sesi zaten yön gözetmeden aktarır; full-duplex için taşımada
   * hiçbir şey değişmez. Buradaki tek iş, iki istemci arasında ÇAĞRI KURMA
   * satırlarını iletmek ve "meşgul / yok / desteklenmiyor" durumlarını net
   * bir yanıta çevirmektir.
   *
   *   → FDX INVITE <hedefDmrId>      davet gönder
   *   ← FDX RING <kaynakId> <çağrı işareti>   (hedefe)
   *   ← FDX FAIL <sebep>             NO_TARGET | BUSY | SELF | BAD_ID |
   *                                  NOT_LOGGED_IN | BAD_ARGS
   *   → FDX ACCEPT <peerId>          kabul et
   *   ← FDX ACCEPTED <peerId>        (iki tarafa da)
   *   → FDX REJECT <peerId>          reddet
   *   ← FDX REJECTED <peerId>        (arayana)
   *   → FDX END <peerId>             çağrıyı bitir (ya da daveti iptal et)
   *   ← FDX ENDED <peerId>           (karşı tarafa)
   *
   * ESKİ İSTEMCİLER: FDX hiç göndermez, hiçbir şey değişmez.
   * ESKİ REFLEKTÖRLER: 'ERR UNKNOWN_COMMAND' döner; istemci bunu görüp
   * kullanıcıya "bu reflektör full-duplex desteklemiyor" der.
   * ══════════════════════════════════════════════════════════════════════ */
  cmdFdx(session, parts) {
    if (!session.loggedIn) {
      this.safeWrite(session.socket, 'FDX FAIL NOT_LOGGED_IN');
      return;
    }
    const alt = (parts[1] || '').toUpperCase();
    const hedefId = Number.parseInt(parts[2], 10);
    if (!Number.isFinite(hedefId) || hedefId <= 0) {
      this.safeWrite(session.socket, 'FDX FAIL BAD_ARGS');
      return;
    }

    switch (alt) {
      case 'INVITE':
        return this.fdxInvite(session, hedefId);
      case 'ACCEPT':
        return this.fdxAccept(session, hedefId);
      case 'REJECT':
        return this.fdxReject(session, hedefId);
      case 'END':
        return this.fdxEnd(session, hedefId);
      default:
        this.safeWrite(session.socket, 'FDX FAIL BAD_ARGS');
        return undefined;
    }
  }

  /** Hedef oturumu bulur (ESSID'li kimlikte ana ID'ye düşer). */
  fdxHedefBul(dmrId) {
    return this.sessions.byDmrId(dmrId) || this.sessions.byBaseDmrId(dmrId);
  }

  /**
   * Bir FDX satırını peer bağı üzerinden diğer reflektörlere iletir.
   *
   * @returns {boolean} bağ etkin ve satır gönderildiyse true
   */
  fdxUzagaGonder(satir) {
    return !!(this.peers && this.peers.ctrlYayinla(`FDX ${satir}`));
  }

  /**
   * Hedef YERELDE YOK — başka bir reflektörde olabilir, oraya sor.
   *
   * Ses zaten ağ genelinde akıyor (özel çağrı paketleri peer'lara da gider),
   * bu yüzden çağrı KURULUMU da ağ genelinde olmalıdır; aksi hâlde karşı taraf
   * bağlı olduğu hâlde "çevrimiçi değil" yanıtı alınır.
   *
   * Kimin sahipleneceğini bilmediğimiz için satır TÜM peer'lara gider; hedefi
   * kendinde bulan `RINGING` ile yanıtlar. Kısa bir pencere içinde kimse
   * yanıtlamazsa hedef gerçekten çevrimiçi değildir.
   */
  fdxUzagaSor(session, hedefId) {
    /* DURUM ÖNCE KURULUR, SATIR SONRA GİDER.
     * Yanıt (RINGING/FAIL) gönderme çağrısının içinden bile dönebilir; oturum
     * hâlâ 'idle' görünürse yanıt sessizce düşer ve çağrı, karşı taraf
     * çalıyorken arayan tarafta zaman aşımına uğrardı. */
    session.fdxPeer = hedefId;
    session.fdxState = 'inviting';
    session.fdxRemote = true;
    session.fdxSince = Date.now();
    session.fdxRemoteTimer = setTimeout(() => {
      session.fdxRemoteTimer = null;
      if (session.fdxState !== 'inviting' || !session.fdxRemote) {
        return;
      }
      // Hiçbir reflektör sahiplenmedi: hedef gerçekten çevrimiçi değil.
      this.safeWrite(session.socket, 'FDX FAIL NO_TARGET');
      this.fdxSifirla(session);
    }, FDX_UZAK_YANIT_MS);
    session.fdxRemoteTimer.unref?.();

    if (!this.fdxUzagaGonder(`INVITE ${session.dmrId} ${hedefId} ${session.callsign || '-'}`)) {
      // Peer bağı yok/kapalı: hiçbir şey gönderilmedi, durumu geri al.
      this.fdxSifirla(session);
      return false;
    }
    log.info(`FDX davet ${session.dmrId} -> ${hedefId} (uzak reflektorlere soruldu)`);
    return true;
  }

  /** İki DMR kimliği AYNI KİŞİYE mi ait? (ESSID yok sayılır) */
  static fdxTabanId(dmrId) {
    const n = Number(dmrId) || 0;
    return n > 9999999 ? Math.floor(n / 100) : n;
  }

  /**
   * Peer'dan gelen satırdaki kimlik, beklediğimiz karşı taraf mı?
   *
   * ESSID yok sayılır: arayan taban kimliği (7 hane) yazmış olabilirken karşı
   * reflektör kendi oturumunun TAM kimliğini bildirir. Katı eşitlik, çağrının
   * kurulduğu hâlde yanıtların düşmesine yol açardı.
   */
  fdxAyniKisi(a, b) {
    const ta = TcpServer.fdxTabanId(a);
    return ta > 0 && ta === TcpServer.fdxTabanId(b);
  }

  fdxInvite(session, hedefId) {
    if (hedefId === session.dmrId) {
      this.safeWrite(session.socket, 'FDX FAIL SELF');
      return;
    }
    // Zaten bir çağrıdaysak önce onu bitirmek gerekir.
    if (session.fdxState !== 'idle') {
      this.safeWrite(session.socket, 'FDX FAIL BUSY');
      return;
    }
    const hedef = this.fdxHedefBul(hedefId);
    if (hedef === session) {
      // Kendi TABAN kimliğimizi hedeflemişiz (ESSID'siz yazılmış olabilir).
      this.safeWrite(session.socket, 'FDX FAIL SELF');
      return;
    }
    if (!hedef || !hedef.loggedIn) {
      // Yerelde yok — ağın geri kalanına sor; oradan da yanıt gelmezse
      // zamanlayıcı NO_TARGET yazar.
      if (this.fdxUzagaSor(session, hedefId)) {
        return;
      }
      this.safeWrite(session.socket, 'FDX FAIL NO_TARGET');
      return;
    }
    if (hedef.fdxState !== 'idle') {
      this.safeWrite(session.socket, 'FDX FAIL BUSY');
      return;
    }

    session.fdxPeer = hedef.dmrId;
    session.fdxState = 'inviting';
    session.fdxSince = Date.now();
    hedef.fdxPeer = session.dmrId;
    hedef.fdxState = 'ringing';
    hedef.fdxSince = Date.now();

    this.safeWrite(hedef.socket, `FDX RING ${session.dmrId} ${session.callsign}`);
    this.safeWrite(session.socket, `FDX INVITED ${hedef.dmrId}`);
    log.info(`FDX davet ${session.dmrId} -> ${hedef.dmrId}`);
  }

  fdxAccept(session, peerId) {
    if (session.fdxState !== 'ringing' || session.fdxPeer !== peerId) {
      this.safeWrite(session.socket, 'FDX FAIL NO_CALL');
      return;
    }
    if (session.fdxRemote) {
      // Arayan başka bir reflektörde: kabulü peer bağı taşır. Kendi
      // istemcimize ACCEPTED'ı hemen yazıyoruz — ses yolu iki tarafta da aynı
      // anda açılmalı, aksi hâlde bir taraf PTT bekler.
      session.fdxState = 'active';
      this.safeWrite(session.socket, `FDX ACCEPTED ${peerId}`);
      this.fdxUzagaGonder(`ACCEPT ${session.dmrId} ${peerId}`);
      log.info(`FDX kabul ${session.dmrId} <-> ${peerId} (uzak)`);
      return;
    }
    const peer = this.fdxHedefBul(peerId);
    if (!peer || peer.fdxState !== 'inviting' || peer.fdxPeer !== session.dmrId) {
      this.fdxSifirla(session);
      this.safeWrite(session.socket, 'FDX FAIL NO_TARGET');
      return;
    }
    session.fdxState = 'active';
    peer.fdxState = 'active';
    // İKİ TARAFA da bildir: her iki istemci de aynı anda full-duplex kipine
    // geçmeli, yoksa bir taraf PTT bekler ve konuşma tek yönlü kalır.
    this.safeWrite(session.socket, `FDX ACCEPTED ${peer.dmrId}`);
    this.safeWrite(peer.socket, `FDX ACCEPTED ${session.dmrId}`);
    log.info(`FDX kabul ${session.dmrId} <-> ${peer.dmrId}`);
  }

  fdxReject(session, peerId) {
    if (session.fdxState !== 'ringing' || session.fdxPeer !== peerId) {
      this.safeWrite(session.socket, 'FDX FAIL NO_CALL');
      return;
    }
    if (session.fdxRemote) {
      this.fdxUzagaGonder(`REJECT ${session.dmrId} ${peerId}`);
      this.fdxSifirla(session);
      log.info(`FDX ret ${session.dmrId} -> ${peerId} (uzak)`);
      return;
    }
    const peer = this.fdxHedefBul(peerId);
    if (peer && peer.fdxPeer === session.dmrId) {
      this.safeWrite(peer.socket, `FDX REJECTED ${session.dmrId}`);
      this.fdxSifirla(peer);
    }
    this.fdxSifirla(session);
    log.info(`FDX ret ${session.dmrId} -> ${peerId}`);
  }

  fdxEnd(session, peerId) {
    // Hem süren çağrıyı bitirmek hem çalan daveti iptal etmek için kullanılır.
    if (session.fdxState === 'idle') {
      this.safeWrite(session.socket, 'FDX FAIL NO_CALL');
      return;
    }
    if (session.fdxRemote) {
      const uzakId = peerId || session.fdxPeer;
      this.fdxUzagaGonder(`END ${session.dmrId} ${uzakId}`);
      this.safeWrite(session.socket, `FDX ENDED ${uzakId}`);
      this.fdxSifirla(session);
      return;
    }
    const peer = this.fdxHedefBul(peerId || session.fdxPeer);
    if (peer && peer.fdxPeer === session.dmrId) {
      this.safeWrite(peer.socket, `FDX ENDED ${session.dmrId}`);
      this.fdxSifirla(peer);
    }
    this.safeWrite(session.socket, `FDX ENDED ${peerId || session.fdxPeer}`);
    this.fdxSifirla(session);
  }

  fdxSifirla(session) {
    if (!session) {
      return;
    }
    if (session.fdxRemoteTimer) {
      clearTimeout(session.fdxRemoteTimer);
      session.fdxRemoteTimer = null;
    }
    session.fdxPeer = 0;
    session.fdxState = 'idle';
    session.fdxRemote = false;
    session.fdxSince = 0;
  }

  /* ══════════════════════════════════════════════════════════════════════
   * Peer bağından gelen FDX satırları (başka bir reflektörün kullanıcısı)
   *
   * Satır dilbilgisi — hepsi `FDX <TİP> <kaynakDmrId> <hedefDmrId> [ek]`:
   *   FDX INVITE  <arayan> <aranan> <çağrıİşareti>
   *   FDX RINGING <aranan> <arayan>      hedefi bulduk, telefonu çalıyor
   *   FDX ACCEPT  <aranan> <arayan>
   *   FDX REJECT  <aranan> <arayan>
   *   FDX END     <kaynak> <hedef>
   *   FDX FAIL    <sebep> <kaynak> <hedef>
   *
   * Çerçeve TÜM peer'lara yayımlandığı için hedefi bizde olmayan satırlar
   * SESSİZCE atılır — bu normaldir, hata değildir.
   * ══════════════════════════════════════════════════════════════════════ */
  fdxPeerSatiri(satir, peer) {
    const parcalar = String(satir || '').trim().split(/\s+/);
    if (parcalar[0] !== 'FDX') {
      return;
    }
    const tip = (parcalar[1] || '').toUpperCase();
    // FAIL'de 2. alan sebeptir; kimlikler bir sağa kayar.
    const kaydir = tip === 'FAIL' ? 1 : 0;
    const kaynakId = Number.parseInt(parcalar[2 + kaydir], 10);
    const hedefId = Number.parseInt(parcalar[3 + kaydir], 10);
    if (!Number.isFinite(kaynakId) || !Number.isFinite(hedefId)
        || kaynakId <= 0 || hedefId <= 0) {
      return;
    }

    // Satır BİZİM kullanıcımızı ilgilendiriyor mu?
    const yerel = this.fdxHedefBul(hedefId);
    if (!yerel || !yerel.loggedIn) {
      return;
    }

    switch (tip) {
      case 'INVITE': {
        if (yerel.fdxState !== 'idle') {
          this.fdxUzagaGonder(`FAIL BUSY ${yerel.dmrId} ${kaynakId}`);
          return;
        }
        const cagri = parcalar[4] && parcalar[4] !== '-' ? parcalar[4] : '';
        yerel.fdxPeer = kaynakId;
        yerel.fdxState = 'ringing';
        yerel.fdxRemote = true;
        yerel.fdxSince = Date.now();
        this.safeWrite(yerel.socket, `FDX RING ${kaynakId} ${cagri}`);
        // Daveti SAHİPLENDİĞİMİZİ bildir; arayanın reflektörü NO_TARGET
        // zamanlayıcısını iptal etsin. Kendi TAM kimliğimizi yolluyoruz:
        // arayan taban kimlikle aramış olabilir.
        this.fdxUzagaGonder(`RINGING ${yerel.dmrId} ${kaynakId}`);
        log.info(`FDX gelen davet ${kaynakId} -> ${yerel.dmrId} (${peer && peer.name})`);
        return;
      }
      case 'RINGING': {
        if (yerel.fdxState !== 'inviting' || !yerel.fdxRemote) {
          return;
        }
        if (!yerel.fdxRemoteTimer) {
          /* Daveti BAŞKA bir reflektör önce sahiplendi (kişinin iki cihazı iki
           * ayrı reflektörde olabilir). Geç kalanı hemen kapat, yoksa orada
           * telefon boşuna çalmaya devam eder. */
          this.fdxUzagaGonder(`END ${yerel.dmrId} ${kaynakId}`);
          return;
        }
        clearTimeout(yerel.fdxRemoteTimer);
        yerel.fdxRemoteTimer = null;
        // Hedefin GERÇEK (ESSID'li) kimliğine sabitlen.
        yerel.fdxPeer = kaynakId;
        this.safeWrite(yerel.socket, `FDX INVITED ${kaynakId}`);
        return;
      }
      case 'ACCEPT': {
        if (yerel.fdxState !== 'inviting' || !this.fdxAyniKisi(yerel.fdxPeer, kaynakId)) {
          return;
        }
        if (yerel.fdxRemoteTimer) {
          clearTimeout(yerel.fdxRemoteTimer);
          yerel.fdxRemoteTimer = null;
        }
        yerel.fdxState = 'active';
        this.safeWrite(yerel.socket, `FDX ACCEPTED ${kaynakId}`);
        log.info(`FDX kabul ${kaynakId} <-> ${yerel.dmrId} (uzak)`);
        return;
      }
      case 'REJECT': {
        if (yerel.fdxState === 'idle' || !this.fdxAyniKisi(yerel.fdxPeer, kaynakId)) {
          return;
        }
        this.safeWrite(yerel.socket, `FDX REJECTED ${kaynakId}`);
        this.fdxSifirla(yerel);
        return;
      }
      case 'END': {
        if (yerel.fdxState === 'idle' || !this.fdxAyniKisi(yerel.fdxPeer, kaynakId)) {
          return;
        }
        this.safeWrite(yerel.socket, `FDX ENDED ${kaynakId}`);
        this.fdxSifirla(yerel);
        return;
      }
      case 'FAIL': {
        if (yerel.fdxState !== 'inviting' || !this.fdxAyniKisi(yerel.fdxPeer, kaynakId)) {
          return;
        }
        const sebep = (parcalar[2] || 'UNKNOWN').toUpperCase();
        this.safeWrite(yerel.socket, `FDX FAIL ${sebep}`);
        this.fdxSifirla(yerel);
        return;
      }
      default:
        log.debug(`bilinmeyen peer FDX satiri: ${satir}`);
    }
  }

  /**
   * Oturum kapanırken çağrının DİĞER UCUNU haberdar eder.
   *
   * Bu olmadan, biri uygulamayı kapattığında karşı taraf sonsuza kadar
   * full-duplex kipinde (mikrofonu açık) kalırdı.
   */
  fdxTemizle(session) {
    if (!session || session.fdxState === 'idle') {
      return;
    }
    if (session.fdxRemote) {
      if (session.fdxPeer) {
        this.fdxUzagaGonder(`END ${session.dmrId} ${session.fdxPeer}`);
      }
      this.fdxSifirla(session);
      return;
    }
    const peer = this.fdxHedefBul(session.fdxPeer);
    if (peer && peer.fdxPeer === session.dmrId) {
      this.safeWrite(peer.socket, `FDX ENDED ${session.dmrId}`);
      this.fdxSifirla(peer);
    }
    this.fdxSifirla(session);
  }

  cmdHandshake(session, parts) {
    const version = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(version) || version !== PROTOCOL_VERSION) {
      this.safeWrite(session.socket, `ERR UNSUPPORTED_VERSION ${PROTOCOL_VERSION}`);
      session.socket.end();
      return;
    }
    session.handshaken = true;
    this.safeWrite(session.socket, `DVPX ${PROTOCOL_VERSION} OK ${this.cfg.serverName}`);
  }

  /**
   * LOGIN <dmrId> <callsign> — ŞİFRESİZ. Kimlik DMR ID + çağrı işaretidir;
   * kullanıcı panelde önceden kayıtlı olmak zorunda değildir (ilk girişte
   * otomatik kaydedilir). Yalnızca panelden "kapalı" yapılmış ID'ler reddedilir.
   */
  async cmdLogin(session, parts) {
    if (session.loggedIn) {
      this.safeWrite(session.socket, 'ERR ALREADY_LOGGED_IN');
      return;
    }
    if (session.loginAttempts >= MAX_LOGIN_ATTEMPTS) {
      this.stats.loginFailures += 1;
      this.safeWrite(session.socket, 'LOGIN FAIL RATE_LIMIT');
      session.socket.end();
      return;
    }
    session.loginAttempts += 1;

    const dmrId = Number.parseInt(parts[1], 10);
    const callsign = String(parts[2] || '').toUpperCase();

    if (!Number.isFinite(dmrId) || dmrId < 1 || dmrId > 4294967295) {
      this.stats.loginFailures += 1;
      this.safeWrite(session.socket, 'LOGIN FAIL BAD_ID');
      return;
    }
    // Amatör çağrı işareti: 3-16 karakter, A-Z 0-9 ile - ve /
    if (!/^[A-Z0-9\-/]{3,16}$/.test(callsign)) {
      this.stats.loginFailures += 1;
      this.safeWrite(session.socket, 'LOGIN FAIL BAD_CALLSIGN');
      return;
    }

    let user;
    try {
      user = await this.db.checkUser(dmrId, callsign);
    } catch (err) {
      // Buraya yalnızca reflektör hizmet veremez durumdayken düşülür: panel
      // token'ı reddetmiş (kilitli) ya da henüz hiç politika alınmamış.
      log.error(`login refused for ${dmrId}: ${err.message}`);
      this.safeWrite(session.socket, 'LOGIN FAIL SERVER_ERROR');
      return;
    }

    if (user.blocked) {
      this.stats.loginFailures += 1;
      log.warn(`login refused (blocked): ${user.callsign}/${dmrId} from ${session.remoteAddress}`);
      this.safeWrite(session.socket, 'LOGIN FAIL BLOCKED');
      return;
    }

    // Bağlantı bu arada kapandıysa oturumu indekslere yazma.
    if (session.socket.destroyed) {
      return;
    }

    const previous = this.sessions.attachIdentity(session, {
      id: user.id,
      dmrId,
      callsign: user.callsign || callsign,
    });
    if (previous) {
      log.info(`replacing older session of ${callsign}/${dmrId} from ${previous.remoteAddress}`);
      this.safeWrite(previous.socket, 'ERR SESSION_REPLACED');
      try { previous.socket.end(); } catch (_) { /* yoksay */ }
    }

    if (session.loginTimer) {
      clearTimeout(session.loginTimer);
      session.loginTimer = null;
    }

    this.stats.logins += 1;
    log.info(`login ok: ${callsign}/${dmrId} from ${session.remoteAddress}`);
    this.safeWrite(session.socket, `LOGIN OK ${dmrId} ${session.callsign} ${session.token}`);

    // Girişi panele BİLDİR (kullanıcı kaydı, son giriş, cihaz bilgisi oradan
    // doğar). Kuyruğa alınır; yanıt beklenmez — istemci bir ağ turu kadar bile
    // bekletilmez ve panel erişilemezse giriş yine de tamamlanır.
    this.db.reportLogin(dmrId, session.callsign, session.remoteAddress);
  }

  async cmdSubscribe(session, parts) {
    if (!session.loggedIn) {
      this.safeWrite(session.socket, 'SUBSCRIBE FAIL NOT_LOGGED_IN');
      return;
    }
    const tg = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(tg) || tg < 1 || tg > 4294967295) {
      this.safeWrite(session.socket, 'SUBSCRIBE FAIL UNKNOWN_TG');
      return;
    }

    let check;
    try {
      check = await this.db.checkTalkgroup(tg, session.dmrId);
    } catch (err) {
      log.error(`talkgroup check failed for ${tg}: ${err.message}`);
      this.safeWrite(session.socket, 'SUBSCRIBE FAIL SERVER_ERROR');
      return;
    }

    if (!check.ok) {
      this.safeWrite(session.socket, `SUBSCRIBE FAIL ${check.reason}`);
      return;
    }

    const result = this.sessions.subscribe(session, tg);
    if (!result.ok) {
      this.safeWrite(session.socket, `SUBSCRIBE FAIL ${result.reason}`);
      return;
    }

    log.info(`${session.label} subscribed to TG ${tg}`);
    this.safeWrite(session.socket, `SUBSCRIBE OK ${tg} ${check.name}`);
  }

  cmdUnsubscribe(session, parts) {
    if (!session.loggedIn) {
      this.safeWrite(session.socket, 'ERR NOT_LOGGED_IN');
      return;
    }
    const tg = Number.parseInt(parts[1], 10);
    if (!Number.isFinite(tg)) {
      this.safeWrite(session.socket, 'ERR BAD_TG');
      return;
    }
    this.sessions.unsubscribe(session, tg);
    log.info(`${session.label} unsubscribed from TG ${tg}`);
    this.safeWrite(session.socket, `UNSUBSCRIBE OK ${tg}`);
  }

  async cmdTgList(session) {
    let list;
    try {
      list = await this.db.activeTalkgroups(session.dmrId);
    } catch (err) {
      log.error(`TGLIST failed: ${err.message}`);
      this.safeWrite(session.socket, 'ERR SERVER_ERROR');
      return;
    }
    // Tek satırda JSON: istemci tarafında ayrıştırması kolay, satır sonu içermez.
    this.safeWrite(session.socket, `TGLIST ${JSON.stringify(list)}`);
  }

  /** Yazma hataları bağlantıya özeldir; sunucuyu düşürmemeli. */
  safeWrite(socket, line) {
    if (!socket || socket.destroyed || !socket.writable) {
      return;
    }
    try {
      socket.write(line + '\n');
    } catch (err) {
      log.debug(`write failed: ${err.message}`);
    }
  }

  closeSession(session, reason) {
    if (!session || session.closed) {
      return;
    }
    session.closed = true;

    if (session.loginTimer) {
      clearTimeout(session.loginTimer);
      session.loginTimer = null;
    }

    // Yayın ortasında koptuysa çağrı kaydını tamamla.
    if (typeof this.hooks.onSessionClosed === 'function') {
      try {
        this.hooks.onSessionClosed(session, reason);
      } catch (err) {
        log.warn(`onSessionClosed hook error: ${err.message}`);
      }
    }

    // Full-duplex çağrının diğer ucunu haberdar et — ONDAN ÖNCE, çünkü
    // remove() sonrası oturum artık dizinlerde bulunamaz. Bu olmadan karşı
    // taraf sonsuza kadar mikrofonu açık bekler.
    this.fdxTemizle(session);

    this.sessions.remove(session);
    if (session.loggedIn || session.dmrId) {
      log.info(`disconnected: ${session.label} (${reason}) — sessions: ${this.sessions.size}`);
    } else {
      log.debug(`disconnected: ${session.remoteAddress} (${reason})`);
    }
  }

  /**
   * Oturumu zorla düşürür — panelden engellenen kullanıcı için.
   *
   * Eskiden engelleme yalnızca YENİ girişleri etkiliyordu: o anda konuşan biri
   * engellendiğinde bağlantısı kopana kadar konuşmaya devam ediyordu. Politika
   * her güncellendiğinde index.js buraya uğrar; engel artık ANINDA hüküm sürer.
   */
  kick(session, reason) {
    if (!session || session.closed) {
      return;
    }
    log.warn(`kick: ${session.label} (${reason})`);
    this.safeWrite(session.socket, `ERR ${reason}`);
    try {
      session.socket.destroy();
    } catch (err) {
      this.closeSession(session, `kick: ${reason}`);
    }
  }

  /**
   * İstemciye aboneliğinin sona erdiğini bildirir.
   *
   * Panelden bir TG kapatıldığında ya da özel TG yetkisi geri alındığında
   * çağrılır. Protokolün var olan `UNSUBSCRIBE OK` yanıtını kullanır: istemci
   * bunu zaten tanır, yeni bir mesaj türü öğrenmesi gerekmez.
   */
  notifyUnsubscribed(session, tgNumber) {
    this.safeWrite(session.socket, `UNSUBSCRIBE OK ${tgNumber}`);
  }

  /** Zaman aşımına düşen oturumları kapatır (index.js periyodik olarak çağırır). */
  reapExpired() {
    const expired = this.sessions.findExpired(Date.now());
    for (const session of expired) {
      log.info(`session timeout: ${session.label}`);
      this.safeWrite(session.socket, 'ERR TIMEOUT');
      try {
        session.socket.destroy();
      } catch (err) {
        this.closeSession(session, 'timeout');
      }
    }
    return expired.length;
  }

  async close() {
    for (const session of this.sessions.all()) {
      this.safeWrite(session.socket, 'ERR SERVER_SHUTDOWN');
      try { session.socket.destroy(); } catch (_) { /* yoksay */ }
    }
    if (!this.server) {
      return;
    }
    await new Promise((resolve) => {
      this.server.close(() => resolve());
      // close() yalnızca yeni bağlantıları engeller; bekleyen soketler için
      // yukarıda destroy ettik, bu yüzden geri çağrı hızla gelir.
      setTimeout(resolve, 2000);
    });
    log.info('signalling server closed');
  }
}

module.exports = { TcpServer, PROTOCOL_VERSION };
