'use strict';

/**
 * DVPX Reflector — reflektörler arası bağ / inter-reflector peer links
 *
 * AMAÇ: Aynı TG'de olan iki kullanıcı FARKLI reflektörlerde olsa bile
 * birbirini duyabilsin. Yani TG'ler tüm ağda ortaktır; reflektör seçimi
 * yalnızca "hangi sunucuya bağlanıyorum" sorusudur, kiminle konuşacağımı
 * belirlemez.
 *
 * ── Neden ayrı bir port YOK ────────────────────────────────────────────────
 * Peer çerçeveleri istemci sesiyle AYNI UDP portunu paylaşır. Ayırt edici,
 * başlıktaki sihirli baytlardır: istemci paketleri 'D','V' ile, peer
 * çerçeveleri 'D','X' ile başlar. Böylece:
 *   • Reflektör işletmecisinin yeni bir portu güvenlik duvarında açması
 *     GEREKMEZ — zaten açık olan ses portu yeterlidir.
 *   • İstemci paket ayrıştırma yolu hiç değişmez (bkz. udp-server.onMessage).
 *
 * ── Kimlik doğrulama ──────────────────────────────────────────────────────
 * Her peer çifti için PAYLAŞILAN BİR ANAHTAR vardır ve her çerçeve
 * HMAC-SHA256 ile imzalanır. İmza olmadan hiçbir çerçeve kabul edilmez:
 * aksi hâlde portu bilen herkes istediği TG'ye ses enjekte edebilirdi.
 * Anahtarlar paneldeki iki reflektörün token özetlerinden TÜRETİLİR ve
 * reflektörlere politika içinde iner; işletmeciler elle anahtar alışverişi
 * yapmaz, veritabanına da erişmez.
 *
 * ── Döngü önleme ──────────────────────────────────────────────────────────
 * Kural tektir ve tam ağ (full mesh) topolojisinde bile döngüyü imkânsız
 * kılar: **peer'dan gelen ses YALNIZCA yerel abonelere verilir, başka
 * peer'lara ASLA iletilmez.** Ek emniyet olarak her çerçeve kaynak
 * reflektörün kimliğini taşır; kendi kimliğimizi görürsek çerçeveyi atarız
 * (yanlış yapılandırmaya karşı).
 *
 * ── Tekrar (replay) koruması ──────────────────────────────────────────────
 * Çerçeveler zaman damgası taşır; [PENCERE_MS] dışındaki damgalar reddedilir.
 * Sunucularda NTP açık olduğu varsayılır (varsayılan pencere ±30 sn, saat
 * kaymasına toleranslı).
 *
 * Bu modül Opus yükünü ASLA açmaz; içteki DVPX paketi bit birebir taşınır.
 */

const crypto = require('crypto');

const { createLogger } = require('./logger');
const packet = require('./packet');

const log = createLogger('peer');

/** Peer çerçevesi sihirli baytları — istemcinin 'D','V' ile karışmaz. */
const MAGIC_0 = 0x44; // 'D'
const MAGIC_1 = 0x58; // 'X'

const VERSION = 1;

/** Çerçeve türleri. */
const FRAME = {
  VOICE: 0,   // içinde tam bir DVPX istemci paketi taşır
  PING: 1,    // bağ sağlığı — yük yok
  PONG: 2,    // PING yanıtı — yük yok
  /* CTRL: sinyalleşme satırı (UTF-8 metin, tek satır).
   *
   * Şu an yalnızca full-duplex çağrı (FDX) kurulumu kullanır. Ses zaten ağ
   * genelinde akıyordu, ama ÇAĞRI KURMA satırları TCP'de yereldi: karşı taraf
   * başka bir reflektördeyse davet "NO_TARGET" ile düşüyordu. Bu çerçeve o
   * satırları peer bağı üzerinden taşır.
   *
   * ESKİ REFLEKTÖRLER bu türü tanımaz, 'bilinmeyen peer cerceve turu' deyip
   * atar — ses ve TG köprüsü etkilenmez, yalnızca uzak FDX kurulmaz. */
  CTRL: 3,
};

