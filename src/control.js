'use strict';

/**
 * DVPX Reflector — kontrol katmanı / control-plane client
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │ BU REFLEKTÖR VERİTABANINA BAĞLANMAZ.                                     │
 * │ Yönetimin tamamı (kullanıcılar, engelleme, TG oluşturma, özel TG          │
 * │ yetkileri) DVPX panelinde yapılır. Reflektör yalnızca ses taşır ve        │
 * │ panelle tek bir HTTPS ucu üzerinden konuşur.                             │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * ÇALIŞMA İLKESİ — "politika aşağı iner, telemetri yukarı çıkar":
 *
 *   1. Panel bu reflektöre periyodik olarak bir POLİTİKA ÖZETİ verir:
 *      TG listesi, engelli DMR ID'leri, özel TG yetkileri.
 *   2. Giriş (LOGIN) ve abonelik (SUBSCRIBE) kararları bu YEREL kopyadan
 *      verilir. Sıcak yolda tek bir HTTP isteği bile yoktur; giriş gecikmesi
 *      sıfırdır.
 *   3. Olan biten (çevrimiçi liste, girişler, çağrı kayıtları) tek bir
 *      periyodik POST ile panele bildirilir.
 *
 * DAYANIKLILIK — sırayla ne olur:
 *   • Panel çökerse / internet giderse: reflektör elindeki politikayla
 *     ÇALIŞMAYA DEVAM EDER. Ses akar, girişler kabul edilir. Yalnızca yeni
 *     engeller ve yeni TG'ler gecikir; bildirimler kuyrukta bekler ve bağlantı
 *     dönünce gönderilir.
 *   • Reflektör yeniden başlarsa: politikanın son kopyası diske yazıldığı için
 *     panel hâlâ erişilemez olsa bile hizmet verebilir.
 *   • Panel token'ı İPTAL ederse: bu apayrı bir durumdur. Reflektör KİLİTLENİR,
 *     yeni giriş kabul etmez ve bağlı kullanıcıları düşürür. Ağdan çıkarılmanın
 *     yolu budur.
 *
 * Bu ayrım kritiktir: geçici bir ağ hatası ASLA kilitlenmeye yol açmaz;
 * yalnızca panelin AÇIKÇA "seni tanımıyorum" demesi yol açar.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { URL } = require('url');

const { createLogger } = require('./logger');

const log = createLogger('control');

/**
 * Panele bildirilen sürüm — panelde Reflektörler tablosunda görünür.
 *
 * TEK KAYNAK `index.js` içindeki `SURUM` sabitidir; açılışta [setAgentVersion]
 * ile buraya yazılır. Burada `require('./index')` YAPILAMAZ: index.js zaten bu
 * modülü require ediyor, döngüsel bağımlılık olurdu.
 *
 * ── NEDEN package.json'dan OKUNMUYOR ────────────────────────────────────────
 * Eskiden burada bir `package.json` yedeği vardı. Yedek olmanın kötü tarafı,
 * BAŞARISIZ OLDUĞUNDA SESSİZ KALMAMASI gerektiği hâlde makul görünen YANLIŞ bir
 * numara üretmesiydi: panelde `v2.0.0` yazıyordu, çünkü package.json öyle
 * diyordu — index.js'te 1.0.1 yazmasına rağmen. "Sürüm yanlış çekiyor" tam
 * olarak buydu ve teşhisi zor bir yanılgıdır.
 *
 * Artık yedek yok. Bir çağrı yolu [setAgentVersion]'ı atlarsa sürüm BOŞ gider
 * ve panelde `—` görünür; yani "bildirilmedi" ile "yanlış bildirildi" birbirine
 * karışmaz.
 * ─────────────────────────────────────────────────────────────────────────── */
let AGENT_VERSION = '';

/**
 * Panele bildirilecek sürümü belirler (index.js açılışta çağırır).
 *
 * İlk panel isteğinden ÖNCE çağrılmalıdır; `User-Agent` başlığı ve her
 * bildirimin gövdesi bu değeri taşır.
 */
function setAgentVersion(surum) {
  const s = String(surum || '').trim();
  if (s) {
    AGENT_VERSION = s.slice(0, 32);   // servers.agent_version VARCHAR(32)
  }
}

/** Tek bir HTTP isteğinin en fazla süresi. */
const REQUEST_TIMEOUT_MS = 15000;
/** İzlenecek en fazla yönlendirme (http→https, eksik / vb.). */
const MAX_REDIRECTS = 3;
/** Kuyruk üst sınırları — panel uzun süre erişilemezse bellek şişmesin. */
const MAX_QUEUED_LOGINS = 500;
const MAX_QUEUED_CALLS = 2000;

/** DMR kimliğinin ana (ESSID'siz) hâli: 286072218 → 2860722. */
function baseDmrId(dmrId) {
  const n = Number(dmrId) || 0;
  return n > 9999999 ? Math.floor(n / 100) : n;
}

/** Kimlikteki ESSID eki (yoksa 0): 286072218 → 18. */
function essidOf(dmrId) {
  const n = Number(dmrId) || 0;
  return n > 9999999 ? n % 100 : 0;
}

