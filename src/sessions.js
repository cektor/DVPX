'use strict';

/**
 * DVPX Reflector — oturum deposu / session store
 *
 * Sıcak yol (UDP ses yönlendirme) yalnızca Map aramaları yapar; hiçbir I/O
 * içermez. Bu yüzden bütün eşlemeler burada bellekte tutulur:
 *
 *   sessionsBySocket : net.Socket        -> Session      (TCP tarafı)
 *   sessionsByDmrId  : dmrId             -> Session      (özel çağrı hedefi)
 *   sessionsByToken  : token             -> Session      (UDP REGISTER)
 *   subscribers      : tgNumber          -> Set<Session> (TG yayını)
 */

const crypto = require('crypto');

class Session {
  constructor(socket, remoteAddress) {
    this.socket = socket;
    this.remoteAddress = remoteAddress;

    /** Kimlik / identity */
    this.userId = 0;
    this.dmrId = 0;
    /** Süren yayının call_log satır id'si (Promise) — bkz. UdpServer. */
    this.txLogPromise = null;
    this.callsign = '';
    this.token = '';
    this.loggedIn = false;

    /** UDP eşlemesi / UDP endpoint (REGISTER ile dolar) */
    this.udpAddress = null;
    this.udpPort = 0;
    this.registered = false;

    /** Abonelikler / subscriptions */
    this.subscriptions = new Set();

    /* ── Full-duplex özel çağrı durumu ──────────────────────────────────
     * fdxPeer: karşı tarafın DMR ID'si (0 = çağrı yok)
     * fdxState: 'idle' | 'inviting' (biz aradık) | 'ringing' (bize geldi)
     *           | 'active' (kabul edildi, iki yön de akıyor)
     *
     * Reflektör sesi yine yön gözetmeden aktarır; bu durum YALNIZCA davet /
     * kabul / ret / bitirme satırlarını doğru tarafa iletmek ve "meşgul"
     * yanıtı verebilmek için tutulur.
     * ─────────────────────────────────────────────────────────────────── */
    this.fdxPeer = 0;
    this.fdxState = 'idle';
    this.fdxSince = 0;

    /* Karşı taraf BAŞKA BİR REFLEKTÖRDE mi?
     *
     * Ses zaten ağ genelinde akıyor (bkz. udp-server.forwardPrivate → peers);
     * çağrı KURMA satırlarının da peer bağı üzerinden gitmesi gerekir. Bu
     * bayrak açıkken davet/kabul/ret/bitirme satırları yerel bir sokete değil
     * peer'lara yazılır. */
    this.fdxRemote = false;
    /** Uzak davete yanıt bekleme zamanlayıcısı (yalnızca arayan tarafta). */
    this.fdxRemoteTimer = null;

    /** Zaman damgaları (ms) */
    this.createdAt = Date.now();
    this.lastTcpActivity = Date.now();
    this.lastUdpActivity = 0;

    /** Sel önleme sayaçları / flood control */
    this.windowStart = Date.now();
    this.windowCount = 0;

    /** Yayın (TX) izleme — call_log için */
    this.txActive = false;
    this.txTargetId = 0;
    this.txCallType = 0;
    this.txFrames = 0;
    this.txStartedAt = 0;

    /** İstatistik / stats */
    this.packetsIn = 0;
    this.packetsForwarded = 0;

    /** TCP katmanının kullandığı alanlar (tcp-server.js doldurur) */
    this.buffer = '';
    this.loginAttempts = 0;
    this.handshaken = false;
    this.loginTimer = null;
    this.closed = false;
  }

  get label() {
    return this.callsign ? `${this.callsign}/${this.dmrId}` : `${this.dmrId || '?'}`;
  }

  touchTcp() {
    this.lastTcpActivity = Date.now();
  }

  touchUdp() {
    this.lastUdpActivity = Date.now();
  }

  /**
   * Saniye başına paket sınırı. Pencere dolduysa false döner (paket düşürülür).
   */
  allowPacket(limitPerSecond) {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= limitPerSecond;
  }

