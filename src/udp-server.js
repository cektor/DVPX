'use strict';

/**
 * DVPX Reflector — UDP ses yönlendirme / UDP voice forwarding
 *
 * TASARIM İLKESİ: Opus yükü ASLA açılmaz, decode edilmez, yeniden paketlenmez.
 * Gelen tampon bit birebir hedeflere gönderilir. Paket başına maliyet bir Map
 * araması + N adet socket.send çağrısıdır.
 *
 * Her datagram tek bir try/catch içinde işlenir: bozuk/eksik/kötü niyetli bir
 * paket yalnızca sayaca yazılır, süreç çökmez.
 */

const dgram = require('dgram');

const { createLogger } = require('./logger');
const packet = require('./packet');
const { PeerManager } = require('./peers');

const log = createLogger('udp');

class UdpServer {
  /**
   * @param {object} cfg
   * @param {import('./db').Database} db
   * @param {import('./sessions').SessionStore} sessions
   */
  constructor(cfg, db, sessions) {
    this.cfg = cfg;
    this.db = db;
    this.sessions = sessions;
    this.socket = null;
    /**
     * Reflektorler arasi bag yoneticisi (index.js tarafindan verilir).
     *
     * null ise reflektor tek basina calisir; davranis eskisiyle birebir aynidir.
     */
    this.peers = null;

    this.stats = {
      received: 0,
      forwarded: 0,
      dropped: 0,
      malformed: 0,
      unregistered: 0,
      endpointMismatch: 0,
      notSubscribed: 0,
      noTarget: 0,
      floodLimited: 0,
      registers: 0,
      registerRejected: 0,
      sendErrors: 0,
      // Peer'dan gelip yerel abonelere teslim edilen ses cerceveleri.
      peerIn: 0,
      peerOut: 0,
      peerNoSub: 0,
      peerTgClosed: 0,
    };
  }

  listen() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('error', (err) => {
        if (!this.bound) {
          reject(err);
          return;
        }
        // Bağlandıktan sonraki hatalar (ICMP port unreachable vb.) ölümcül değil.
        log.warn(`socket error: ${err.message}`);
      });

      this.socket.on('message', (msg, rinfo) => {
        try {
          this.onMessage(msg, rinfo);
        } catch (err) {
          // Buraya düşmesi beklenmiyor; düşerse tek paket kaybı olur.
          this.stats.dropped += 1;
          log.warn(`unhandled packet error from ${rinfo.address}:${rinfo.port}: ${err.message}`);
        }
      });

      this.socket.on('listening', () => {
        this.bound = true;
        const a = this.socket.address();
        log.info(`voice listening on ${a.address}:${a.port}`);
        resolve();
      });