/** CTRL yükü üst sınırı — bir sinyalleşme satırı için fazlasıyla yeterli. */
const CTRL_MAX_BYTES = 512;

/**
 * Başlık düzeni (32 bayt, big-endian):
 *   0   2  magic 'D','X'
 *   2   1  version
 *   3   1  frameType
 *   4   4  originId   — çerçeveyi ÜRETEN reflektörün panel kimliği
 *   8   8  timestampMs
 *  16  16  hmac       — HMAC-SHA256(anahtar, başlık[0..15] + iç paket)[0..15]
 *  32  ..  iç paket
 */
const HEADER_LEN = 32;
const HMAC_OFFSET = 16;
const HMAC_LEN = 16;

/** Zaman damgası penceresi (ms). Dışındaki çerçeveler reddedilir. */
const PENCERE_MS = 30000;

/** Bağ "canlı" sayılma süresi: bu süre içinde çerçeve geldiyse bağ ayakta. */
const CANLI_MS = 35000;

/** PING gönderme aralığı (ms). */
const PING_ARALIK_MS = 10000;

/** Anahtar biçimi: 64 onaltılık karakter (32 bayt). */
function anahtarCoz(hex) {
  const s = String(hex || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(s)) {
    return null;
  }
  return Buffer.from(s, 'hex');
}

class Peer {
  constructor({ id, name, host, udpPort, key }) {
    this.id = Number(id);
    this.name = String(name || `#${id}`);
    this.host = String(host);
    this.udpPort = Number(udpPort);
    this.key = key;                  // Buffer(32)

    /** Bağ sağlığı. */
    this.lastRxAt = 0;
    this.lastTxAt = 0;
    this.canli = false;

    /** Sel önleme: peer başına saniyelik pencere. */
    this.windowStart = Date.now();
    this.windowCount = 0;

    /** İstatistik. */
    this.rxVoice = 0;
    this.txVoice = 0;
    this.rxBad = 0;
  }

  get label() {
    return `${this.name}#${this.id} (${this.host}:${this.udpPort})`;
  }

  allowPacket(limitPerSecond) {
    const now = Date.now();
    if (now - this.windowStart >= 1000) {
      this.windowStart = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    return this.windowCount <= limitPerSecond;
  }
}

class PeerManager {
  /**
   * @param {object} cfg
   * @param {object} kancalar
   * @param {(buf:Buffer, port:number, host:string)=>void} kancalar.gonder
   *        UDP gönderimi (UdpServer'ın soketi kullanılır).
   * @param {(inner:Buffer, header:object, peer:Peer)=>void} kancalar.sesGeldi
   *        Doğrulanmış bir peer ses çerçevesi geldiğinde çağrılır.
   * @param {(satir:string, peer:Peer)=>void} [kancalar.ctrlGeldi]
   *        Doğrulanmış bir sinyalleşme (CTRL) satırı geldiğinde çağrılır.
   */
  constructor(cfg, kancalar) {
    this.cfg = cfg;
    this.gonder = kancalar.gonder;
    this.sesGeldi = kancalar.sesGeldi;
    this.ctrlGeldi = kancalar.ctrlGeldi || null;

    /** id -> Peer */
    this.peers = new Map();

    /** Kendi panel kimliğimiz; peering için ZORUNLU (çerçevelere yazılır). */
    this.selfId = 0;

    this.pingTimer = null;

    this.stats = {
      txFrames: 0,
      rxFrames: 0,
      rxVoice: 0,
      rxCtrl: 0,
      txCtrl: 0,
      rxBadMagic: 0,
      rxBadHmac: 0,
      rxStale: 0,
      rxUnknownPeer: 0,
      rxSelfLoop: 0,
      rxFlood: 0,
      rxMalformedInner: 0,
      sendErrors: 0,
    };
  }

  get etkin() {
    return this.cfg.peers.enabled && this.selfId > 0 && this.peers.size > 0;
  }

  /** Kendi panel kimliğimizi bildirir (control.serverId). */
  setSelfId(id) {
    const n = Number(id) || 0;
    if (n === this.selfId) {
      return;
    }
    this.selfId = n;
    if (!n) {
      log.warn('panel sunucu kimligi yok — reflektorler arasi bag DEVRE DISI');
    }
  }

