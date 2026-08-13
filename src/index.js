'use strict';

/**
 * DVPX Reflector — giriş noktası / entry point
 *
 *   node src/index.js [config.json yolu]
 *
 * Görevler:
 *   - yapılandırmayı yükle ve doğrula
 *   - DVPX paneline bağlan, politikayı al (VERİTABANI YOKTUR)
 *   - TCP sinyalleşme + UDP ses sunucularını başlat
 *   - periyodik bakım (zaman aşımı süpürme, çevrimiçi liste, istatistik)
 *   - panelden gelen politika değişikliklerini ANINDA uygula
 *   - SIGINT/SIGTERM ile düzgün kapanış
 *
 * Yakalanmayan hiçbir istisna süreci düşürmez: process düzeyinde son savunma
 * hattı kuruludur, çünkü tek bir bozuk pakete 3000+ kullanıcının sesi feda
 * edilemez.
 */

const { loadConfig } = require('./config');
const { createLogger, setLevel } = require('./logger');
const { Control, baseDmrId, setAgentVersion } = require('./control');
const { SessionStore } = require('./sessions');
const { TcpServer } = require('./tcp-server');
const { UdpServer } = require('./udp-server');
const { PeerManager } = require('./peers');

const log = createLogger('main');

/**
 * Reflektör sürümü — TEK KAYNAK BURASIDIR.
 *
 * Banner, `--version` çıktısı ve panele bildirilen sürüm hep bunu okur.
 * Yükseltirken yalnızca bu satır değiştirilir.
 */
const SURUM = '1.0.7';

// Panele bildirilecek sürüm de buradan beslenir: paneldeki Reflektörler
// tablosunda her bildirimde tazelenir (bkz. control.setAgentVersion).
setAgentVersion(SURUM);

const BANNER = [
  '',
  '  ██████  ██    ██ ██████  ██   ██   DVPX Reflector',
  '  ██   ██ ██    ██ ██   ██  ██ ██    Digi Voice Protocol eXtended',
  '  ██   ██ ██    ██ ██████    ███     TCP signalling + UDP voice',
  `  ██   ██  ██  ██  ██       ██ ██    version ${SURUM}`,
  '  ██████    ████   ██      ██   ██   −·· ···− ·−· −··−',
  '',
].join('\n');

let state = {
  cfg: null,
  control: null,
  sessions: null,
  tcp: null,
  udp: null,
  peers: null,
  maintenanceTimer: null,
  statsTimer: null,
  shuttingDown: false,
};

/**
 * Panelden gelen yeni politikayı BAĞLI oturumlara uygular.
 *
 * Politika yalnızca yeni girişleri değil, HÂLİHAZIRDA bağlı olanları da
 * bağlar. Aksi halde:
 *   • panelden engellenen kişi bağlantısı kopana kadar konuşmaya devam eder,
 *   • kapatılan bir TG'de konuşma sürer,
 *   • özel TG yetkisi geri alınan kişi grubu dinlemeye devam eder.
 * Üçü de "panelden yönetiyorum" beklentisini boşa çıkarırdı.
 */
function applyPolicyToSessions(control) {
  // Reflektorler arasi bag listesi de politikanin parcasidir: panelde yeni bir
  // reflektor onaylandigi an bag KENDILIGINDEN kurulur, servis yeniden
  // baslatilmaz. (Peer listesi oturumlardan bagimsiz oldugu icin asagidaki
  // erken cikistan ONCE uygulanir.)
  if (state.peers) {
    state.peers.setSelfId(control.serverId);
    state.peers.setPeers(peerListesi(state.cfg, control));
  }

  const sessions = state.sessions;
  const tcp = state.tcp;
  if (!sessions || !tcp) {
    return;   // henüz başlamadık; politika ilk girişte zaten geçerli olacak
  }

  // Panel sunucuyu yeniden adlandırdıysa el sıkışma yanıtı da güncellensin.
  if (control.serverName && control.serverName !== state.cfg.serverName) {
    log.info(`sunucu adi panelden guncellendi: ${state.cfg.serverName} → ${control.serverName}`);
    state.cfg.serverName = control.serverName;
  }

  let kicked = 0;
  let dropped = 0;

  for (const session of sessions.all()) {
    if (!session.loggedIn || !session.dmrId) {
      continue;
    }

    // 1) Engellenen kullanıcı: anında düşür.
    if (control.blocked.has(baseDmrId(session.dmrId))) {
      tcp.kick(session, 'BLOCKED');
      kicked += 1;
      continue;
    }

    // 2) Artık abonelenemeyecek TG'ler: aboneliği iptal et ve istemciye bildir.
    for (const tg of Array.from(session.subscriptions)) {
      const info = control.talkgroups.get(tg);
      const izinli = !!info
        && info.isActive
        && (!info.isPrivate || control.mayUsePrivateTg(session.dmrId, tg));
      if (!izinli) {
        sessions.unsubscribe(session, tg);
        tcp.notifyUnsubscribed(session, tg);
        dropped += 1;
      }
    }
  }

  if (kicked || dropped) {
    log.info(`politika uygulandi: ${kicked} oturum dusuruldu, ${dropped} abonelik iptal edildi`);
  }
}