/**
 * Tek bir JSON isteği. Bağımlılık YOKTUR; Node'un kendi http/https modülü.
 *
 * Yönlendirmeleri POST gövdesini KORUYARAK izler: paylaşımlı barındırmalar
 * sıklıkla http→https ya da eksik dizin eğik çizgisi için 301 döndürür ve
 * gövdeyi düşürmek bildirimi sessizce kaybettirirdi.
 */
function requestJson(urlString, options, redirectsLeft) {
  const opts = options || {};
  const left = redirectsLeft === undefined ? MAX_REDIRECTS : redirectsLeft;

  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(urlString);
    } catch (err) {
      reject(new Error(`gecersiz adres / invalid URL: ${urlString}`));
      return;
    }

    const transport = url.protocol === 'https:' ? https : http;
    const payload = opts.body ? Buffer.from(JSON.stringify(opts.body), 'utf8') : null;

    const headers = {
      'Accept': 'application/json',
      // Gzip istemiyoruz: gövdeler küçük, açma kodu bir arıza kaynağı olmasın.
      'Accept-Encoding': 'identity',
      // Sürüm henüz yazılmadıysa başlık `dvpx-reflector/-` olur; boş bırakmak
      // bazı vekil sunucularda başlığı tamamen düşürüyor.
      'User-Agent': `dvpx-reflector/${AGENT_VERSION || '-'}`,
      'Connection': 'close',
    };
    if (opts.token) {
      // İki başlık birlikte gönderilir: bazı paylaşımlı barındırmalar
      // Authorization başlığını PHP'ye HİÇ ULAŞTIRMAZ (CGI kipi). X-DVPX-Token
      // her koşulda geçer. Panel ikisini de kabul eder.
      headers.Authorization = `Bearer ${opts.token}`;
      headers['X-DVPX-Token'] = opts.token;
    }
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = String(payload.length);
    }

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: opts.method || 'GET',
        headers,
      },
      (res) => {
        // ── Yönlendirme ──
        const location = res.headers.location;
        if (res.statusCode >= 300 && res.statusCode < 400 && location && left > 0) {
          res.resume();   // gövdeyi tüket, soketi serbest bırak
          const next = new URL(location, url).toString();
          log.warn(`panel ${res.statusCode} ile yonlendirdi → ${next} `
            + '(config.json icindeki dashboard.url dogrudan bu adres olmali)');
          requestJson(next, opts, left - 1).then(resolve, reject);
          return;
        }

        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          // Panel HTML hata sayfası döndürürse megabaytlarca veri okumayalım.
          if (size <= 2 * 1024 * 1024) {
            chunks.push(c);
          }
        });
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch (err) {
            json = null;
          }
          resolve({ status: res.statusCode || 0, json, raw });
        });
      }
    );

    req.on('error', (err) => reject(err));
    req.setTimeout(opts.timeoutMs || REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`panel yanit vermedi (${opts.timeoutMs || REQUEST_TIMEOUT_MS} ms zaman asimi) / `
        + 'dashboard did not respond in time'));
    });

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

/**
 * HTTP durum/gövdesini anlaşılır bir hataya çevirir.
 *
 * `fatal` bayrağı hayati önemdedir: yalnızca panelin AÇIKÇA reddettiği
 * durumlarda true olur. Geçici hatalarda (5xx, ağ, JSON olmayan yanıt) false
 * kalır ve reflektör önbellekle çalışmayı sürdürür.
 */
function toControlError(res) {
  const j = res.json;
  if (j && typeof j === 'object' && j.ok === false) {
    const err = new Error(String(j.message || j.error || 'panel hatasi / dashboard error'));
    err.code = String(j.error || 'error');
    err.fatal = j.fatal === true;
    err.status = res.status;
    return err;
  }

  // JSON değil: neredeyse her zaman yanlış adres. Operatöre ipucu verelim.
  const snippet = String(res.raw || '').replace(/\s+/g, ' ').slice(0, 160);
  let hint = '';
  if (res.status === 404) {
    hint = ' — adres bulunamadi: dashboard.url reflector.php dosyasini gostermeli';
  } else if (res.status === 401 || res.status === 403) {
    hint = ' — sunucu erisimi engelledi (barindirma guvenlik duvari?)';
  } else if (/<html/i.test(snippet)) {
    hint = ' — panel HTML dondurdu; dashboard.url yanlis olabilir';
  }
  const err = new Error(`panelden beklenmeyen yanit / unexpected reply (HTTP ${res.status})${hint}: ${snippet}`);
  err.code = 'bad_reply';
  err.fatal = false;
  err.status = res.status;
  return err;
}

