'use strict';

/**
 * DVPX Reflector — full-duplex (FDX) cagri kurulum kosumu
 *
 * Sunucu ACMADAN, gercek `sessions.js` ve `tcp-server.js` yuklenerek FDX durum
 * makinesini uctan uca dogrular. En onemlisi REFLEKTORLER ARASI cagri: ozel
 * cagri SESI ag genelinde aktigi icin cagri KURULUMU da ag genelinde olmalidir;
 * aksi halde karsi taraf baska bir reflektore bagliyken davet "NO_TARGET" ile
 * duser ve kullanici "karsi taraf cevrimici degil" gorur.
 *
 * Kullanim / usage:
 *   node tools/fdx-test.js
 *
 * Node yoksa JavaScriptCore ile de kosar (macOS'ta hazir gelir):
 *   /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
 *     tools/fdx-test.js
 *
 * Cikis kodu 0 = hepsi gecti. Zamanlayicilar sahtedir (deterministik), ag ve
 * ses katmani hic devreye girmez.
 */

var NODE = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
var yaz = NODE ? function (s) { process.stdout.write(s + '\n'); } : print;

/* ── Sahte zamanlayici (deterministik) ─────────────────────────────────── */
var _timers = [];
var _seq = 0;
globalThis.setTimeout = function (fn, ms) {
  var t = { id: ++_seq, fn: fn, at: ms, unref: function () {} };
  _timers.push(t);
  return t;
};
globalThis.clearTimeout = function (t) {
  if (!t) return;
  for (var i = 0; i < _timers.length; i++) {
    if (_timers[i] === t || _timers[i].id === t.id) { _timers.splice(i, 1); return; }
  }
};
function zamaniIlerlet() {           // bekleyen tüm zamanlayıcıları tetikle
  var kopya = _timers.slice();
  _timers = [];
  for (var i = 0; i < kopya.length; i++) kopya[i].fn();
}

/* ── Modul yukleme: node'da gercek require, jsc'de sig bir taklit ──────── */
function mkLogger() {
  return { info: function () {}, warn: function () {}, debug: function () {}, error: function () {} };
}

function moduller() {
  if (NODE) {
    return { SES: require('../src/sessions'), TCP: require('../src/tcp-server') };
  }
  // jsc: require/crypto/net yok. FDX yolu hicbirini kullanmadigi icin sig
  // taklitler yeterlidir; kod yine DOSYADAN, oldugu gibi yuklenir.
  var _tok = 0;
  function sahteRequire(ad) {
    if (ad === 'net') return { createServer: function () { return {}; } };
    if (ad === 'crypto') {
      return { randomBytes: function () { return { toString: function () { return 'tok' + (++_tok); } }; } };
    }
    if (ad === './logger') return { createLogger: mkLogger };
    throw new Error('beklenmeyen require: ' + ad);
  }
  function yukle(yol) {
    var module = { exports: {} };
    var fn = new Function('module', 'exports', 'require', '__filename', '__dirname', readFile(yol));
    fn(module, module.exports, sahteRequire, yol, '.');
    return module.exports;
  }
  return { SES: yukle('src/sessions.js'), TCP: yukle('src/tcp-server.js') };
}

var _m = moduller();
var SES = _m.SES;
var TCP = _m.TCP;

/* ── Yardımcılar ───────────────────────────────────────────────────────── */
var cikti = [];   // [{ kim, satir }]
function sahteSoket(ad) {
  return { ad: ad, write: function (s) { cikti.push({ kim: ad, satir: String(s).trim() }); return true; },
           destroyed: false, writable: true, end: function () {}, destroy: function () {} };
}

function reflektorYap(isim) {
  var store = new SES.SessionStore({ maxSessions: 100 });
  var srv = new TCP.TcpServer({ serverName: isim, limits: {} }, {}, store, {});
  srv.isim = isim;
  return srv;
}

/** İki reflektörü peer bağıyla birbirine bağla. */
function baglastir(a, b) {
  function kopru(hedef, kaynak) {
    return { ctrlYayinla: function (satir) { hedef.fdxPeerSatiri(satir, { name: kaynak.isim }); return true; } };
  }
  a.peers = kopru(b, a);
  b.peers = kopru(a, b);
}

function kullaniciEkle(srv, dmrId, cagri) {
  var s = srv.sessions.create(sahteSoket(cagri), '127.0.0.1');
  srv.sessions.attachIdentity(s, { id: dmrId, dmrId: dmrId, callsign: cagri });
  s.registered = true;
  return s;
}

function satirlar(kim) {
  return cikti.filter(function (c) { return c.kim === kim; }).map(function (c) { return c.satir; });
}
function temizle() { cikti = []; }

var gecti = 0, kaldi = 0;
function bekle(ad, kosul, ayrinti) {
  if (kosul) { gecti++; yaz('  ok   ' + ad); }
  else { kaldi++; yaz('  HATA ' + ad + (ayrinti ? '  -> ' + ayrinti : '')); }
}