/**
 * Etkin peer listesi = panelden gelenler + config.json'daki statik tanimlar.
 *
 * Statik liste panelsiz kurulumlar ve test icindir; ayni kimlik iki yerde
 * varsa PANEL kazanir (tek gercek kaynak paneldir).
 */
function peerListesi(cfg, control) {
  const panelden = (control && Array.isArray(control.peers)) ? control.peers : [];
  const gorulen = new Set(panelden.map((p) => Number(p.id)));
  const statik = (cfg.peers.static || []).filter((p) => !gorulen.has(Number(p && p.id)));
  return panelden.concat(statik);
}

/**
 * Panel token'ı reddettiğinde (iptal/onay kaldırma) çağrılır.
 *
 * Bu GEÇİCİ BİR AĞ HATASI DEĞİLDİR — panel bizi açıkça tanımıyor. Ağdan
 * çıkarılmanın yolu budur, dolayısıyla bağlı herkesi düşürüyoruz.
 */
function applyLock(locked, reason) {
  if (!locked || !state.tcp || !state.sessions) {
    return;
  }
  const list = state.sessions.all();
  for (const session of list) {
    state.tcp.kick(session, 'SERVER_SHUTDOWN');
  }
  if (list.length) {
    log.error(`${list.length} oturum dusuruldu — reflektor kilitli (${reason})`);
  }
}

/**
 * Komut satırı bayrakları — YAPILANDIRMA OKUNMADAN ÖNCE işlenir.
 *
 * Sürümü sormak, çalışan bir kuruluma ihtiyaç duymamalı: `config.json` bozuksa
 * ya da hiç yoksa bile `-v` yanıt vermelidir. Bu yüzden `loadConfig`'ten önce
 * çağrılır ve çıktı tek satırdır (betikten `$(...)` ile okunabilsin).
 *
 * @returns {boolean} true ise istek karşılandı, süreç sonlanmalıdır
 */
function bayraklariIsle(argv) {
  const arg = String(argv[2] || '').toLowerCase();

  if (arg === '-v' || arg === '--version' || arg === 'version') {
    process.stdout.write(`${SURUM}\n`);
    return true;
  }

  if (arg === '-h' || arg === '--help' || arg === 'help') {
    process.stdout.write([
      `DVPX Reflector ${SURUM}`,
      '',
      'Kullanim / usage:',
      '  node src/index.js [config.json]   reflektoru baslat',
      '  node src/index.js -v              surumu yaz (yalnizca numara)',
      '  node src/index.js -h              bu yardim',
      '',
    ].join('\n'));
    return true;
  }

  return false;
}