class Control {
  /**
   * @param {object} cfg loadConfig() çıktısı
   */
  constructor(cfg) {
    this.cfg = cfg;
    this.url = cfg.dashboard.url;
    this.token = cfg.dashboard.token;

    /* ── Politika (panelden gelen tek gerçek kaynak) ─────────────────────── */
    this.stamp = '';                 // politika damgası (md5)
    this.talkgroups = new Map();     // tgNumber -> {number, name, isActive, isPrivate}
    this.blocked = new Set();        // ana DMR ID'ler
    /**
     * Panelin bildirdigi diger reflektorler (reflektorler arasi bag).
     *
     * [{id, name, host, udpPort, key}] — `key` o CIFTE ait paylasilan anahtar
     * olup panelde turetilir. ASLA loglanmaz, panele geri gonderilmez.
     */
    this.peers = [];
    this.grants = new Map();         // tgNumber -> Set(ana DMR ID)
    /**
     * Sabit "Echo Test" TG numarası (0 = tanımsız/panel eski sürüm).
     *
     * udp-server.forwardPrivate bu numaraya yapılan ÖZEL ÇAĞRIYI, gerçek bir
     * hedef aramadan, doğrudan gönderene geri yansıtır. Panel yöneticisi
     * numarayı değiştirebilir; her politika turunda güncellenir.
     */
    this.echoTestTg = 0;
    this.serverInfo = null;          // {id, name, status, published, ...}
    this.hasPolicy = false;

    /* ── Kilit (yalnızca panel açıkça reddederse) ────────────────────────── */
    this.locked = false;
    this.lockReason = '';

    /**
     * ÖZ DENETİM KANCASI — "sorunsuz çalışıyor muyum?"
     *
     * `index.js` burayı bir işlevle doldurur (setHealthProbe). Denetimi Control
     * kendisi YAPMAZ, çünkü gerçeği bilen o değil: dinleyen soketler, oturum
     * sayaçları ve reflektörler arası bağın durumu index.js'in elindedir.
     * Control yalnızca sonucu bildirime ekler.
     *
     * Kanca yoksa ya da hata atarsa sağlık alanı GÖNDERİLMEZ — panel bunu
     * "bilinmiyor" olarak gösterir. Uyduracak bir "ok" değerimiz yok.
     */
    this.healthProbe = null;

    /* ── Giden kuyruklar ─────────────────────────────────────────────────── */
    this.logins = [];                // [{dmr_id, callsign, ip}]
    this.calls = new Map();          // uid -> {…, active, sent}
    this.onlineRows = [];
    this.lastOnlineSentAt = 0;

    /* ── Zamanlama ───────────────────────────────────────────────────────── */
    this.beatTimer = null;
    this.lastBeatAt = 0;
    this.beating = false;
    this.closing = false;
    this.failures = 0;
    this.lastWarningKey = '';

    /* ── Kancalar (index.js bağlar) ──────────────────────────────────────── */
    this.onPolicy = null;            // (control) => void   politika uygulandı
    this.onLockChange = null;        // (locked, reason) => void

    // Politikanın son iyi kopyası: yeniden başlatmada panel erişilemez olsa
    // bile hizmet verebilmek için diske yazılır.
    const dir = cfg.configFile ? path.dirname(cfg.configFile) : path.join(__dirname, '..');
    this.cacheFile = path.join(dir, 'policy.cache.json');
  }

  /* ══ Başlatma ══════════════════════════════════════════════════════════ */

  /**
   * Panelle el sıkışır ve ilk politikayı alır.
   *
   * Başlatmayı REDDETTİĞİMİZ tek durum: elimizde hiç politika yokken panele
   * ulaşamamak (TG listesi olmadan hizmet verilemez) ya da panelin token'ı
   * tanımaması (yapılandırma yanlış, çalışmanın anlamı yok).
   *
   * "Onay bekliyor" durumunda ise ÇALIŞMAYA BAŞLARIZ (kilitli): yönetici
   * onayladığı an reflektör kendiliğinden hizmete girer, elle yeniden
   * başlatmak gerekmez.
   */
  async init() {
    this.loadCachedPolicy();

    log.info(`dashboard: ${this.url}`);
    log.info(`token: ${this.token.slice(0, 13)}… (${this.token.length} karakter / chars)`);

    try {
      await this.beat(true);
    } catch (err) {
      if (err.code === 'pending_approval') {
        log.error('════════════════════════════════════════════════════════════');
        log.error('REFLEKTOR ONAY BEKLIYOR / REFLECTOR AWAITING APPROVAL');
        log.error(err.message);
        log.error('Yonetici panelden onaylayinca hizmet KENDILIGINDEN baslar.');
        log.error('════════════════════════════════════════════════════════════');
        this.setLocked(true, 'onay bekliyor / pending approval');
      } else if (err.fatal) {
        // Token tanınmıyor: yapılandırma hatası. Anlaşılır biçimde duruyoruz.
        const e = new Error(
          `${err.message}\n\n`
          + '  Kontrol listesi / checklist:\n'
          + '   1. config.json icindeki dashboard.token panelde uretilen token ile AYNI mi?\n'
          + '   2. Token panelden yeniden uretildi mi? (eski token aninda gecersiz olur)\n'
          + '   3. dashboard.url dogru mu? Tarayicida <url>?action=ping deneyin.\n'
        );
        e.fatal = true;
        throw e;
      } else if (this.hasPolicy) {
        log.warn(`panele ulasilamadi (${err.message})`);
        log.warn('ONBELLEKTEKI politika ile baslatiliyor; panel donunce kendiliginden guncellenir.');
      } else {
        const e = new Error(
          `panele ulasilamadi ve onbellekte politika yok / dashboard unreachable and no cached policy:\n`
          + `  ${err.message}\n\n`
          + '  Kontrol listesi / checklist:\n'
          + '   1. Sunucunun internet erisimi var mi?  curl -sS <dashboard.url>?action=ping\n'
          + '   2. dashboard.url dogru yazilmis mi (sonunda /reflector.php olmali)?\n'
          + '   3. Panelin SSL sertifikasi gecerli mi?\n'
        );
        e.fatal = false;
        throw e;
      }
    }

    this.scheduleBeat(this.nextDelayMs());
  }