  /** Gelen paketin kayıtlı UDP kaynağıyla eşleşip eşleşmediği (spoof koruması). */
  matchesEndpoint(address, port) {
    return this.registered && this.udpAddress === address && this.udpPort === port;
  }
}

class SessionStore {
  constructor(limits) {
    this.limits = limits;
    this.sessionsBySocket = new Map();
    this.sessionsByDmrId = new Map();
    this.sessionsByToken = new Map();
    this.subscribers = new Map();
  }

  get size() {
    return this.sessionsBySocket.size;
  }

  /** Yeni (henüz login olmamış) oturum oluşturur. */
  create(socket, remoteAddress) {
    const session = new Session(socket, remoteAddress);
    this.sessionsBySocket.set(socket, session);
    return session;
  }

  bySocket(socket) {
    return this.sessionsBySocket.get(socket) || null;
  }

  /**
   * Panele yayımlanacak "çevrimiçi" oturum özeti.
   *
   * Yalnızca giriş yapmış oturumlar döner. `dmrId` TAM kimliktir (ESSID'li) —
   * özel çağrının hedefi budur; `baseId` görüntüleme/gruplama içindir.
   * Abone olunan TG'lerden ilki bilgi amaçlı taşınır.
   */
  onlineSummary() {
    const out = [];
    for (const session of this.sessionsByDmrId.values()) {
      if (!session.loggedIn || !session.dmrId) {
        continue;
      }
      const tg = session.subscriptions.values().next();
      out.push({
        dmrId: session.dmrId,
        baseId: session.dmrId > 9999999 ? Math.floor(session.dmrId / 100) : session.dmrId,
        callsign: session.callsign || '',
        talkgroup: tg.done ? 0 : Number(tg.value) || 0,
      });
    }
    return out;
  }

  byDmrId(dmrId) {
    return this.sessionsByDmrId.get(Number(dmrId)) || null;
  }

  /**
   * ESSID'yi yok sayarak oturum arar: 2860722 çağrısı 286072218'i bulur.
   *
   * İstemciler kimlik olarak `dmrId * 100 + essid` gönderir (DroidStar/DMR
   * standardı); böylece aynı kişinin telefonu ile telsizi AYNI ANDA bağlı
   * kalabilir. Ancak özel çağrıda arayan taraf genelde ekranda gördüğü TEMEL
   * kimliği (7 hane) çevirir. Tam eşleşme yoksa burada temel kimliğe düşülür.
   *
   * Aynı kişinin birden çok cihazı bağlıysa KAYITLI olan ilki seçilir — çağrı
   * en azından bir cihaza ulaşır, sessizce düşmez.
   */
  byBaseDmrId(dmrId) {
    const hedef = Number(dmrId);
    if (!Number.isFinite(hedef) || hedef < 1) {
      return null;
    }
    const tam = this.sessionsByDmrId.get(hedef);
    if (tam) {
      return tam;
    }
    /* ESSID'Lİ HEDEF DE TABANA DÜŞER.
     *
     * Eskiden 7 haneden uzun kimliklerde arama burada biterdi. Ama çevrimiçi
     * listesi 90 sn'lik bir pencereyle çalışır: kişi -18 ile ayrılıp -01 ile
     * geri bağlandığında arayan hâlâ eski ESSID'yi hedefler ve çağrı, kişi
     * BAĞLI OLDUĞU HÂLDE düşerdi. Taban kimlik KİŞİYİ tanımlar, ESSID yalnızca
     * cihazı; doğru cihaz yoksa kişinin bağlı olan öteki cihazına gitmek,
     * çağrıyı hiç ulaştırmamaktan iyidir. */
    const taban = hedef > 9999999 ? Math.floor(hedef / 100) : hedef;
    let yedek = null;
    for (const oturum of this.sessionsByDmrId.values()) {
      const oturumTaban = oturum.dmrId > 9999999
        ? Math.floor(oturum.dmrId / 100)
        : oturum.dmrId;
      if (oturumTaban !== taban) {
        continue;
      }
      if (oturum.registered) {
        return oturum;
      }
      yedek = yedek || oturum;
    }
    return yedek;
  }

  byToken(token) {
    return this.sessionsByToken.get(String(token)) || null;
  }