async function main() {
  if (bayraklariIsle(process.argv)) {
    return;
  }

  const configPath = process.argv[2] || undefined;

  let cfg;
  try {
    cfg = loadConfig(configPath);
  } catch (err) {
    process.stderr.write(`\n[FATAL] ${err.message}\n\n`);
    process.exit(1);
    return;
  }

  setLevel(cfg.logLevel);
  state.cfg = cfg;

  process.stdout.write(BANNER + '\n');
  // Sürüm günlüğe de yazılır: uzak bir reflektörde sorun ararken `journalctl`
  // çıktısı çoğu zaman elimizdeki tek şeydir, banner ise servis yeniden
  // başlatılmadan görünmez.
  log.info(`version: ${SURUM}`);
  log.info(`server name: ${cfg.serverName}`);
  log.info(`config file: ${cfg.configFile || '(defaults + env)'}`);
  log.info(`limits: ${cfg.limits.maxSessions} sessions, ${cfg.limits.maxSubscriptionsPerUser} TG/user, `
    + `${cfg.limits.packetsPerSecond} pkt/s, ${cfg.limits.sessionTimeoutSec}s timeout`);

  /* ── Kontrol katmanı (panel) ─────────────────────────────────────────────
   * Reflektörün tek dış bağımlılığı budur. Veritabanı YOKTUR.
   * ─────────────────────────────────────────────────────────────────────── */
  const control = new Control(cfg);
  control.onPolicy = applyPolicyToSessions;
  control.onLockChange = applyLock;

  try {
    await control.init();
  } catch (err) {
    log.error('════════════════════════════════════════════════════════════');
    log.error('PANEL BAGLANTISI KURULAMADI / CANNOT REACH THE DASHBOARD');
    log.error('════════════════════════════════════════════════════════════');
    process.stderr.write(`\n${err.message}\n\n`);
    process.exit(2);
    return;
  }
  state.control = control;

  if (control.serverName) {
    cfg.serverName = control.serverName;
  }
  if (control.serverInfo) {
    log.info(`panel: #${control.serverId} "${control.serverName}" `
      + `(${control.serverInfo.published ? 'uygulamalara dagitiliyor' : 'DAGITILMIYOR'})`);
  }

  /* ── Oturum deposu ──────────────────────────────────────────────────────── */
  const sessions = new SessionStore(cfg.limits);
  state.sessions = sessions;

  /* ── UDP (ses) — TCP'den önce açılır, böylece login olan istemci hemen
        REGISTER gönderebilir ─────────────────────────────────────────────── */
  const udp = new UdpServer(cfg, control, sessions);
  try {
    await udp.listen();
  } catch (err) {
    log.error(`cannot bind UDP ${cfg.bindAddress}:${cfg.udpPort}: ${err.message}`);
    await control.close();
    process.exit(3);
    return;
  }
  state.udp = udp;

  /* ── Reflektorler arasi bag / peer links ────────────────────────────────
   * TG'ler ag genelinde ortaktir: farkli reflektorlerdeki iki kullanici ayni
   * TG'de ise birbirini duyar. Peer cerceveleri ses portunu paylasir ('D','X'
   * sihirli baytlari) ve HMAC ile imzalanir; anahtarlar panelden gelir.
   * ──────────────────────────────────────────────────────────────────────── */
  const peers = new PeerManager(cfg, {
    gonder: (buf, port, host) => udp.sendRaw(buf, port, host),
    sesGeldi: (inner, header, peer) => udp.deliverFromPeer(inner, header, peer),
    // FDX çağrı kurulumu ağ genelindedir; TCP sunucusu HENÜZ yaratılmadığı
    // için state üzerinden geç bağlanıyoruz.
    ctrlGeldi: (satir, peer) => {
      if (state.tcp) {
        state.tcp.fdxPeerSatiri(satir, peer);
      }
    },
  });
  peers.setSelfId(control.serverId);
  peers.setPeers(peerListesi(cfg, control));
  udp.peers = peers;
  state.peers = peers;
  if (cfg.peers.enabled) {
    peers.start();
    log.info(`reflektorler arasi bag: ${peers.ozet()}`);
  } else {
    log.warn('reflektorler arasi bag KAPALI (peers.enabled=false) — '
      + 'diger reflektorlerdeki ayni TG duyulmaz');
  }

  /* ── TCP (sinyalleşme) ──────────────────────────────────────────────────── */
  const tcp = new TcpServer(cfg, control, sessions, {
    // Bağlantı yayın ortasında koptuysa çağrı kaydını tamamla.
    onSessionClosed: (session) => {
      if (session.txActive) {
        udp.finishTransmission(session, Date.now());
      }
    },
  });
  // FDX daveti hedefi yerelde bulamazsa peer bağı üzerinden sorulur.
  tcp.peers = peers;
  try {
    await tcp.listen();
  } catch (err) {
    log.error(`cannot bind TCP ${cfg.bindAddress}:${cfg.tcpPort}: ${err.message}`);
    await udp.close();
    await control.close();
    process.exit(4);
    return;
  }
  state.tcp = tcp;

  /* ── Periyodik bakım ────────────────────────────────────────────────────── */
  state.maintenanceTimer = setInterval(() => {
    try {
      const reaped = tcp.reapExpired();
      if (reaped) {
        log.debug(`reaped ${reaped} expired session(s)`);
      }
      // Çevrimiçi kullanıcı listesini bir sonraki bildirime hazırla —
      // uygulamalar özel çağrı hedefini bağlanmadan önce panelden seçer
      // (api.php?action=online).
      control.publishOnline(sessions.onlineSummary()).catch(() => { /* control loglar */ });
    } catch (err) {
      log.warn(`maintenance tick error: ${err.message}`);
    }
  }, 10000);
  state.maintenanceTimer.unref?.();

  state.statsTimer = setInterval(() => {
    try {
      const s = sessions.stats();
      const u = udp.stats;
      log.info(
        `stats — sessions ${s.sessions} (login ${s.loggedIn}, udp ${s.registered}), `
        + `TG ${s.talkgroups} | rx ${u.received} fwd ${u.forwarded} drop ${u.dropped} `
        + `(bad ${u.malformed}, nosess ${u.unregistered}, ep ${u.endpointMismatch}, `
        + `nosub ${u.notSubscribed}, flood ${u.floodLimited}) | `
        + `${peers.ozet()} peerIn ${u.peerIn}`
      );
    } catch (err) {
      log.warn(`stats tick error: ${err.message}`);
    }
  }, cfg.statsEverySec * 1000);
  state.statsTimer.unref?.();

  /* ══════════════════════════════════════════════════════════════════════════
   * ÖZ DENETİM — "sorunsuz çalışıyorum" bildirimi
   *
   * Panel her bildirimde `last_seen` tazeler ama bu yalnızca AYAKTA MI sorusunu
   * cevaplar. Ayakta olan bir reflektör pekâlâ bozuk olabilir: UDP soketi
   * düşmüş, panel kilidi devreye girmiş, ses paketleri gönderilemiyor olabilir.
   * Bu yüzden reflektör kendi durumunu da bildirir.
   *
   * ÜÇ İLKE:
   *
   *  1. YALNIZCA GERÇEKTEN BİLDİĞİMİZİ söyleriz. Her koşul ölçülebilir bir
   *     durumdan gelir (soket var mı, kilit açık mı, sayaç arttı mı) — tahmin
   *     yok.
   *
   *  2. Sayaçlarda TOPLAM DEĞİL FARK kullanılır. Kümülatif sayaç bir kez
   *     bozulduğunda sonsuza dek "sorunlu" gösterirdi; oysa merak edilen ŞU AN
   *     sorun olup olmadığıdır. Bu yüzden son turdaki değerleri saklayıp
   *     aradaki değişime bakıyoruz.
   *
   *  3. Şüphedeyken "ok" DEMEYİZ. Denetimin kendisi patlarsa alan hiç
   *     gönderilmez ve panel "bilinmiyor" der (bkz. control.js → healthFields).
   * ══════════════════════════════════════════════════════════════════════════ */
  let oncekiUdp = null;   // son denetimdeki udp.stats anlık kopyası

  control.setHealthProbe(() => {
    const notlar = [];
    let durum = 'ok';

    // ── Ölümcül koşullar: bunlar varsa reflektör iş görmüyor ──────────────
    if (!state.tcp) {
      durum = 'error';
      notlar.push('TCP dinlemiyor');
    }
    if (!state.udp) {
      durum = 'error';
      notlar.push('UDP dinlemiyor');
    }
    if (control.locked) {
      durum = 'error';
      notlar.push(`panel kilidi devrede${control.lockReason ? ': ' + control.lockReason : ''}`);
    }

    // ── Uyarı düzeyi: çalışıyor ama bir şey ters ──────────────────────────
    const u = (state.udp && state.udp.stats) ? state.udp.stats : null;
    if (u) {
      if (oncekiUdp) {
        const dSend = u.sendErrors - oncekiUdp.sendErrors;
        const dFwd  = u.forwarded  - oncekiUdp.forwarded;
        const dDrop = u.dropped    - oncekiUdp.dropped;

        // Gönderim hatası: ses karşı tarafa ÇIKMIYOR demektir, en ciddi uyarı.
        if (dSend > 0) {
          durum = (durum === 'error') ? durum : 'warn';
          notlar.push(`${dSend} UDP gonderim hatasi`);
        }
        // Yüksek düşme oranı. Eşiği yüzde 10'da tutuyoruz: her ağda birkaç
        // paket düşer, onu sorun saymak uyarıyı anlamsızlaştırır.
        if (dDrop > 0 && dFwd >= 0 && dDrop > Math.max(20, dFwd / 10)) {
          durum = (durum === 'error') ? durum : 'warn';
          notlar.push(`yuksek paket dusme (${dDrop}/${dFwd + dDrop})`);
        }
      }
      oncekiUdp = Object.assign({}, u);
    }

    // Reflektörler arası bağ AÇIK ama hiçbir eş ayakta değilse: TG'ler ağ
    // genelinde ortak olmaz. Reflektör çalışır, ağ bölünür — uyarı şart.
    if (cfg.peers && cfg.peers.enabled && peers) {
      try {
        const ozet = peers.ozet();
        if (/peers 0|peers: 0/.test(ozet)) {
          durum = (durum === 'error') ? durum : 'warn';
          notlar.push('reflektorler arasi bag yok');
        } else if (ozet.indexOf('(DOWN)') !== -1) {
          durum = (durum === 'error') ? durum : 'warn';
          notlar.push('bazi reflektor baglari kopuk');
        }
      } catch (err) { /* ozet patlarsa bag hakkinda bir sey soylemiyoruz */ }
    }

    if (durum === 'ok') {
      notlar.push('TCP/UDP dinliyor, panel baglantisi saglam');
    }

    return {
      state: durum,
      note: notlar.join('; '),
      uptimeSec: Math.round(process.uptime()),
    };
  });

  log.info('DVPX reflector is ready. 73!');
}