  /* ══ Politika ══════════════════════════════════════════════════════════ */

  /** Diskteki son iyi politikayı yükler (varsa). */
  loadCachedPolicy() {
    try {
      if (!fs.existsSync(this.cacheFile)) {
        return;
      }
      const snap = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
      if (snap && typeof snap === 'object' && Array.isArray(snap.talkgroups)) {
        this.applyPolicy(snap, true);
        log.info(`onbellekteki politika yuklendi (${this.talkgroups.size} TG, damga ${this.stamp.slice(0, 8)})`);
      }
    } catch (err) {
      log.warn(`policy.cache.json okunamadi: ${err.message}`);
    }
  }

  /** Politikayı diske yazar. Yazılamıyorsa (salt-okunur dizin) yalnızca uyarır. */
  savePolicy(snap) {
    try {
      fs.writeFileSync(this.cacheFile, JSON.stringify(snap), { mode: 0o600 });
      // `mode` YALNIZCA dosya yeni olusurken uygulanir. Bu dosya artik
      // reflektorler arasi bag anahtarlarini da tasidigi icin, onceden daha
      // gevsek izinlerle olusmus bir dosyayi da sikilastiriyoruz.
      fs.chmodSync(this.cacheFile, 0o600);
    } catch (err) {
      log.debug(`policy.cache.json yazilamadi: ${err.message}`);
    }
  }

  /**
   * Panelden gelen politikayı yürürlüğe koyar.
   *
   * @param {object} snap panel yanıtındaki `snapshot`
   * @param {boolean} fromCache diskten yüklendiyse true (kancayı tetiklemez)
   */
  applyPolicy(snap, fromCache) {
    const tgs = new Map();
    for (const t of snap.talkgroups || []) {
      const number = Number(t.number);
      if (!Number.isFinite(number) || number < 1) {
        continue;
      }
      tgs.set(number, {
        number,
        name: String(t.name || ''),
        isActive: t.active !== false,
        isPrivate: t.private === true,
      });
    }

    const blocked = new Set();
    for (const id of snap.blocked || []) {
      const n = Number(id);
      if (Number.isFinite(n) && n > 0) {
        blocked.add(baseDmrId(n));
      }
    }

    const grants = new Map();
    const rawGrants = snap.grants && typeof snap.grants === 'object' ? snap.grants : {};
    for (const key of Object.keys(rawGrants)) {
      const tg = Number(key);
      if (!Number.isFinite(tg)) {
        continue;
      }
      const set = new Set();
      for (const id of rawGrants[key] || []) {
        const n = Number(id);
        if (Number.isFinite(n) && n > 0) {
          set.add(baseDmrId(n));
        }
      }
      grants.set(tg, set);
    }

    // Reflektorler arasi bag listesi. Panel bu alani gondermiyorsa (eski
    // surum panel) liste bos kalir ve reflektor tek basina calisir — davranis
    // eskisiyle birebir aynidir, hicbir sey bozulmaz.
    const peers = [];
    for (const p of Array.isArray(snap.peers) ? snap.peers : []) {
      const id = Number(p && p.id);
      const host = String((p && p.host) || '').trim();
      const udpPort = Number(p && p.udpPort);
      const key = String((p && p.key) || '');
      if (!Number.isFinite(id) || id < 1 || !host || !Number.isFinite(udpPort)
          || !/^[0-9a-f]{64}$/i.test(key)) {
        continue;
      }
      peers.push({ id, name: String((p && p.name) || `#${id}`), host, udpPort, key });
    }

    this.talkgroups = tgs;
    this.blocked = blocked;
    this.grants = grants;
    this.peers = peers;
    // Panel bu alanı gondermiyorsa (eski surum panel) 0 kalir ve echo test
    // devre disi olur — davranis eskisiyle birebir aynidir, hicbir sey bozulmaz.
    this.echoTestTg = Number(snap.echoTest) || 0;
    this.stamp = String(snap.policy || '');
    this.serverInfo = snap.server || null;
    this.hasPolicy = true;

    if (!fromCache) {
      this.savePolicy(snap);
      log.info(`politika guncellendi: ${tgs.size} TG, ${blocked.size} engelli, `
        + `${grants.size} ozel TG yetkisi, ${peers.length} reflektor bagi `
        + `(damga ${this.stamp.slice(0, 8)})`);
      // index.js buradan: engellenen kullanıcıyı düşürür, yetkisi kalkan
      // aboneliği iptal eder. Politika değişikliği ANINDA hüküm sürer.
      if (typeof this.onPolicy === 'function') {
        try {
          this.onPolicy(this);
        } catch (err) {
          log.warn(`politika kancasi hatasi: ${err.message}`);
        }
      }
    }
  }