  /**
   * Peer listesini günceller (panel politikası ve/veya config.json'daki
   * statik liste). Fark varsa loglar; anahtarlar ASLA loglanmaz.
   *
   * @param {Array<object>} liste [{id,name,host,udpPort,key}]
   */
  setPeers(liste) {
    const yeni = new Map();
    let atlanan = 0;

    for (const ham of Array.isArray(liste) ? liste : []) {
      const id = Number(ham && ham.id);
      const host = String((ham && ham.host) || '').trim();
      const udpPort = Number(ham && ham.udpPort);
      const key = anahtarCoz(ham && ham.key);

      if (!Number.isFinite(id) || id < 1 || !host || !Number.isFinite(udpPort)
          || udpPort < 1 || udpPort > 65535 || !key) {
        atlanan += 1;
        continue;
      }
      if (this.selfId && id === this.selfId) {
        continue;   // kendimizle eşleşmeyiz
      }
      // Var olan peer'ı KORU: bağ sağlığı ve sayaçlar sıfırlanmasın.
      const eski = this.peers.get(id);
      if (eski && eski.host === host && eski.udpPort === udpPort && eski.key.equals(key)) {
        eski.name = String((ham && ham.name) || eski.name);
        yeni.set(id, eski);
        continue;
      }
      yeni.set(id, new Peer({ id, name: ham.name, host, udpPort, key }));
    }

    // Fark raporu (operatör bağın kurulduğunu görsün).
    for (const [id, p] of yeni) {
      if (!this.peers.has(id)) {
        log.info(`bag eklendi: ${p.label}`);
      }
    }
    for (const [id, p] of this.peers) {
      if (!yeni.has(id)) {
        log.info(`bag kaldirildi: ${p.label}`);
      }
    }
    if (atlanan) {
      log.warn(`${atlanan} peer kaydi gecersiz (id/host/port/anahtar) — atlandi`);
    }

    this.peers = yeni;

    if (this.cfg.peers.enabled && !this.peers.size) {
      log.info('peer listesi bos — su an baska reflektore baglanmiyoruz');
    }
  }

  /** PING zamanlayıcısını başlatır (bağ sağlığı göstergesi). */
  start() {
    if (this.pingTimer) {
      return;
    }
    this.pingTimer = setInterval(() => {
      try {
        this.tick();
      } catch (err) {
        log.warn(`ping tick hatasi: ${err.message}`);
      }
    }, PING_ARALIK_MS);
    this.pingTimer.unref?.();
  }

  stop() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  tick() {
    if (!this.etkin) {
      return;
    }
    const now = Date.now();
    for (const peer of this.peers.values()) {
      // Bağ durumu değişimini bir kez logla — operatör için en önemli satır.
      const canli = (now - peer.lastRxAt) < CANLI_MS;
      if (canli !== peer.canli) {
        peer.canli = canli;
        if (canli) {
          log.info(`bag AYAKTA: ${peer.label}`);
        } else {
          log.warn(`bag DUSTU: ${peer.label} — karsi taraf yanit vermiyor `
            + '(guvenlik duvarinda UDP portu acik mi? panelde onayli mi?)');
        }
      }
      this.frameGonder(peer, FRAME.PING, null);
    }
  }

  /* ══ Gönderim ══════════════════════════════════════════════════════════ */

  /**
   * Yerel bir istemciden gelen ses paketini TÜM peer'lara iletir.
   *
   * ÇAĞRI KURALI: yalnızca YEREL istemciden gelen paketler için çağrılır.
   * Peer'dan gelen çerçeveler asla buraya girmez (döngü önleme).
   *
   * @param {Buffer} istemciPaketi ham DVPX paketi (16 baytlık başlık + yük)
   * @param {object} header ayrıştırılmış başlık
   */
  yayinla(istemciPaketi, header) {
    if (!this.etkin) {
      return;
    }
    // TG süzgeci: panel "tümü" derse hepsi, aksi halde listedekiler.
    if (header.callType === packet.CALL_TYPE.TALKGROUP && !this.tgKopruluMu(header.targetId)) {
      return;
    }
    if (header.callType === packet.CALL_TYPE.PRIVATE && !this.cfg.peers.bridgePrivateCalls) {
      return;
    }
    for (const peer of this.peers.values()) {
      this.frameGonder(peer, FRAME.VOICE, istemciPaketi);
      peer.txVoice += 1;
    }
  }

