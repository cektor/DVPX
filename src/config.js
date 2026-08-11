'use strict';

/**
 * DVPX Reflector — yapılandırma yükleyici / configuration loader
 *
 * Öncelik sırası / precedence (sonraki öncekini ezer):
 *   1) varsayılanlar
 *   2) config.json
 *   3) ortam değişkenleri (DVPX_*)
 *
 * BU DOSYADA VERİTABANI AYARI YOKTUR VE OLMAMALIDIR. Reflektör MySQL'e
 * bağlanmaz; yönetimin tamamı DVPX panelindedir ve reflektör panelle tek bir
 * HTTPS ucu üzerinden, panelden üretilmiş bir token ile konuşur.
 *
 * config.json'da bulunması gereken TEK sır `dashboard.token`'dır. Geri kalan
 * her şey (TG listesi, engelli kullanıcılar, özel TG yetkileri, sunucu adı)
 * panelden gelir.
 *
 * Bozuk/eksik yapılandırma süreci sessizce çalıştırmaz; ne yapılması
 * gerektiğini söyleyen bir hata ile durdurur.
 */

const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const DEFAULTS = {
  // Panel bir ad bildirene kadar kullanılan geçici etiket.
  serverName: 'DVPX-Reflector',
  bindAddress: '0.0.0.0',
  tcpPort: 62070,
  udpPort: 62071,
  dashboard: {
    // Panelin reflektör API adresi, ör. https://panel.ornek.com/dvpx/reflector.php
    url: '',
    // Panel → Reflektörler → ⚿ Token ile üretilir.
    token: '',
    // Bildirim sıklığı. Yayın/giriş varken "active", boştayken "idle".
    // İki bildirim arası HER ZAMAN en az activeIntervalSec kadardır.
    activeIntervalSec: 2,
    idleIntervalSec: 10,
    // Çevrimiçi kullanıcı listesi bu sıklıkta gönderilir (her bildirimde
    // göndermek büyük ağlarda boşuna bant genişliği harcar).
    onlineIntervalSec: 10,
    // Açık HTTP'ye izin ver. Token her istekte gittiği için YALNIZCA yerel
    // ağda test ederken açın.
    allowInsecure: false,
  },
  limits: {
    maxSessions: 500,
    maxSubscriptionsPerUser: 8,
    packetsPerSecond: 100,
    sessionTimeoutSec: 90,
    registerTimeoutSec: 60,
    maxPayloadBytes: 400,
  },
  /**
   * Reflektorler arasi bag / inter-reflector peer links.
   *
   * Ag genelinde TG'lerin ORTAK olmasini saglar: farkli reflektorlerde ama ayni
   * TG'de olan iki kullanici birbirini duyar. Peer listesi ve her cift icin
   * paylasilan anahtar PANELDEN gelir; isletmeci elle bir sey yapmaz.
   * `static` yalnizca panelsiz test/ozel kurulumlar icindir.
   */
  peers: {
    enabled: true,
    // 'all' = paneldeki tum TG'ler koprulenir. Dizi verilirse yalnizca o
    // numaralar koprulenir (ornek: [9, 286]).
    bridgeTalkgroups: 'all',
    // Ozel (private) TG'ler de koprulenir. Guvenli: dinleyiciler zaten AYNI
    // panelin yetki listesinden geciyor; iki reflektor de ayni politikayi
    // uygular. Kapatmak isteyen operator false yapabilir.
    bridgePrivateTalkgroups: true,
    // Ozel cagrilar (kisi-kisi) da peer'lara iletilir; hedef hangi
    // reflektordeyse orada teslim edilir.
    bridgePrivateCalls: true,
    // Peer basina saniyelik cerceve ust siniri. Bir peer TUM konusmalari
    // aktardigi icin istemci sinirindan cok daha yuksektir.
    packetsPerSecond: 5000,
    // Panelsiz calisan kurulumlar icin elle peer tanimi:
    //   [{ "id": 2, "name": "DVPX-DE", "host": "1.2.3.4", "udpPort": 62071,
    //      "key": "<64 onaltilik karakter>" }]
    static: [],
  },
  logLevel: 'info',
  logCalls: true,
  statsEverySec: 60,
};