/* ══ 1) AYNI reflektör — eski davranış bozulmamalı ═════════════════════ */
yaz('1) Ayni reflektor: davet -> kabul -> bitir');
var R1 = reflektorYap('R1');
var A = kullaniciEkle(R1, 111111101, 'TA1AAA');
var B = kullaniciEkle(R1, 222222202, 'TA2BBB');
temizle();
R1.fdxInvite(A, 222222202);
bekle('B calıyor', satirlar('TA2BBB').join('|').indexOf('FDX RING 111111101 TA1AAA') >= 0, satirlar('TA2BBB'));
bekle('A INVITED aldı', satirlar('TA1AAA').join('|').indexOf('FDX INVITED 222222202') >= 0, satirlar('TA1AAA'));
temizle();
R1.fdxAccept(B, 111111101);
bekle('iki tarafa ACCEPTED', satirlar('TA1AAA')[0] === 'FDX ACCEPTED 222222202'
  && satirlar('TA2BBB')[0] === 'FDX ACCEPTED 111111101', JSON.stringify(cikti));
bekle('durumlar active', A.fdxState === 'active' && B.fdxState === 'active');
temizle();
R1.fdxEnd(A, 222222202);
bekle('iki taraf da ENDED', satirlar('TA1AAA')[0] === 'FDX ENDED 222222202'
  && satirlar('TA2BBB')[0] === 'FDX ENDED 111111101', JSON.stringify(cikti));
bekle('durumlar idle', A.fdxState === 'idle' && B.fdxState === 'idle');

/* ══ 2) FARKLI reflektörler — asıl hata buydu ══════════════════════════ */
yaz('2) Farkli reflektorler: davet -> kabul -> bitir');
var X = reflektorYap('X');
var Y = reflektorYap('Y');
baglastir(X, Y);
var C = kullaniciEkle(X, 333333303, 'TA3CCC');
var D = kullaniciEkle(Y, 444444404, 'TA4DDD');
temizle();
X.fdxInvite(C, 444444404);
bekle('D (uzak) caliyor', satirlar('TA4DDD').join('|').indexOf('FDX RING 333333303 TA3CCC') >= 0, satirlar('TA4DDD'));
bekle('C INVITED aldı', satirlar('TA3CCC').join('|').indexOf('FDX INVITED 444444404') >= 0, satirlar('TA3CCC'));
bekle('C NO_TARGET ALMADI', satirlar('TA3CCC').join('|').indexOf('NO_TARGET') < 0, satirlar('TA3CCC'));
zamaniIlerlet();   // NO_TARGET zamanlayıcısı iptal edilmiş olmalı
bekle('zaman asiminda da NO_TARGET yok', satirlar('TA3CCC').join('|').indexOf('NO_TARGET') < 0, satirlar('TA3CCC'));
temizle();
Y.fdxAccept(D, 333333303);
bekle('D ACCEPTED', satirlar('TA4DDD')[0] === 'FDX ACCEPTED 333333303', satirlar('TA4DDD'));
bekle('C ACCEPTED', satirlar('TA3CCC')[0] === 'FDX ACCEPTED 444444404', satirlar('TA3CCC'));
bekle('iki taraf da active', C.fdxState === 'active' && D.fdxState === 'active',
  C.fdxState + '/' + D.fdxState);
temizle();
Y.fdxEnd(D, 333333303);
bekle('D ENDED', satirlar('TA4DDD')[0] === 'FDX ENDED 333333303', satirlar('TA4DDD'));
bekle('C ENDED', satirlar('TA3CCC')[0] === 'FDX ENDED 444444404', satirlar('TA3CCC'));
bekle('iki taraf da idle', C.fdxState === 'idle' && D.fdxState === 'idle');

/* ══ 3) Gerçekten çevrimiçi olmayan hedef ══════════════════════════════ */
yaz('3) Hedef agin hicbir yerinde degil -> NO_TARGET');
temizle();
X.fdxInvite(C, 999999909);
bekle('hemen NO_TARGET yok (once soruluyor)', satirlar('TA3CCC').join('|').indexOf('NO_TARGET') < 0, satirlar('TA3CCC'));
zamaniIlerlet();
bekle('pencere sonunda NO_TARGET', satirlar('TA3CCC').join('|').indexOf('FDX FAIL NO_TARGET') >= 0, satirlar('TA3CCC'));
bekle('arayan idle', C.fdxState === 'idle', C.fdxState);

/* ══ 4) Uzak ret ═══════════════════════════════════════════════════════ */
yaz('4) Uzak taraf reddederse');
temizle();
X.fdxInvite(C, 444444404);
Y.fdxReject(D, 333333303);
bekle('C REJECTED aldı', satirlar('TA3CCC').join('|').indexOf('FDX REJECTED 444444404') >= 0, satirlar('TA3CCC'));
bekle('iki taraf idle', C.fdxState === 'idle' && D.fdxState === 'idle', C.fdxState + '/' + D.fdxState);