  /**
   * Oturumu kimliğe bağlar. Aynı DMR ID ile açık bir oturum varsa onu döndürür
   * (çağıran taraf eski oturumu düşürür — DMR'daki "tek cihaz" davranışı).
   */
  attachIdentity(session, user) {
    const previous = this.sessionsByDmrId.get(user.dmrId) || null;

    session.userId = user.id;
    session.dmrId = user.dmrId;
    session.callsign = user.callsign;
    session.loggedIn = true;
    session.token = crypto.randomBytes(16).toString('hex'); // 32 hex karakter

    this.sessionsByDmrId.set(user.dmrId, session);
    this.sessionsByToken.set(session.token, session);

    return previous && previous !== session ? previous : null;
  }

  /** UDP endpoint'ini oturuma bağlar. */
  registerEndpoint(session, address, port) {
    session.udpAddress = address;
    session.udpPort = port;
    session.registered = true;
    session.touchUdp();
  }

  /**
   * TG aboneliği ekler.
   * @returns {{ok:boolean, reason?:string}}
   */
  subscribe(session, tgNumber) {
    const tg = Number(tgNumber);
    if (session.subscriptions.has(tg)) {
      return { ok: true };
    }
    if (session.subscriptions.size >= this.limits.maxSubscriptionsPerUser) {
      return { ok: false, reason: 'TOO_MANY' };
    }
    session.subscriptions.add(tg);
    let set = this.subscribers.get(tg);
    if (!set) {
      set = new Set();
      this.subscribers.set(tg, set);
    }
    set.add(session);
    return { ok: true };
  }

  unsubscribe(session, tgNumber) {
    const tg = Number(tgNumber);
    session.subscriptions.delete(tg);
    const set = this.subscribers.get(tg);
    if (set) {
      set.delete(session);
      if (!set.size) {
        this.subscribers.delete(tg);
      }
    }
  }

  /** Bir TG'nin abone kümesi (yoksa boş küme). */
  subscribersOf(tgNumber) {
    return this.subscribers.get(Number(tgNumber)) || null;
  }

  /** Oturumu tüm indekslerden siler. */
  remove(session) {
    if (!session) {
      return;
    }
    this.sessionsBySocket.delete(session.socket);

    if (session.token) {
      this.sessionsByToken.delete(session.token);
    }
    // Aynı DMR ID başka bir oturuma geçmişse onu silmemeye dikkat et.
    if (session.dmrId && this.sessionsByDmrId.get(session.dmrId) === session) {
      this.sessionsByDmrId.delete(session.dmrId);
    }
    for (const tg of Array.from(session.subscriptions)) {
      this.unsubscribe(session, tg);
    }
    session.loggedIn = false;
    session.registered = false;
    // Full-duplex çağrı durumu burada SIFIRLANMAZ: karşı tarafa "çağrı bitti"
    // satırını gönderebilmek için çağıran taraf (tcp-server.fdxTemizle) önce
    // peer'ı okur, sonra temizler.
  }

  /**
   * Zaman aşımına düşen oturumları döndürür (çağıran taraf kapatır).
   * TCP sessizliği sessionTimeoutSec'i geçerse oturum ölü sayılır.
   */
  findExpired(nowMs) {
    const ttl = this.limits.sessionTimeoutSec * 1000;
    const expired = [];
    for (const session of this.sessionsBySocket.values()) {
      const idle = nowMs - Math.max(session.lastTcpActivity, session.lastUdpActivity);
      if (idle > ttl) {
        expired.push(session);
      }
    }
    return expired;
  }

  /** Tüm oturumları döndürür (kapatma/istatistik için). */
  all() {
    return Array.from(this.sessionsBySocket.values());
  }

  stats() {
    let registered = 0;
    let loggedIn = 0;
    for (const s of this.sessionsBySocket.values()) {
      if (s.loggedIn) loggedIn += 1;
      if (s.registered) registered += 1;
    }
    return {
      sessions: this.sessionsBySocket.size,
      loggedIn,
      registered,
      talkgroups: this.subscribers.size,
    };
  }
}

module.exports = { Session, SessionStore };