      this.socket.bind(this.cfg.udpPort, this.cfg.bindAddress);
    });
  }

  onMessage(msg, rinfo) {
    this.stats.received += 1;

    /* ── Reflektorler arasi bag cercevesi mi? ──────────────────────────────
     * Peer cerceveleri 'D','X' ile baslar, istemci paketleri 'D','V' ile.
     * Bu ayrim, peer trafiginin AYNI UDP portunu paylasmasini mumkun kilar:
     * isletmecinin guvenlik duvarinda yeni bir port acmasi gerekmez.
     * Ayrim BURADA, packet.parse'tan ONCE yapilir; yoksa peer cerceveleri
     * "bozuk paket" sayilirdi.
     * ──────────────────────────────────────────────────────────────────── */
    if (PeerManager.peerFrameMi(msg)) {
      if (this.peers) {
        this.peers.handleFrame(msg, rinfo);
      } else {
        this.stats.dropped += 1;
      }
      return;
    }

    const parsed = packet.parse(msg, this.cfg.limits.maxPayloadBytes);
    if (!parsed.ok) {
      this.stats.malformed += 1;
      this.stats.dropped += 1;
      // Sel hâlinde log spam'i olmasın: yalnızca debug seviyesinde.
      log.debug(`malformed packet from ${rinfo.address}:${rinfo.port} (${parsed.reason}, ${msg.length}b)`);
      return;
    }

    const header = parsed.header;

    /* ── REGISTER: UDP endpoint eşlemesi ─────────────────────────────────── */
    if (header.packetType === packet.PACKET_TYPE.REGISTER) {
      this.handleRegister(msg, rinfo, header);
      return;
    }

    /* ── Kimlik doğrulama: kaynak oturumu bulunmalı ──────────────────────── */
    const session = this.sessions.byDmrId(header.sourceId);
    if (!session || !session.loggedIn) {
      this.stats.unregistered += 1;
      this.stats.dropped += 1;
      log.debug(`no session for source ${header.sourceId} (${rinfo.address}:${rinfo.port})`);
      return;
    }
    if (!session.matchesEndpoint(rinfo.address, rinfo.port)) {
      this.stats.endpointMismatch += 1;
      this.stats.dropped += 1;
      log.debug(
        `endpoint mismatch for ${session.label}: packet ${rinfo.address}:${rinfo.port}, `
        + `registered ${session.udpAddress}:${session.udpPort}`
      );
      return;
    }

    if (!session.allowPacket(this.cfg.limits.packetsPerSecond)) {
      this.stats.floodLimited += 1;
      this.stats.dropped += 1;
      return;
    }

    session.touchUdp();
    session.packetsIn += 1;

    /* ── Yayın durumu izleme (call_log için) ─────────────────────────────── */
    this.trackTransmission(session, header);

    /* ── Yönlendirme / forwarding ────────────────────────────────────────── */
    if (header.callType === packet.CALL_TYPE.PRIVATE) {
      this.forwardPrivate(msg, session, header);
    } else {
      this.forwardTalkgroup(msg, session, header);
    }
  }

  /**
   * REGISTER paketi: TCP'de verilen jetonu UDP kaynağına bağlar.
   * Jeton geçerli olsa bile IP, TCP oturumunun IP'siyle aynı olmak zorundadır.
   */
  handleRegister(msg, rinfo, header) {
    this.stats.registers += 1;

    const token = packet.payloadSlice(msg).toString('ascii').trim();
    if (!/^[0-9a-f]{32}$/.test(token)) {
      this.stats.registerRejected += 1;
      log.debug(`register with malformed token from ${rinfo.address}:${rinfo.port}`);
      return;
    }

    const session = this.sessions.byToken(token);
    if (!session || !session.loggedIn) {
      this.stats.registerRejected += 1;
      log.debug(`register with unknown token from ${rinfo.address}:${rinfo.port}`);
      return;
    }
    if (session.dmrId !== header.sourceId) {
      this.stats.registerRejected += 1;
      log.warn(`register source mismatch: token belongs to ${session.dmrId}, packet claims ${header.sourceId}`);
      return;
    }

    // TCP ve UDP aynı istemciden gelmeli. IPv6 eşlemeli IPv4 (::ffff:1.2.3.4)
    // biçimini normalize ederek karşılaştırıyoruz.
    const tcpIp = UdpServer.normalizeIp(session.remoteAddress);
    const udpIp = UdpServer.normalizeIp(rinfo.address);
    if (tcpIp !== udpIp) {
      this.stats.registerRejected += 1;
      log.warn(`register ip mismatch for ${session.label}: tcp ${tcpIp} vs udp ${udpIp}`);
      return;
    }

    const isNew = !session.registered
      || session.udpAddress !== rinfo.address
      || session.udpPort !== rinfo.port;

    this.sessions.registerEndpoint(session, rinfo.address, rinfo.port);

    if (isNew) {
      log.info(`registered ${session.label} at ${rinfo.address}:${rinfo.port}`);
    }

    // Onay: aynı REGISTER paketini geri yankıla (istemci NAT eşlemesini doğrular).
    const ack = packet.build({
      callType: packet.CALL_TYPE.TALKGROUP,
      packetType: packet.PACKET_TYPE.REGISTER,
      sourceId: session.dmrId,
      targetId: 0,
      seqNum: header.seqNum,
    }, Buffer.alloc(0));

    this.send(ack, rinfo.port, rinfo.address, session);
  }

  /** Özel çağrı: hedef DMR ID'nin kayıtlı endpoint'ine tek kopya. */
  forwardPrivate(msg, session, header) {
    /* ── ECHO TEST ────────────────────────────────────────────────────────
     * Panelde `is_system=1` ile işaretli sabit TG'nin numarası (varsayılan
     * 112233, "Echo Test"). Bu numaraya yapılan özel çağrı gerçek bir hedef
     * ARANMADAN doğrudan gönderene geri yansıtılır — ses testi budur.
     *
     * KAYDET, SONRA OYNAT — CANLI YANSITMA DEĞİL. Paketi ANINDA geri
     * göndermek "canlı monitör" gibi davranır: kişi konuşurken AYNI ANDA
     * kendi sesini duyar — istenen bu değildir. Bunun yerine PTT_ON..PTT_OFF
     * arasındaki tüm kareler biriktirilir (bkz. [echoIsle]) ve yayın
     * BİTTİKTEN SONRA, gerçek bir gelen özel çağrı gibi (PTT_ON + kareler +
     * PTT_OFF) geri oynatılır (bkz. [echoOynatBaslat]).
     *
     * PEER'LARA GONDERİLMEZ: bu tamamen YEREL bir davranıştır, kişi hangi
     * reflektöre bağlıysa testi ORADA alır; ağ genelinde köprülemenin hiçbir
     * faydası yoktur ve boşuna bant genişliği harcardı.
     */
    const echoTg = this.db.echoTestTg;
    if (echoTg && header.targetId === echoTg) {
      this.echoIsle(msg, session, header);
      return;
    }

    // Ozel cagri da ag genelindedir: hedef baska bir reflektorde olabilir.
    // Cerceve HER ZAMAN peer'lara gonderilir; her peer hedefi kendinde
    // bulursa teslim eder, bulamazsa sessizce atar. (Kisinin iki cihazi iki
    // ayri reflektorde ise ikisi de calar — istenen davranis budur.)
    if (this.peers) {
      this.peers.yayinla(msg, header);
    }

    // ESSID'li kimliklerde tam eşleşme olmayabilir; temel DMR ID'ye düş.
    const target = this.sessions.byBaseDmrId(header.targetId);
    if (!target || !target.registered || target === session) {
      this.stats.noTarget += 1;
      log.debug(`private call target ${header.targetId} not reachable locally`);
      return;
    }
    this.send(msg, target.udpPort, target.udpAddress, session);
  }

  /* ══ Echo Test — kaydet / oynat ═════════════════════════════════════════
   *
   * TASARIM: bir ses testi "önce konuş, sonra kendini dinle" demektir; PTT
   * basılıyken aynı anda kendi sesini duymak (canlı monitör) hem yanıltıcı
   * hem de kafa karıştırıcıdır. Bu yüzden kareler PTT_ON..PTT_OFF arasında
   * SAKLANIR ve yayın gerçekten BİTTİKTEN SONRA, sıradan bir gelen özel
   * çağrı gibi (PTT_ON + kareler + PTT_OFF) tek seferde geri gönderilir.
   * ══════════════════════════════════════════════════════════════════════ */

  /** Bir kayıtta saklanacak en fazla kare — bellek şişmesin (20ms/kare ≈ 30s). */
  static get ECHO_MAKS_KARE() { return 1500; }
  /** Kare aralığı (ms) — DVPX ses motorunun çerçeve süresiyle aynı olmalı. */
  static get ECHO_KARE_MS() { return 20; }
  /** Yayın BİTTİKTEN (PTT_OFF) sonra oynatımın başlamasına kadar beklenen süre. */
  static get ECHO_GECIKME_MS() { return 2000; }

  /** Echo Test hedefine gelen PTT_ON/VOICE/PTT_OFF akışını kaydeder. */
  echoIsle(msg, session, header) {
    const PT = packet.PACKET_TYPE;

    if (header.packetType === PT.PTT_ON) {
      // Yeni kayit basliyor: onceki BITMEMIS bir oynatim/bekleme varsa
      // durdur — ust uste binen iki oynatim karisik/bozuk ses uretirdi.
      this.echoOynatimiDurdur(session);
      session.echoKayit = [];
      return;
    }

    if (header.packetType === PT.VOICE) {
      // PTT_ON kaybolmus olabilir (UDP); ilk VOICE karesiyle kayda basla —
      // reflektorun kendi TX takibiyle AYNI dayaniklilik ilkesi.
      if (!session.echoKayit) {
        session.echoKayit = [];
      }
      if (session.echoKayit.length < UdpServer.ECHO_MAKS_KARE) {
        session.echoKayit.push(Buffer.from(msg));
      }
      return;
    }

    if (header.packetType === PT.PTT_OFF) {
      const kayit = session.echoKayit;
      session.echoKayit = null;
      if (kayit && kayit.length) {
        // Oynatim ANINDA baslamaz: yayin bittikten [ECHO_GECIKME_MS] sonra
        // baslar — kullanici PTT'yi biraktigi an degil, kisa bir sure
        // sonra kendi sesini duymalidir.
        session.echoGecikmeTimer = setTimeout(() => {
          session.echoGecikmeTimer = null;
          this.echoOynatBaslat(session, kayit);
        }, UdpServer.ECHO_GECIKME_MS);
      }
    }
  }

  /**
   * Biriktirilen kareleri sıradan bir GELEN özel çağrı gibi geri oynatır:
   * PTT_ON, ardından her kareyi [ECHO_KARE_MS] aralıklarla, sonunda PTT_OFF.
   *
   * Kare aralığı KORUNUR: hepsini tek seferde göndermek istemcinin jitter
   * buffer'ını anında taşırır ve sesi hızlandırılmış/bozuk çalardı.
   */
  echoOynatBaslat(session, kareler) {
    if (!session.registered) {
      return;
    }
    const sourceId = session.dmrId;
    const targetId = this.db.echoTestTg;
    let seq = 0;

    const pttOn = packet.build({
      callType: packet.CALL_TYPE.PRIVATE,
      packetType: packet.PACKET_TYPE.PTT_ON,
      sourceId,
      targetId,
      seqNum: seq,
    }, Buffer.alloc(0));
    seq = (seq + 1) & 0xffff;
    this.send(pttOn, session.udpPort, session.udpAddress, null);

    let i = 0;
    session.echoOynatimTimer = setInterval(() => {
      if (!session.registered || i >= kareler.length) {
        this.echoOynatimiDurdur(session);
        if (session.registered) {
          const pttOff = packet.build({
            callType: packet.CALL_TYPE.PRIVATE,
            packetType: packet.PACKET_TYPE.PTT_OFF,
            sourceId,
            targetId,
            seqNum: seq,
          }, Buffer.alloc(0));
          this.send(pttOff, session.udpPort, session.udpAddress, null);
        }
        return;
      }
      const yuk = packet.payloadSlice(kareler[i]);
      const kare = packet.build({
        callType: packet.CALL_TYPE.PRIVATE,
        packetType: packet.PACKET_TYPE.VOICE,
        sourceId,
        targetId,
        seqNum: seq,
      }, yuk);
      seq = (seq + 1) & 0xffff;
      this.send(kare, session.udpPort, session.udpAddress, null);
      i += 1;
    }, UdpServer.ECHO_KARE_MS);
  }

  /**
   * Süren bir oynatımı YA DA oynatım öncesi bekleme sayacını durdurur —
   * yeni kayıt başlaması ya da bağlantı kopması durumunda çağrılır.
   */
  echoOynatimiDurdur(session) {
    if (session.echoGecikmeTimer) {
      clearTimeout(session.echoGecikmeTimer);
      session.echoGecikmeTimer = null;
    }
    if (session.echoOynatimTimer) {
      clearInterval(session.echoOynatimTimer);
      session.echoOynatimTimer = null;
    }
  }

  /* ══ Peer'dan gelen ses ═══════════════════════════════════════════════ */

  /**
   * Baska bir reflektorden gelen, imzasi DOGRULANMIS ses cercevesini YEREL
   * abonelere teslim eder.
   *
   * ### Kurallar (dongu ve gizlilik)
   *  1. **Baska peer'lara ASLA iletilmez.** Tam ag (full mesh) topolojisinde
   *     bile bu tek kural dongunun olusmasini imkansiz kilar.
   *  2. **call_log yazilmaz.** Cagriyi, konusan kisinin BAGLI OLDUGU reflektor
   *     kaydeder; iki kez kaydetmek panelde cift satir olustururdu.
   *  3. **Yerel politika yine uygulanir.** TG kapali/tanimsizsa teslim
   *     edilmez. Ozel TG'lerde dinleyiciler zaten AYNI panelin yetki
   *     listesinden gectikleri icin aboneler guvenlidir.
   *  4. Gonderen icin yerel bir oturum ARANMAZ — kisi bizim degil, karsi
   *     reflektorun kullanicisidir; onu karsi taraf dogruladi.
   *
   * @param {Buffer} inner ham DVPX istemci paketi (bit birebir iletilir)
   * @param {object} header ayrıştırılmış başlık
   * @param {object} peer geldigi peer (log icin)
   */
  deliverFromPeer(inner, header, peer) {
    this.stats.peerIn += 1;

    if (header.callType === packet.CALL_TYPE.PRIVATE) {
      const target = this.sessions.byBaseDmrId(header.targetId);
      if (!target || !target.registered) {
        // Hedef bizde degil: baska bir peer'da olabilir, bu normaldir.
        return;
      }
      this.send(inner, target.udpPort, target.udpAddress, null);
      return;
    }

    // TG: YEREL politika suzgeci. `this.db` Control ornegidir (index.js oyle
    // veriyor); `talkgroups` panelden gelen Map'tir.
    const tg = this.db.talkgroups.get(Number(header.targetId)) || null;
    if (!tg || !tg.isActive) {
      // Bizde tanimsiz ya da kapatilmis bir TG. Iki reflektor ayni panelden
      // beslendigi icin normalde olmaz; olursa politika henuz tazelenmemistir.
      this.stats.peerTgClosed += 1;
      return;
    }
    if (tg.isPrivate && !this.cfg.peers.bridgePrivateTalkgroups) {
      return;
    }

    const subs = this.sessions.subscribersOf(header.targetId);
    if (!subs || !subs.size) {
      this.stats.peerNoSub += 1;
      return;
    }
    for (const s of subs) {
      if (!s.registered) {
        continue;
      }
      this.send(inner, s.udpPort, s.udpAddress, null);
    }
  }

  /** PeerManager'in kullandigi ham UDP gonderimi. */
  sendRaw(buf, port, host) {
    if (!this.socket) {
      return;
    }
    this.socket.send(buf, port, host, (err) => {
      if (err) {
        this.stats.sendErrors += 1;
        log.debug(`peer send to ${host}:${port} failed: ${err.message}`);
      }
    });
  }

  /** TG çağrısı: gönderen o TG'ye abone olmalı; paket diğer abonelere gider. */
  forwardTalkgroup(msg, session, header) {
    if (!session.subscriptions.has(header.targetId)) {
      this.stats.notSubscribed += 1;
      this.stats.dropped += 1;
      log.debug(`${session.label} sent to TG ${header.targetId} without subscription`);
      return;
    }

    /* ── Diger reflektorlere ilet ──────────────────────────────────────────
     * TG'ler ag genelinde ORTAKTIR: baska bir reflektorde ayni TG'de olan
     * kullanicilar da bu sesi duymalidir. Bu cagri, yerel dinleyici SAYISINA
     * BAKMADAN once yapilir — yoksa "bu reflektorde tek basimayim" durumunda
     * ses hic cikmaz ve karsi reflektordeki kisi duymazdi.
     * ──────────────────────────────────────────────────────────────────── */
    if (this.peers) {
      this.peers.yayinla(msg, header);
      this.stats.peerOut += 1;
    }

    const subs = this.sessions.subscribersOf(header.targetId);
    if (!subs || subs.size < 2) {
      // Yerelde gönderenden başka dinleyen yok (hata değil) — peer'lara
      // yukarıda gönderildi.
      return;
    }

    for (const peer of subs) {
      if (peer === session || !peer.registered) {
        continue;
      }
      this.send(msg, peer.udpPort, peer.udpAddress, session);
    }
  }

  /** Tek bir datagram gönderir; gönderim hatası tek hedefi etkiler. */
  send(buf, port, address, fromSession) {
    if (!this.socket || !address || !port) {
      return;
    }
    this.socket.send(buf, port, address, (err) => {
      if (err) {
        this.stats.sendErrors += 1;
        log.debug(`send to ${address}:${port} failed: ${err.message}`);
        return;
      }
      this.stats.forwarded += 1;
      if (fromSession) {
        fromSession.packetsForwarded += 1;
      }
    });
  }

  /**
   * PTT_ON / VOICE / PTT_OFF akışını izleyip call_log kaydı üretir.
   * PTT_ON kaçırılırsa ilk VOICE paketi yayını başlatır (UDP kaybına dayanıklı).
   */
  trackTransmission(session, header) {
    const now = Date.now();

    if (header.packetType === packet.PACKET_TYPE.PTT_ON) {
      this.startTransmission(session, header, now);
      return;
    }

    if (header.packetType === packet.PACKET_TYPE.VOICE) {
      if (!session.txActive || session.txTargetId !== header.targetId) {
        this.startTransmission(session, header, now);
      }
      session.txFrames += 1;
      return;
    }

    if (header.packetType === packet.PACKET_TYPE.PTT_OFF) {
      this.finishTransmission(session, now);
    }
  }

  startTransmission(session, header, now) {
    // Önceki yayın PTT_OFF olmadan bittiyse (paket kaybı) onu kapat.
    if (session.txActive) {
      this.finishTransmission(session, now);
    }
    session.txActive = true;
    session.txTargetId = header.targetId;
    session.txCallType = header.callType;
    session.txFrames = 0;
    session.txStartedAt = now;

    // Çağrı kaydını HEMEN aç: dinleyiciler konuşmayı bittiğinde değil,
    // BAŞLADIĞINDA görsün. Dönen tekil kimlik saklanır; bitişte aynı kayıt
    // güncellenir. await EDİLMEZ — ses yolu hiçbir koşulda bekletilmez.
    //
    // `serverId` GÖNDERİLMEZ: hangi reflektöre ait olduğunu panel token'dan
    // kendisi çözer. Reflektörün kendi kimliğini beyan etmesi, başka bir
    // reflektörün kayıtlarına yazmasına imkân verirdi.
    session.txLogPromise = this.db.beginCall({
      sourceId: session.dmrId,
      callsign: session.callsign,
      targetId: header.targetId,
      callType: header.callType,
      startedAt: UdpServer.mysqlDateTime(now),
    });

    log.info(
      `TX start: ${session.label} → `
      + (header.callType === packet.CALL_TYPE.PRIVATE ? `private ${header.targetId}` : `TG ${header.targetId}`)
    );
  }

  /** Yayını kapatır ve çağrı kaydını kuyruğa alır. */
  finishTransmission(session, now) {
    if (!session.txActive) {
      return;
    }
    const durationMs = Math.max(0, (now || Date.now()) - session.txStartedAt);
    const frames = session.txFrames;

    session.txActive = false;

    log.info(
      `TX end:   ${session.label} → `
      + (session.txCallType === packet.CALL_TYPE.PRIVATE ? `private ${session.txTargetId}` : `TG ${session.txTargetId}`)
      + ` (${frames} frames, ${(durationMs / 1000).toFixed(1)}s)`
    );

    // Başlangıçta açılan satırı kapat. Söz henüz çözülmemiş olabilir (çok kısa
    // yayın), bu yüzden önce bekleniyor. Tek çerçevelik gürültüler kayda
    // geçmesin diye satır silinir.
    const soz = session.txLogPromise;
    session.txLogPromise = null;
    if (soz) {
      soz.then((id) => (frames < 2 ? this.db.dropCall(id) : this.db.endCall(id, frames, durationMs)))
        .catch((err) => log.warn(`call_log finalize error: ${err.message}`));
    }
  }

  /** IPv6 eşlemeli IPv4 adresini normalize eder (::ffff:1.2.3.4 → 1.2.3.4). */
  static normalizeIp(ip) {
    const s = String(ip || '');
    return s.startsWith('::ffff:') ? s.slice(7) : s;
  }

  /**
   * MySQL DATETIME biçimi — **UTC**.
   *
   * Eskiden yerel saat yazılıyordu ("panelle tutarlı" varsayımıyla), ama bu
   * yanlıştı ve iki soruna yol açıyordu:
   *
   *   1. Panel ile reflektör AYNI saat diliminde değil. Paylaşımlı hostingdeki
   *      MySQL `NOW()` UTC ürettiği için `users.last_login` UTC, reflektörün
   *      yazdığı `call_log.started_at` ise UTC+3 oluyordu — tek veritabanında
   *      iki farklı dilim. Panelin "x önce" göstergesi de bu yüzden yanlıştı.
   *   2. `servers` tablosu birden çok reflektörü destekler; farklı ülkelerdeki
   *      reflektörler yerel saat yazsaydı çağrı geçmişi sıralanamazdı.
   *
   * UTC yazmak her iki sorunu da kökten çözer ve api.php'nin `started_at`
   * alanını ISO-8601 UTC olarak sunmasını doğru kılar.
   */
  static mysqlDateTime(ms) {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} `
      + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }

  async close() {
    if (!this.socket) {
      return;
    }
    await new Promise((resolve) => {
      try {
        this.socket.close(() => resolve());
      } catch (err) {
        resolve();
      }
      setTimeout(resolve, 1000);
    });
    this.socket = null;
    log.info('voice socket closed');
  }
}

module.exports = { UdpServer };