  /** Panelin bildirdiği sunucu adı varsa onu kullan (tek gerçek kaynak panel). */
  get serverName() {
    if (this.serverInfo && this.serverInfo.name) {
      return String(this.serverInfo.name);
    }
    return this.cfg.serverName;
  }

  /** Panelde tanımlı `servers.id` — çağrı kayıtları buna bağlanır. */
  get serverId() {
    return this.serverInfo && this.serverInfo.id ? Number(this.serverInfo.id) : null;
  }

  /* ══ Kilit ═════════════════════════════════════════════════════════════ */

  setLocked(locked, reason) {
    const changed = (this.locked !== locked);
    this.locked = locked;
    this.lockReason = locked ? String(reason || '') : '';
    if (!changed) {
      return;
    }
    if (locked) {
      log.error(`KILITLENDI: ${this.lockReason} — yeni giris kabul edilmiyor.`);
    } else {
      log.info('kilit kalkti; yeni girisler yeniden kabul ediliyor. / unlocked.');
    }
    if (typeof this.onLockChange === 'function') {
      try {
        this.onLockChange(locked, this.lockReason);
      } catch (err) {
        log.warn(`kilit kancasi hatasi: ${err.message}`);
      }
    }
  }

  /** Kilitliyse ya da politika yoksa hizmet verilemez. */
  assertServiceable() {
    if (this.locked) {
      throw new Error(`reflektor kilitli / reflector locked: ${this.lockReason}`);
    }
    if (!this.hasPolicy) {
      throw new Error('politika henuz alinmadi / policy not received yet');
    }
  }

  /* ══ Karar verme — hepsi YEREL, ağ erişimi YOK ═════════════════════════ */

  /**
   * LOGIN denetimi — panele SORULMAZ, yerel politikadan karar verilir.
   *
   * DVPX açık bir ağdır: tanınmayan bir DMR ID kabul edilir ve panele
   * bildirilir (panel kaydı kendisi açar). Reddedilen tek durum, panelde
   * engellenmiş olmaktır.
   *
   * Denetim DAİMA ana (ESSID'siz) kimlikle yapılır: kişinin ikinci telsizi
   * engeli aşmasın.
   */
  async checkUser(dmrId, callsign) {
    this.assertServiceable();

    const base = baseDmrId(dmrId);
    const cs = String(callsign || '').toUpperCase().slice(0, 16);

    if (this.blocked.has(base)) {
      return { blocked: true, id: 0, dmrId: base, callsign: cs };
    }
    return { blocked: false, id: 0, dmrId: base, callsign: cs };
  }

  /**
   * Başarılı girişi panele bildirmek üzere kuyruğa alır.
   *
   * Kullanıcının panele kaydı, `last_login`/`last_ip` ve cihaz (ESSID) bilgisi
   * buradan doğar. Bekletme YOKTUR: giriş yanıtı bir ağ turu kadar bile
   * gecikmez.
   */
  reportLogin(dmrId, callsign, ip) {
    if (this.logins.length >= MAX_QUEUED_LOGINS) {
      this.logins.shift();
    }
    this.logins.push({
      dmr_id: Number(dmrId) || 0,
      callsign: String(callsign || '').toUpperCase().slice(0, 16),
      ip: String(ip || '').slice(0, 45),
    });
    this.nudge();
  }

  /**
   * TG abonelenebilir mi?
   *
   * ÖZEL TG'de yetkisi olmayan kullanıcıya UNKNOWN_TG döndürülür — "INACTIVE"
   * gibi ayırt edici bir yanıt, özel bir grubun VARLIĞINI sızdırırdı.
   */
  async checkTalkgroup(tgNumber, dmrId) {
    this.assertServiceable();

    const tg = this.talkgroups.get(Number(tgNumber));
    if (!tg) {
      return { ok: false, reason: 'UNKNOWN_TG' };
    }
    if (!tg.isActive) {
      return { ok: false, reason: 'INACTIVE_TG' };
    }
    if (tg.isPrivate && !this.mayUsePrivateTg(dmrId, tg.number)) {
      return { ok: false, reason: 'UNKNOWN_TG' };
    }
    return { ok: true, name: tg.name };
  }

  /** Kullanıcının bu özel TG'ye panelden verilmiş yetkisi var mı? */
  mayUsePrivateTg(dmrId, tgNumber) {
    const set = this.grants.get(Number(tgNumber));
    return !!set && set.has(baseDmrId(dmrId));
  }

  /** TGLIST için aktif TG listesi; özel TG'ler yalnızca yetkiliye görünür. */
  async activeTalkgroups(dmrId) {
    if (!this.hasPolicy) {
      return [];
    }
    const out = [];
    for (const tg of this.talkgroups.values()) {
      if (!tg.isActive) {
        continue;
      }
      if (tg.isPrivate && !this.mayUsePrivateTg(dmrId, tg.number)) {
        continue;
      }
      out.push({ number: tg.number, name: tg.name });
    }
    return out;
  }