  /**
   * Bir sinyalleşme satırını TÜM peer'lara iletir (FDX çağrı kurulumu).
   *
   * Hedefin hangi reflektörde olduğunu bilmiyoruz — soran taraf biziz. Satırı
   * herkese veriyoruz; hedefi kendinde bulan yanıt verir, bulamayan sessizce
   * atar. Aynı kural ses için de geçerli (bkz. [yayinla]).
   *
   * @returns {boolean} en az bir peer'a gönderildi mi
   */
  ctrlYayinla(satir) {
    if (!this.etkin) {
      return false;
    }
    const govde = Buffer.from(String(satir), 'utf8');
    if (!govde.length || govde.length > CTRL_MAX_BYTES) {
      log.warn(`gecersiz CTRL satiri (${govde.length} bayt) — gonderilmedi`);
      return false;
    }
    for (const peer of this.peers.values()) {
      this.frameGonder(peer, FRAME.CTRL, govde);
    }
    this.stats.txCtrl += 1;
    return true;
  }

  /** Bu TG peer'lara köprüleniyor mu? */
  tgKopruluMu(tgNumber) {
    const s = this.cfg.peers.bridgeTalkgroups;
    if (s === 'all' || s === true) {
      return true;
    }
    if (Array.isArray(s)) {
      return s.includes(Number(tgNumber));
    }
    return false;
  }

  frameGonder(peer, frameType, inner) {
    const govde = inner || Buffer.alloc(0);
    const frame = Buffer.allocUnsafe(HEADER_LEN + govde.length);

    frame[0] = MAGIC_0;
    frame[1] = MAGIC_1;
    frame[2] = VERSION;
    frame[3] = frameType;
    frame.writeUInt32BE(this.selfId, 4);
    // 8 baytlık zaman damgası: JS güvenli tamsayı sınırında kalır (yıl 285k).
    frame.writeUInt32BE(0, 8);
    frame.writeUInt32BE(0, 12);
    frame.writeUIntBE(Date.now(), 10, 6);      // 8..9 sıfır, 10..15 = ms
    frame.fill(0, HMAC_OFFSET, HMAC_OFFSET + HMAC_LEN);
    if (govde.length) {
      govde.copy(frame, HEADER_LEN);
    }

    const imza = PeerManager.imzala(peer.key, frame, govde);
    imza.copy(frame, HMAC_OFFSET, 0, HMAC_LEN);

    try {
      this.gonder(frame, peer.udpPort, peer.host);
      this.stats.txFrames += 1;
      peer.lastTxAt = Date.now();
    } catch (err) {
      this.stats.sendErrors += 1;
      log.debug(`peer gonderim hatasi (${peer.label}): ${err.message}`);
    }
  }

  /** HMAC-SHA256(anahtar, başlığın imza öncesi kısmı + iç paket). */
  static imzala(key, frame, inner) {
    const h = crypto.createHmac('sha256', key);
    h.update(frame.subarray(0, HMAC_OFFSET));
    if (inner && inner.length) {
      h.update(inner);
    }
    return h.digest();
  }

  /* ══ Alım ══════════════════════════════════════════════════════════════ */

  /** Gelen datagram bir peer çerçevesi mi? (udp-server bunu ilk sorar) */
  static peerFrameMi(buf) {
    return Buffer.isBuffer(buf) && buf.length >= HEADER_LEN
      && buf[0] === MAGIC_0 && buf[1] === MAGIC_1;
  }