/* ── Düzgün kapanış / graceful shutdown ─────────────────────────────────── */
async function shutdown(signal) {
  if (state.shuttingDown) {
    return;
  }
  state.shuttingDown = true;
  log.info(`${signal} received, shutting down...`);

  if (state.maintenanceTimer) clearInterval(state.maintenanceTimer);
  if (state.statsTimer) clearInterval(state.statsTimer);
  if (state.peers) state.peers.stop();

  // Yayında olan oturumların çağrı kayıtlarını tamamla (kapanış bildiriminden
  // ÖNCE: kuyruğa girsinler de son turda panele gitsinler).
  if (state.sessions && state.udp) {
    for (const session of state.sessions.all()) {
      if (session.txActive) {
        try {
          state.udp.finishTransmission(session, Date.now());
        } catch (err) {
          log.warn(`tx finalise error for ${session.label}: ${err.message}`);
        }
      }
    }
  }

  try {
    if (state.tcp) await state.tcp.close();
  } catch (err) {
    log.warn(`tcp close error: ${err.message}`);
  }
  try {
    if (state.udp) await state.udp.close();
  } catch (err) {
    log.warn(`udp close error: ${err.message}`);
  }
  // En son panel: çevrimiçi listeyi boşaltır, bekleyen kayıtları yazdırır.
  // Böylece reflektör kapalıyken panelde "hayalet kullanıcı" kalmaz.
  try {
    if (state.control) await state.control.close();
  } catch (err) {
    log.warn(`control close error: ${err.message}`);
  }

  log.info('bye. 73!');
  process.exit(0);
}

process.on('SIGINT', () => { shutdown('SIGINT'); });
process.on('SIGTERM', () => { shutdown('SIGTERM'); });

/* ── Son savunma hattı / last line of defence ───────────────────────────── */
process.on('uncaughtException', (err) => {
  log.error(`uncaught exception: ${err && err.stack ? err.stack : err}`);
  // Süreci ayakta tutuyoruz: bir istemcinin bozuk paketi tüm ağın sesini kesmesin.
});

process.on('unhandledRejection', (reason) => {
  log.error(`unhandled rejection: ${reason && reason.stack ? reason.stack : reason}`);
});

main().catch((err) => {
  log.error(`startup failed: ${err && err.stack ? err.stack : err}`);
  process.exit(10);
});