  /**
   * Eski `db.js` ile uyum için bırakıldı; artık iş yapmaz.
   * TG listesi panelden periyodik olarak zaten geliyor.
   */
  async ensureTalkgroups() {
    return this.talkgroups;
  }

  /* ══ Çağrı kayıtları ═══════════════════════════════════════════════════ */

  /**
   * Yayın BAŞLARKEN kaydı açar ve tekil kimliğini döndürür.
   *
   * Kimliği reflektör üretir. Bu, panele giden bildirimin kaç kez tekrarlandığı
   * fark etmeksizin TEK bir satır oluşmasını garanti eder (panel `call_uid`
   * üzerinden upsert yapar) — ağ koptuğunda mükerrer kayıt IMKANSIZDIR.
   *
   * Söz (Promise) döndürür ama ağ beklemez: ses yolu hiçbir koşulda
   * bekletilmez.
   */
  async beginCall(entry) {
    if (!this.cfg.logCalls) {
      return null;
    }
    const uid = crypto.randomBytes(16).toString('hex');

    if (this.calls.size >= MAX_QUEUED_CALLS) {
      // En eski kaydı düş (Map ekleme sırasını korur).
      const oldest = this.calls.keys().next();
      if (!oldest.done) {
        this.calls.delete(oldest.value);
      }
    }

    this.calls.set(uid, {
      uid,
      source_id: Number(entry.sourceId) || 0,
      callsign: String(entry.callsign || '').slice(0, 16),
      target_id: Number(entry.targetId) || 0,
      call_type: Number(entry.callType) || 0,
      frames: 0,
      duration_ms: 0,
      started_at: entry.startedAt,
      active: true,
      sent: false,
    });

    // Panelde "canlı konuşuyor" göstergesi hemen görünsün.
    this.nudge();
    return uid;
  }

  /** Yayın bitti: kesin çerçeve sayısı ve süre ile kapat. */
  async endCall(uid, frames, durationMs) {
    const rec = uid ? this.calls.get(uid) : null;
    if (!rec) {
      return;
    }
    // Nesneyi YENİLİYORUZ (yerinde değiştirmiyoruz): gönderim sırasında
    // değişen bir kaydı kimlik karşılaştırmasıyla ayırt edebilmek için.
    this.calls.set(uid, Object.assign({}, rec, {
      frames: Math.max(0, Number(frames) || 0),
      duration_ms: Math.max(1, Number(durationMs) || 0),
      active: false,
    }));
    this.nudge();
  }

  /**
   * Kayda değmeyen yayını (tek çerçevelik gürültü) iptal eder.
   *
   * Henüz panele gönderilmemişse yerel kuyruktan silinir — ağa hiç çıkmaz.
   * Gönderilmişse `frames = 0` ile bildirilir; panel bu kaydı siler.
   */
  async dropCall(uid) {
    const rec = uid ? this.calls.get(uid) : null;
    if (!rec) {
      return;
    }
    if (!rec.sent) {
      this.calls.delete(uid);
      return;
    }
    this.calls.set(uid, Object.assign({}, rec, {
      frames: 0,
      duration_ms: 0,
      active: false,
    }));
    this.nudge();
  }

  /* ══ Çevrimiçi liste ═══════════════════════════════════════════════════ */

  /**
   * Çevrimiçi kullanıcı listesini bir sonraki bildirime hazırlar.
   *
   * Hemen göndermeyiz: liste ~10 saniyede bir yeterlidir ve çağrı kayıtları
   * için 2 saniyede bir atılan bildirimlere eklenirse boşuna bant genişliği
   * harcanır.
   */
  async publishOnline(rows) {
    this.onlineRows = Array.isArray(rows) ? rows : [];
  }

  /* ══ Bildirim döngüsü ══════════════════════════════════════════════════ */

  /**
   * Bir kaydın panele GÖNDERİLECEK yeni bir şeyi var mı?
   *
   * Süren bir yayın panele bir kez "başladı" olarak bildirilir; bitene kadar
   * söyleyecek yeni bir şey yoktur. Bunu ayırt etmezsek uzun bir konuşma
   * boyunca aynı kayıt her 2 saniyede bir boşuna gönderilirdi.
   */
  static gonderilecekVar(rec) {
    return !(rec.sent && rec.active);
  }

  /** Bekleyen iş var mı? (bildirim sıklığını bu belirler) */
  pending() {
    if (this.logins.length > 0) {
      return true;
    }
    for (const rec of this.calls.values()) {
      if (Control.gonderilecekVar(rec)) {
        return true;
      }
    }
    return false;
  }