const LOG_LEVELS = ['error', 'warn', 'info', 'debug'];

/** Derin birleştirme (yalnızca düz nesneler) / shallow-deep merge for plain objects */
function merge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!override || typeof override !== 'object') {
    return out;
  }
  for (const key of Object.keys(override)) {
    const val = override[key];
    if (val === undefined) {
      continue;
    }
    if (val && typeof val === 'object' && !Array.isArray(val)
        && out[key] && typeof out[key] === 'object' && !Array.isArray(out[key])) {
      out[key] = merge(out[key], val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

function intOrNull(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const n = Number.parseInt(String(value), 10);
  return Number.isFinite(n) ? n : null;
}

function requirePort(value, label) {
  const n = intOrNull(value);
  if (n === null || n < 1 || n > 65535) {
    throw new Error(`config: ${label} 1-65535 arasi bir tam sayi olmali (gelen: ${value}) / `
      + `must be an integer between 1 and 65535`);
  }
  return n;
}

function requirePositive(value, label, fallback) {
  const n = intOrNull(value);
  if (n === null) {
    return fallback;
  }
  if (n < 1) {
    throw new Error(`config: ${label} pozitif bir tam sayi olmali (gelen: ${value}) / must be positive`);
  }
  return n;
}

/** Yerel/özel ağ adresi mi? (açık HTTP yalnızca burada makul) */
function isLocalHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) {
    return true;
  }
  // RFC1918 + bağlantı-yerel
  return /^10\./.test(h)
    || /^192\.168\./.test(h)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(h)
    || /^169\.254\./.test(h);
}

/** Ortam değişkenlerinden kısmi yapılandırma / partial config from env vars */
function fromEnv(env) {
  const cfg = { dashboard: {}, limits: {} };

  if (env.DVPX_SERVER_NAME) cfg.serverName = env.DVPX_SERVER_NAME;
  if (env.DVPX_BIND) cfg.bindAddress = env.DVPX_BIND;
  if (env.DVPX_TCP_PORT) cfg.tcpPort = env.DVPX_TCP_PORT;
  if (env.DVPX_UDP_PORT) cfg.udpPort = env.DVPX_UDP_PORT;
  if (env.DVPX_LOG_LEVEL) cfg.logLevel = env.DVPX_LOG_LEVEL;
  if (env.DVPX_LOG_CALLS) cfg.logCalls = env.DVPX_LOG_CALLS !== '0' && env.DVPX_LOG_CALLS !== 'false';

  // Token'ı dosyaya yazmak istemeyenler için: DVPX_TOKEN=... node src/index.js
  if (env.DVPX_DASHBOARD_URL) cfg.dashboard.url = env.DVPX_DASHBOARD_URL;
  if (env.DVPX_TOKEN) cfg.dashboard.token = env.DVPX_TOKEN;
  if (env.DVPX_ALLOW_INSECURE) {
    cfg.dashboard.allowInsecure = env.DVPX_ALLOW_INSECURE !== '0' && env.DVPX_ALLOW_INSECURE !== 'false';
  }

  if (env.DVPX_MAX_SESSIONS) cfg.limits.maxSessions = env.DVPX_MAX_SESSIONS;
  if (env.DVPX_MAX_SUBS) cfg.limits.maxSubscriptionsPerUser = env.DVPX_MAX_SUBS;
  if (env.DVPX_PPS) cfg.limits.packetsPerSecond = env.DVPX_PPS;
  if (env.DVPX_SESSION_TIMEOUT) cfg.limits.sessionTimeoutSec = env.DVPX_SESSION_TIMEOUT;

  // Reflektorler arasi bagi kapatmak icin: DVPX_PEERS=0
  if (env.DVPX_PEERS !== undefined) {
    cfg.peers = cfg.peers || {};
    cfg.peers.enabled = env.DVPX_PEERS !== '0' && env.DVPX_PEERS !== 'false';
  }

  return cfg;
}

/**
 * Eski (sürüm 1) yapılandırmasını tanır ve ne yapılacağını söyler.
 *
 * Sürüm 1'de config.json içinde bir `database` bloğu vardı. O dosyayla sessizce
 * çalışmaya kalkmak yerine — reflektör artık MySQL'e bağlanmadığı için hiçbir
 * şey yapamaz — operatöre tam olarak neyi değiştirmesi gerektiğini söylüyoruz.
 */
function eskiSurumHatasi() {
  return new Error(
    'config.json ESKI SURUME ait (icinde "database" blogu var).\n\n'
    + '  DVPX 2.0 ile reflektorler veritabanina BAGLANMAZ. Yonetimin tamami\n'
    + '  panelde yapilir ve reflektor panelle bir token uzerinden konusur.\n\n'
    + '  YAPILMASI GEREKEN:\n'
    + '   1. Panele girin → Reflektorler → bu reflektorun satirinda ⚿ butonu.\n'
    + '   2. Panelin gosterdigi config.json icerigini bu dosyaya yazin. Ornek:\n\n'
    + '      {\n'
    + '        "serverName": "DVPX-TR",\n'
    + '        "bindAddress": "0.0.0.0",\n'
    + '        "tcpPort": 62070,\n'
    + '        "udpPort": 62071,\n'
    + '        "dashboard": {\n'
    + '          "url": "https://panel.ornek.com/dvpx/reflector.php",\n'
    + '          "token": "dvpx_..."\n'
    + '        }\n'
    + '      }\n\n'
    + '  Ayrintili anlatim: DVPX/dvpx-reflector/KURULUM.md\n'
    + '  ("database" blogunu silmeniz yeterlidir; baska bir sey degismedi.)\n\n'
    + '  This config.json is from version 1 (it contains a "database" block).\n'
    + '  Reflectors no longer connect to MySQL — replace that block with a\n'
    + '  "dashboard" block containing the URL and the token from the panel.'
  );
}

/**
 * Yapılandırmayı yükler ve doğrular.
 * @param {string} [configPath] config.json yolu (varsayılan: dvpx-reflector/config.json)
 * @returns {object} doğrulanmış yapılandırma
 */
function loadConfig(configPath) {
  const file = configPath || path.join(__dirname, '..', 'config.json');

  let fileCfg = {};
  let usedFile = null;

  if (fs.existsSync(file)) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`config: ${file} okunamadi / could not be read: ${err.message}`);
    }
    try {
      fileCfg = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `config: ${file} gecerli JSON degil / is not valid JSON: ${err.message}\n`
        + '  Ipucu: son satirdan sonra fazla virgul veya eksik " isareti olabilir.'
      );
    }
    if (!fileCfg || typeof fileCfg !== 'object' || Array.isArray(fileCfg)) {
      throw new Error(`config: ${file} bir JSON nesnesi olmali / must be a JSON object`);
    }
    usedFile = file;
  }

  // Sürüm 1 yapılandırması: token yoksa açıkça uyar.
  if (fileCfg.database && !(fileCfg.dashboard && fileCfg.dashboard.token)) {
    throw eskiSurumHatasi();
  }

  let cfg = merge(DEFAULTS, fileCfg);
  cfg = merge(cfg, fromEnv(process.env));

  /* ── Temel alanlar / basics ───────────────────────────────────────────── */
  cfg.serverName = String(cfg.serverName || DEFAULTS.serverName).slice(0, 64);
  cfg.bindAddress = String(cfg.bindAddress || '0.0.0.0');
  cfg.tcpPort = requirePort(cfg.tcpPort, 'tcpPort');
  cfg.udpPort = requirePort(cfg.udpPort, 'udpPort');

  if (cfg.tcpPort === cfg.udpPort) {
    throw new Error('config: tcpPort ve udpPort ayni olamaz / tcpPort and udpPort must differ');
  }

  /* ── Panel bağlantısı / dashboard link ────────────────────────────────── */
  cfg.dashboard = cfg.dashboard || {};
  const url = String(cfg.dashboard.url || '').trim();
  const token = String(cfg.dashboard.token || '').trim();

  if (url === '' || token === '') {
    throw new Error(
      'config: dashboard.url ve dashboard.token ZORUNLUDUR.\n\n'
      + `  Duzenlenecek dosya: ${file}\n\n`
      + '  Bu iki degeri panelden alirsiniz:\n'
      + '    Panel → Reflektorler → ilgili satirda ⚿ butonu\n'
      + '  Panel size dogrudan yapistirilabilir bir config.json gosterir.\n\n'
      + '  Ornek / example:\n'
      + '    "dashboard": {\n'
      + '      "url": "https://panel.ornek.com/dvpx/reflector.php",\n'
      + '      "token": "dvpx_1234567890abcdef..."\n'
      + '    }\n\n'
      + '  Ayrintili anlatim / step-by-step guide: DVPX/dvpx-reflector/KURULUM.md'
    );
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error(
      `config: dashboard.url gecerli bir adres degil / is not a valid URL: ${url}\n`
      + '  Basinda https:// olmali ve sonunda reflector.php bulunmali.\n'
      + '  Ornek: https://panel.ornek.com/dvpx/reflector.php'
    );
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`config: dashboard.url yalnizca http/https olabilir (gelen: ${parsed.protocol})`);
  }

  // Token her istekte gönderilir; açık HTTP'de ağı dinleyen biri okuyabilir.
  // Bu yüzden internet üzerindeki bir panele HTTP ile bağlanmayı açıkça
  // reddediyoruz — sessizce kabul etsek güvenlik sessizce kaybolurdu.
  if (parsed.protocol === 'http:' && !cfg.dashboard.allowInsecure && !isLocalHost(parsed.hostname)) {
    throw new Error(
      `config: dashboard.url acik HTTP kullaniyor (${url}).\n`
      + '  Token her istekte gonderildigi icin bu guvenli DEGILDIR.\n'
      + '  Cozum: adresi https:// ile yazin.\n'
      + '  Yerel agda test ediyorsaniz: "dashboard": { ..., "allowInsecure": true }\n\n'
      + '  The dashboard URL uses plain HTTP. The token travels on every request, '
      + 'so use https:// (or set dashboard.allowInsecure for LAN testing).'
    );
  }

  if (!/\.php(\?|$)/.test(parsed.pathname + parsed.search) && !/\/$/.test(parsed.pathname)) {
    // Engellemiyoruz (bazı kurulumlar güzel adres kullanır), yalnızca
    // en sık yapılan hatayı erken yakalıyoruz.
    process.stderr.write(
      `[config] UYARI: dashboard.url "reflector.php" ile bitmiyor: ${url}\n`
      + '          Panelin Reflektorler sayfasinda dogru adres yazilidir.\n'
    );
  }

  if (token.length < 16) {
    throw new Error(
      `config: dashboard.token cok kisa (${token.length} karakter). `
      + 'Panelden uretilen token "dvpx_" ile baslar ve 45 karakterdir.'
    );
  }

  cfg.dashboard = {
    url,
    token,
    activeIntervalSec: requirePositive(
      cfg.dashboard.activeIntervalSec, 'dashboard.activeIntervalSec', DEFAULTS.dashboard.activeIntervalSec
    ),
    idleIntervalSec: requirePositive(
      cfg.dashboard.idleIntervalSec, 'dashboard.idleIntervalSec', DEFAULTS.dashboard.idleIntervalSec
    ),
    onlineIntervalSec: requirePositive(
      cfg.dashboard.onlineIntervalSec, 'dashboard.onlineIntervalSec', DEFAULTS.dashboard.onlineIntervalSec
    ),
    allowInsecure: cfg.dashboard.allowInsecure === true,
  };

  // Panele saniyede birden çok istek atmak paylaşımlı barındırmayı zorlar.
  if (cfg.dashboard.activeIntervalSec < 1) {
    cfg.dashboard.activeIntervalSec = 1;
  }
  if (cfg.dashboard.idleIntervalSec < cfg.dashboard.activeIntervalSec) {
    cfg.dashboard.idleIntervalSec = cfg.dashboard.activeIntervalSec;
  }
  // Panel bir reflektörü 120 saniye haber alamazsa uygulamalara dağıtmayı
  // keser; bildirim aralığı bunun yakınına çıkmamalı.
  if (cfg.dashboard.idleIntervalSec > 60) {
    cfg.dashboard.idleIntervalSec = 60;
  }

  /* ── Sınırlar / limits ────────────────────────────────────────────────── */
  const L = cfg.limits || {};
  cfg.limits = {
    maxSessions: requirePositive(L.maxSessions, 'limits.maxSessions', DEFAULTS.limits.maxSessions),
    maxSubscriptionsPerUser: requirePositive(
      L.maxSubscriptionsPerUser, 'limits.maxSubscriptionsPerUser', DEFAULTS.limits.maxSubscriptionsPerUser
    ),
    packetsPerSecond: requirePositive(L.packetsPerSecond, 'limits.packetsPerSecond', DEFAULTS.limits.packetsPerSecond),
    sessionTimeoutSec: requirePositive(L.sessionTimeoutSec, 'limits.sessionTimeoutSec', DEFAULTS.limits.sessionTimeoutSec),
    registerTimeoutSec: requirePositive(L.registerTimeoutSec, 'limits.registerTimeoutSec', DEFAULTS.limits.registerTimeoutSec),
    maxPayloadBytes: requirePositive(L.maxPayloadBytes, 'limits.maxPayloadBytes', DEFAULTS.limits.maxPayloadBytes),
  };

  /* ── Reflektorler arasi bag / peer links ──────────────────────────────── */
  const P = cfg.peers || {};
  let kopruTg = P.bridgeTalkgroups;
  if (Array.isArray(kopruTg)) {
    kopruTg = kopruTg.map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0);
    if (!kopruTg.length) {
      throw new Error('config: peers.bridgeTalkgroups dizisi bos — ya "all" yazin '
        + 'ya da gecerli TG numaralari verin / empty array; use "all" or valid TG numbers');
    }
  } else if (kopruTg !== 'all' && kopruTg !== true) {
    // Tanimsiz/bilinmeyen deger varsayilana duser: sessizce kopruyu kapatmak
    // "neden duymuyorum?" sorusuna yol acardi.
    kopruTg = 'all';
  }
  cfg.peers = {
    enabled: P.enabled !== false,
    bridgeTalkgroups: kopruTg,
    bridgePrivateTalkgroups: P.bridgePrivateTalkgroups !== false,
    bridgePrivateCalls: P.bridgePrivateCalls !== false,
    packetsPerSecond: requirePositive(P.packetsPerSecond, 'peers.packetsPerSecond',
      DEFAULTS.peers.packetsPerSecond),
    static: Array.isArray(P.static) ? P.static : [],
  };

  if (!LOG_LEVELS.includes(String(cfg.logLevel))) {
    cfg.logLevel = 'info';
  }
  cfg.logCalls = cfg.logCalls !== false;
  cfg.statsEverySec = requirePositive(cfg.statsEverySec, 'statsEverySec', DEFAULTS.statsEverySec);

  // Sürüm 1'den kalan alanlar sessizce yok sayılır; ama operatör dosyada
  // görünce "çalışıyor" sanmasın diye söylüyoruz.
  if (fileCfg.database) {
    process.stderr.write('[config] UYARI: config.json icindeki "database" blogu KULLANILMIYOR. '
      + 'Silebilirsiniz. / The "database" block is ignored; you may delete it.\n');
  }
  if (fileCfg.serverId !== undefined) {
    process.stderr.write('[config] UYARI: "serverId" artik gereksiz — panel token\'dan cozuyor. '
      + 'Silebilirsiniz. / "serverId" is no longer needed.\n');
  }

  cfg.configFile = usedFile;
  return cfg;
}

module.exports = { loadConfig, DEFAULTS, LOG_LEVELS, isLocalHost };