  /**
   * Peer çerçevesini doğrular ve işler.
   *
   * Doğrulama sırası bilinçlidir: pahalı işlem (HMAC) en sona bırakılır ki
   * çöp trafiği CPU yakmasın.
   */
  handleFrame(buf, rinfo) {
    this.stats.rxFrames += 1;

    if (buf[2] !== VERSION) {
      this.stats.rxBadMagic += 1;
      log.debug(`bilinmeyen peer surumu ${buf[2]} (${rinfo.address})`);
      return;
    }

    const frameType = buf[3];
    const originId = buf.readUInt32BE(4);

    if (this.selfId && originId === this.selfId) {
      // Kendi çerçevemiz geri geldi: yanlış yapılandırma (kendini peer yapmış
      // ya da yansıtan bir ağ). Sessizce at — döngü oluşmasın.
      this.stats.rxSelfLoop += 1;
      return;
    }

    const peer = this.peers.get(originId);
    if (!peer) {
      this.stats.rxUnknownPeer += 1;
      log.debug(`tanimsiz peer ${originId} (${rinfo.address}:${rinfo.port})`);
      return;
    }

    if (!peer.allowPacket(this.cfg.peers.packetsPerSecond)) {
      this.stats.rxFlood += 1;
      return;
    }

    const damga = buf.readUIntBE(10, 6);
    const fark = Math.abs(Date.now() - damga);
    if (!(damga > 0) || fark > PENCERE_MS) {
      this.stats.rxStale += 1;
      log.debug(`bayat/ileri tarihli peer cercevesi ${peer.label} (${fark} ms)`);
      return;
    }

    const inner = buf.length > HEADER_LEN ? buf.subarray(HEADER_LEN) : Buffer.alloc(0);
    const beklenen = PeerManager.imzala(peer.key, buf, inner);
    const gelen = buf.subarray(HMAC_OFFSET, HMAC_OFFSET + HMAC_LEN);
    if (!crypto.timingSafeEqual(gelen, beklenen.subarray(0, HMAC_LEN))) {
      this.stats.rxBadHmac += 1;
      peer.rxBad += 1;
      log.warn(`peer imzasi GECERSIZ: ${peer.label} — iki tarafta ayni panel mi? `
        + 'token yenilendiyse politika tazelenmesini bekleyin');
      return;
    }

    peer.lastRxAt = Date.now();

    switch (frameType) {
      case FRAME.PING:
        this.frameGonder(peer, FRAME.PONG, null);
        return;
      case FRAME.PONG:
        return;
      case FRAME.VOICE:
        break;
      case FRAME.CTRL: {
        // Sinyalleşme satırı: ses paketi DEĞİLDİR, packet.parse'a girmez.
        if (!this.ctrlGeldi || !inner.length || inner.length > CTRL_MAX_BYTES) {
          return;
        }
        this.stats.rxCtrl += 1;
        this.ctrlGeldi(inner.toString('utf8'), peer);
        return;
      }
      default:
        log.debug(`bilinmeyen peer cerceve turu ${frameType} (${peer.label})`);
        return;
    }

    // İç paket gerçekten geçerli bir DVPX istemci paketi mi?
    const parsed = packet.parse(inner, this.cfg.limits.maxPayloadBytes);
    if (!parsed.ok) {
      this.stats.rxMalformedInner += 1;
      log.debug(`peer ic paketi bozuk (${peer.label}): ${parsed.reason}`);
      return;
    }

    this.stats.rxVoice += 1;
    peer.rxVoice += 1;
    this.sesGeldi(inner, parsed.header, peer);
  }

  /** Operatör logu için tek satırlık bağ özeti. */
  ozet() {
    if (!this.cfg.peers.enabled) {
      return 'peers disabled';
    }
    if (!this.selfId) {
      return 'peers: panel kimligi yok';
    }
    if (!this.peers.size) {
      return 'peers: 0';
    }
    const parcalar = [];
    for (const p of this.peers.values()) {
      parcalar.push(`${p.name}#${p.id}${p.canli ? '' : '(DOWN)'} rx${p.rxVoice}/tx${p.txVoice}`);
    }
    return `peers ${this.peers.size}: ${parcalar.join(', ')}`;
  }
}

module.exports = { PeerManager, Peer, FRAME, HEADER_LEN, MAGIC_0, MAGIC_1 };