  /** Bir sonraki bildirime kadar beklenecek süre. */
  nextDelayMs() {
    if (this.locked) {
      // Kilitliyken sık sık denemenin anlamı yok; onay/yeniden yetkilendirme
      // beklenirken 30 saniyede bir yoklamak yeterli.
      return 30000;
    }
    if (this.failures > 0) {
      // Geri çekilme: 2× büyür, en fazla 60 sn. Panel çökmüşse üzerine
      // gitmeyelim; kuyruk zaten bekliyor.
      return Math.min(60000, this.cfg.dashboard.activeIntervalSec * 1000 * (2 ** Math.min(this.failures, 5)));
    }
    return (this.pending()
      ? this.cfg.dashboard.activeIntervalSec
      : this.cfg.dashboard.idleIntervalSec) * 1000;
  }

  /** Zamanlayıcıyı kurar; iki bildirim arası en az `activeIntervalSec` olur. */
  scheduleBeat(delayMs) {
    if (this.closing) {
      return;
    }
    const minGap = this.cfg.dashboard.activeIntervalSec * 1000;
    const sinceLast = Date.now() - this.lastBeatAt;
    const wait = Math.max(delayMs, minGap - sinceLast, 0);

    if (this.beatTimer) {
      clearTimeout(this.beatTimer);
    }
    this.beatTimer = setTimeout(() => {
      this.beatTimer = null;
      this.beat(false).catch(() => { /* beat kendi loglar */ });
    }, wait);
    if (this.beatTimer.unref) {
      this.beatTimer.unref();
    }
  }

  /**
   * "Acele et" — yeni bir olay oluştuğunda bildirimi öne alır.
   *
   * `scheduleBeat` en az `activeIntervalSec` boşluk bıraktığı için, PTT'ye
   * arka arkaya basılması istek seline dönüşmez.
   */
  nudge() {
    if (this.closing || this.locked) {
      return;
    }
    this.scheduleBeat(0);
  }

  /**
   * Öz denetim kancasını takar. `index.js` başlatma bittikten sonra çağırır.
   *
   * @param {() => {state:string, note:string, uptimeSec:number}} fn
   */
  setHealthProbe(fn) {
    this.healthProbe = (typeof fn === 'function') ? fn : null;
  }

  /**
   * Bildirime eklenecek sağlık alanlarını üretir.
   *
   * Kanca yoksa ya da PATLARSA boş nesne döner: panel sağlık alanlarına
   * dokunmaz ve durumu "bilinmiyor" gösterir. Denetimin kendi hatası yüzünden
   * "sorunsuz" bildirmek, olabilecek en yanıltıcı davranış olurdu.
   */
  healthFields() {
    if (!this.healthProbe) {
      return {};
    }
    try {
      const h = this.healthProbe();
      if (!h || ['ok', 'warn', 'error'].indexOf(h.state) === -1) {
        return {};
      }
      return {
        state: h.state,
        note: String(h.note || '').slice(0, 190),
        uptimeSec: Math.max(0, Math.round(Number(h.uptimeSec) || 0)),
      };
    } catch (err) {
      return {};
    }
  }

  /** Gönderilecek gövdeyi ve "başarı olursa temizlenecekler" listesini kurar. */
  buildBody(isBoot) {
    const sendOnline = (Date.now() - this.lastOnlineSentAt)
      >= (this.cfg.dashboard.onlineIntervalSec * 1000);

    const callBatch = [];
    for (const [uid, rec] of this.calls) {
      if (!Control.gonderilecekVar(rec)) {
        continue;   // süren yayın, zaten bildirildi
      }
      callBatch.push([uid, rec]);
      if (callBatch.length >= 200) {
        break;
      }
    }

    const loginBatch = this.logins.slice(0, 100);

    const body = {
      version: AGENT_VERSION,
      policy: this.stamp,
      tcpPort: this.cfg.tcpPort,
      udpPort: this.cfg.udpPort,
      // `stats` hem sayaç hem ÖZ DENETİM taşır: panel "ayakta mı?" sorusunu
      // last_seen ile, "sorunsuz mu?" sorusunu buradaki `state` ile cevaplar.
      stats: Object.assign({ sessions: this.onlineRows.length }, this.healthFields()),
    };
    if (isBoot) {
      body.boot = true;
    }
    if (loginBatch.length) {
      body.logins = loginBatch;
    }
    if (callBatch.length) {
      body.calls = callBatch.map(([, rec]) => ({
        uid: rec.uid,
        source_id: rec.source_id,
        callsign: rec.callsign,
        target_id: rec.target_id,
        call_type: rec.call_type,
        frames: rec.frames,
        duration_ms: rec.duration_ms,
        started_at: rec.started_at,
        active: rec.active,
      }));
    }
    if (sendOnline) {
      body.online = this.onlineRows.map((r) => ({
        dmr_id: r.dmrId,
        callsign: r.callsign,
        tg: r.talkgroup,
      }));
    }

    return { body, callBatch, loginCount: loginBatch.length, sentOnline: sendOnline };
  }