/* ══ 5) Uzak taraf mesgul ══════════════════════════════════════════════ */
yaz('5) Uzak taraf mesgulse BUSY');
var E = kullaniciEkle(Y, 555555505, 'TA5EEE');
D.fdxState = 'active'; D.fdxPeer = 777; D.fdxRemote = false;   // D baska bir cagrida
temizle();
X.fdxInvite(C, 444444404);
bekle('C BUSY aldı', satirlar('TA3CCC').join('|').indexOf('FDX FAIL BUSY') >= 0, satirlar('TA3CCC'));
bekle('arayan idle', C.fdxState === 'idle', C.fdxState);
D.fdxState = 'idle'; D.fdxPeer = 0;

/* ══ 6) Uzak taraf uygulamayi kapatirsa ════════════════════════════════ */
yaz('6) Uzak taraf koparsa diger uc haberdar olur');
temizle();
X.fdxInvite(C, 444444404);
Y.fdxAccept(D, 333333303);
temizle();
Y.fdxTemizle(D);          // bağlantı koptu
bekle('C ENDED aldı', satirlar('TA3CCC').join('|').indexOf('FDX ENDED 444444404') >= 0, satirlar('TA3CCC'));
bekle('C idle', C.fdxState === 'idle', C.fdxState);

/* ══ 7) ESSID toleransı (byBaseDmrId) ══════════════════════════════════ */
yaz('7) ESSID: hedef -18 ile arandı ama kisi -01 ile bagli');
var F = kullaniciEkle(X, 666666601, 'TA6FFF');
bekle('tam kimlik bulunur', X.fdxHedefBul(666666601) === F);
bekle('taban kimlik bulunur', X.fdxHedefBul(6666666) === F);
bekle('BASKA ESSID de bulunur', X.fdxHedefBul(666666618) === F,
  String(X.fdxHedefBul(666666618) && X.fdxHedefBul(666666618).dmrId));
bekle('alakasiz kimlik bulunmaz', X.fdxHedefBul(123456701) === null);

/* ══ 8) Kendine cagri ══════════════════════════════════════════════════ */
yaz('8) Kendine cagri (taban kimlikle bile) SELF');
temizle();
X.fdxInvite(F, 6666666);
bekle('SELF', satirlar('TA6FFF').join('|').indexOf('FDX FAIL SELF') >= 0, satirlar('TA6FFF'));

/* ══ 9) Uzak cagri TABAN kimlikle baslatilirsa ═════════════════════════ */
yaz('9) Uzak hedef TABAN kimlikle (7 hane) aranir');
temizle();
X.fdxInvite(C, 4444444);          // D aslinda 444444404
bekle('D yine caliyor', satirlar('TA4DDD').join('|').indexOf('FDX RING 333333303') >= 0, satirlar('TA4DDD'));
bekle('C, TAM kimlikle INVITED aldı',
  satirlar('TA3CCC').join('|').indexOf('FDX INVITED 444444404') >= 0, satirlar('TA3CCC'));
bekle('arayanin hedefi tam kimlige sabitlendi', C.fdxPeer === 444444404, String(C.fdxPeer));
temizle();
Y.fdxAccept(D, 333333303);
bekle('cagri kuruldu', C.fdxState === 'active' && D.fdxState === 'active',
  C.fdxState + '/' + D.fdxState);
X.fdxEnd(C, 444444404);
bekle('kapandi', C.fdxState === 'idle' && D.fdxState === 'idle');

/* ══ 10) Ayni kisinin IKI cihazi IKI reflektorde ═══════════════════════ */
yaz('10) Ikinci reflektor gec RINGING yollarsa iptal edilir');
temizle();
X.fdxInvite(C, 444444404);
bekle('ilk sahiplenen kazandi', C.fdxState === 'inviting' && C.fdxRemoteTimer === null);
// Gecikmis ikinci bir RINGING (baska bir reflektordeki ikinci cihaz):
var oncekiD = satirlar('TA4DDD').length;
X.fdxPeerSatiri('FDX RINGING 444444455 333333303', { name: 'Z' });
bekle('gec gelen RINGING C icin INVITED uretmedi',
  satirlar('TA3CCC').filter(function (s) { return s.indexOf('INVITED') === 0 || s.indexOf('FDX INVITED') === 0; }).length === 1,
  satirlar('TA3CCC'));
bekle('C hala ilk hedefe bagli', C.fdxPeer === 444444404, String(C.fdxPeer));
X.fdxEnd(C, 444444404);

yaz('');
yaz('SONUC: ' + gecti + ' gecti, ' + kaldi + ' kaldi');
if (kaldi > 0) {
  if (NODE) { process.exit(1); }
  throw new Error('TESTLER BASARISIZ');
}