  /**
   * Tek bir bildirim turu.
   *
   * Kuyruklar YALNIZCA panel kabul ettikten sonra boşaltılır. Ağ koptuysa
   * hiçbir şey kaybolmaz; bir sonraki turda aynı kayıtlar yeniden gönderilir
   * (mükerrer yazım `call_uid` sayesinde imkânsızdır).
   */
  async beat(isBoot, force) {
    // `force` yalnızca kapanış turu içindir: kapanmakta olsak da son bildirimi
    // göndermek isteriz.
    if (this.beating || (this.closing && force !== true)) {
      return;
    }
    this.beating = true;
    this.lastBeatAt = Date.now();

    const plan = this.buildBody(isBoot === true);

    try {
      const res = await requestJson(this.url, {
        method: 'POST',
        token: this.token,
        body: plan.body,
      });

      if (res.status !== 200 || !res.json || res.json.ok !== true) {
        throw toControlError(res);
      }

      /* ── Başarılı: kuyrukları temizle ─────────────────────────────────── */
      for (const [uid, rec] of plan.callBatch) {
        const current = this.calls.get(uid);
        if (current !== rec) {
          // Kayıt gönderim sırasında güncellendi (PTT bu arada bırakıldı):
          // yeni hâli bir sonraki turda gitsin, SİLMİYORUZ.
          continue;
        }
        if (rec.active) {
          // Yayın sürüyor: kaydı tutuyoruz, çünkü bitiş değerleri sonra
          // bildirilecek. Gönderildiğini işaretlemek yeterli.
          this.calls.set(uid, Object.assign({}, rec, { sent: true }));
        } else {
          this.calls.delete(uid);
        }
      }
      if (plan.loginCount) {
        this.logins.splice(0, plan.loginCount);
      }
      if (plan.sentOnline) {
        this.lastOnlineSentAt = Date.now();
      }

      /* ── Politika ─────────────────────────────────────────────────────── */
      if (res.json.snapshot) {
        this.applyPolicy(res.json.snapshot, false);
      }

      /* ── Panelin uyarıları ────────────────────────────────────────────── */
      const warnings = Array.isArray(res.json.warnings) ? res.json.warnings : [];
      const key = warnings.join('|');
      if (key !== this.lastWarningKey) {
        // Aynı uyarıyı her 2 saniyede bir yazmayalım; yalnızca değiştiğinde.
        this.lastWarningKey = key;
        for (const w of warnings) {
          log.warn(String(w));
        }
      }

      // "Geri geldi" mesajı yalnızca gerçekten ULAŞILAMADIYSA anlamlıdır;
      // kilitliyken panele erişim zaten vardı, yalnızca reddediliyordu.
      if (this.failures > 0 && !this.locked) {
        log.info('panel baglantisi geri geldi / dashboard reachable again');
      }
      this.failures = 0;
      this.setLocked(false, '');
    } catch (err) {
      this.failures += 1;

      if (err.fatal) {
        this.setLocked(true, err.code === 'pending_approval'
          ? 'onay bekliyor / pending approval'
          : `panel reddetti / rejected by dashboard: ${err.message}`);
        if (isBoot) {
          throw err;   // init() anlaşılır bir mesajla dursun
        }
        log.error(err.message);
      } else {
        // GEÇİCİ hata: kilitleme YOK. İlk birkaç hatayı uyarı, sonrasını
        // seyrek logla; panel uzun süre kapalıysa log dolmasın.
        const msg = `panele bildirim basarisiz (${this.failures}. deneme): ${err.message}`;
        if (this.failures <= 3 || this.failures % 20 === 0) {
          log.warn(msg);
        } else {
          log.debug(msg);
        }
        if (this.failures === 4) {
          log.warn('panel erisilemiyor; ses yonlendirme ve girisler ONBELLEKTEKI '
            + 'politika ile SURUYOR. Bildirimler kuyrukta bekliyor.');
        }
        if (isBoot) {
          throw err;
        }
      }
    } finally {
      this.beating = false;
      if (!this.closing) {
        this.scheduleBeat(this.nextDelayMs());
      }
    }
  }

  /* ══ Kapanış ═══════════════════════════════════════════════════════════ */

  /**
   * Kapanırken son bir bildirim gönderir: çevrimiçi listeyi boşaltır ve
   * kuyrukta kalan çağrı kayıtlarını yazdırır. Panelde "hayalet kullanıcı"
   * kalmaz.
   */
  async close() {
    // Bundan sonra hiçbir yeni tur ZAMANLANMAZ; yalnızca aşağıdaki tek
    // "force" turu çalışır.
    this.closing = true;
    if (this.beatTimer) {
      clearTimeout(this.beatTimer);
      this.beatTimer = null;
    }
    if (this.locked) {
      return;   // panel bizi tanımıyor; bildirimin anlamı yok
    }

    // Süren bir bildirim varsa en fazla 3 saniye bekle.
    for (let i = 0; this.beating && i < 30; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 100));
    }

    this.onlineRows = [];
    this.lastOnlineSentAt = 0;   // `online: []` gönderilmesini garanti eder

    try {
      await this.beat(false, true);
      log.info('kapanis bildirimi gonderildi / final report sent');
    } catch (err) {
      log.warn(`kapanis bildirimi gonderilemedi: ${err.message}`);
    } finally {
      if (this.beatTimer) {
        clearTimeout(this.beatTimer);
        this.beatTimer = null;
      }
    }
  }
}

module.exports = { Control, baseDmrId, essidOf, requestJson, setAgentVersion };
