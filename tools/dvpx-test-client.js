'use strict';

/**
 * DVPX Reflector — bağımsız test istemcisi / standalone test client
 *
 * Digi Voice uygulamasına hiç dokunmadan reflektörü uçtan uca doğrular:
 * TCP login → REGISTER → SUBSCRIBE → PTT_ON + sahte Opus çerçeveleri → PTT_OFF
 * ve gelen paketleri sayar.
 *
 * Kullanım / usage:
 *   node tools/dvpx-test-client.js --host 127.0.0.1 --id 2861001 --call TA1ABC --tg 9
 *
 * Seçenekler / options:
 *   --host <adres>     reflektör adresi (varsayılan 127.0.0.1)
 *   --tcp  <port>      TCP portu (varsayılan 62070)
 *   --udp  <port>      UDP portu (varsayılan 62071)
 *   --id   <dmrId>     DMR ID (zorunlu)
 *   --call <çağrı>     çağrı işareti (zorunlu) — DVPX'te şifre yoktur
 *   --tg   <numara>    abone olunacak TG (varsayılan 9)
 *   --talk <saniye>    kaç saniye sahte ses gönderilecek (varsayılan 0 = yalnızca dinle)
 *   --private <dmrId>  TG yerine bu ID'ye özel çağrı yap
 *
 * İki terminalde iki farklı DMR ID ile çalıştırıp birinde --talk 3 verirseniz,
 * diğerinde gelen çerçeve sayacının arttığını görmelisiniz.
 */

const net = require('net');
const dgram = require('dgram');

const HEADER_LEN = 16;
const CALL_TG = 0;
const CALL_PRIVATE = 1;
const PT_VOICE = 0;
const PT_PTT_ON = 1;
const PT_PTT_OFF = 2;
const PT_REGISTER = 3;

/* ── Argümanlar / arguments ─────────────────────────────────────────────── */
function parseArgs(argv) {
  const out = {
    host: '127.0.0.1',
    tcp: 62070,
    udp: 62071,
    id: 0,
    call: '',
    tg: 9,
    talk: 0,
    private: 0,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const val = argv[i + 1];
    switch (key) {
      case '--host': out.host = String(val); i += 1; break;
      case '--tcp': out.tcp = Number.parseInt(val, 10); i += 1; break;
      case '--udp': out.udp = Number.parseInt(val, 10); i += 1; break;
      case '--id': out.id = Number.parseInt(val, 10); i += 1; break;
      case '--call': out.call = String(val).toUpperCase(); i += 1; break;
      case '--tg': out.tg = Number.parseInt(val, 10); i += 1; break;
      case '--talk': out.talk = Number.parseFloat(val); i += 1; break;
      case '--private': out.private = Number.parseInt(val, 10); i += 1; break;
      default:
        process.stderr.write(`unknown option: ${key}\n`);
        process.exit(64);
    }
  }
  return out;
}

const args = parseArgs(process.argv);

if (!Number.isFinite(args.id) || args.id < 1 || args.call === '') {
  process.stderr.write('--id ve --call zorunlu. / --id and --call are required.\n');
  process.exit(64);
}

function stamp() {
  return new Date().toISOString().slice(11, 23);
}

function say(msg) {
  process.stdout.write(`${stamp()} ${msg}\n`);
}

/* ── Paket üretici / packet builder ─────────────────────────────────────── */
function buildPacket(callType, packetType, sourceId, targetId, seqNum, payload) {
  const body = payload || Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(HEADER_LEN + body.length);
  buf[0] = 0x44; // 'D'
  buf[1] = 0x56; // 'V'
  buf[2] = callType;
  buf[3] = packetType;
  buf.writeUInt32BE(sourceId >>> 0, 4);
  buf.writeUInt32BE(targetId >>> 0, 8);
  buf.writeUInt16BE(seqNum & 0xffff, 12);
  buf.writeUInt16BE(body.length & 0xffff, 14);
  if (body.length) {
    body.copy(buf, HEADER_LEN);
  }
  return buf;
}

function parsePacket(buf) {
  if (buf.length < HEADER_LEN || buf[0] !== 0x44 || buf[1] !== 0x56) {
    return null;
  }
  return {
    callType: buf[2],
    packetType: buf[3],
    sourceId: buf.readUInt32BE(4),
    targetId: buf.readUInt32BE(8),
    seqNum: buf.readUInt16BE(12),
    payloadLen: buf.readUInt16BE(14),
  };
}

/* ── Durum / state ──────────────────────────────────────────────────────── */
const state = {
  token: '',
  callsign: '',
  seq: 0,
  rx: { voice: 0, pttOn: 0, pttOff: 0, register: 0, bytes: 0 },
  registerTimer: null,
  pingTimer: null,
  talkTimer: null,
  closing: false,
};

const udp = dgram.createSocket('udp4');

udp.on('error', (err) => {
  say(`UDP hatası / error: ${err.message}`);
});

udp.on('message', (msg, rinfo) => {
  const h = parsePacket(msg);
  if (!h) {
    say(`⚠ bozuk paket / malformed packet from ${rinfo.address}:${rinfo.port} (${msg.length}b)`);
    return;
  }
  state.rx.bytes += msg.length;
  if (h.packetType === PT_REGISTER) {
    state.rx.register += 1;
    say(`← REGISTER ACK (kayıt onaylandı / endpoint confirmed)`);
    return;
  }
  if (h.packetType === PT_PTT_ON) {
    state.rx.pttOn += 1;
    say(`← PTT_ON  from ${h.sourceId} → ${h.callType === CALL_PRIVATE ? 'private' : 'TG'} ${h.targetId}`);
    return;
  }
  if (h.packetType === PT_PTT_OFF) {
    state.rx.pttOff += 1;
    say(`← PTT_OFF from ${h.sourceId} (toplam ${state.rx.voice} ses çerçevesi / voice frames)`);
    return;
  }
  state.rx.voice += 1;
  if (state.rx.voice % 25 === 0) {
    say(`← ${state.rx.voice} ses çerçevesi / voice frames (son seq ${h.seqNum}, ${h.payloadLen}b)`);
  }
});

/* ── TCP sinyalleşme / signalling ───────────────────────────────────────── */
const socket = net.createConnection({ host: args.host, port: args.tcp }, () => {
  say(`TCP bağlandı / connected ${args.host}:${args.tcp}`);
  socket.write('DVPX 1\n');
});

let buffer = '';

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let idx = buffer.indexOf('\n');
  while (idx !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (line !== '') {
      handleLine(line);
    }
    idx = buffer.indexOf('\n');
  }
});

socket.on('error', (err) => {
  say(`TCP hatası / error: ${err.message}`);
});

socket.on('close', () => {
  say('TCP kapandı / closed');
  finish(0);
});

function handleLine(line) {
  const parts = line.split(/\s+/);
  const head = parts[0].toUpperCase();

  if (head === 'DVPX' && parts[2] === 'OK') {
    say(`← el sıkışma / handshake ok, sunucu: ${parts.slice(3).join(' ')}`);
    say(`→ LOGIN ${args.id}`);
    socket.write(`LOGIN ${args.id} ${args.call}\n`);
    return;
  }

  if (head === 'LOGIN' && parts[1] === 'OK') {
    state.callsign = parts[3] || '';
    state.token = parts[4] || '';
    say(`← LOGIN OK — ${state.callsign} (jeton/token ${state.token.slice(0, 8)}…)`);
    startRegister();
    say(`→ SUBSCRIBE ${args.tg}`);
    socket.write(`SUBSCRIBE ${args.tg}\n`);
    state.pingTimer = setInterval(() => {
      socket.write('PING\n');
    }, 30000);
    return;
  }

  if (head === 'LOGIN' && parts[1] === 'FAIL') {
    say(`← LOGIN BAŞARISIZ / FAILED: ${parts[2]}`);
    finish(1);
    return;
  }

  if (head === 'SUBSCRIBE' && parts[1] === 'OK') {
    say(`← SUBSCRIBE OK — TG ${parts[2]} (${parts.slice(3).join(' ')})`);
    if (args.talk > 0) {
      setTimeout(startTalking, 1000);
    } else {
      say('Dinleme modunda / listening. Çıkmak için Ctrl+C.');
    }
    return;
  }

  if (head === 'SUBSCRIBE' && parts[1] === 'FAIL') {
    say(`← SUBSCRIBE BAŞARISIZ / FAILED: ${parts[2]}`);
    return;
  }

  if (head === 'PONG') {
    return;
  }

  say(`← ${line}`);

  if (head === 'ERR') {
    if (parts[1] === 'SESSION_REPLACED' || parts[1] === 'SERVER_SHUTDOWN' || parts[1] === 'TIMEOUT') {
      finish(1);
    }
  }
}

/** REGISTER paketini periyodik gönder (NAT eşlemesini canlı tutar). */
function startRegister() {
  const sendRegister = () => {
    const pkt = buildPacket(CALL_TG, PT_REGISTER, args.id, 0, 0, Buffer.from(state.token, 'ascii'));
    udp.send(pkt, args.udp, args.host, (err) => {
      if (err) {
        say(`REGISTER gönderilemedi / send failed: ${err.message}`);
      }
    });
  };
  sendRegister();
  say(`→ REGISTER (UDP ${args.host}:${args.udp})`);
  state.registerTimer = setInterval(sendRegister, 20000);
}

/** Sahte "Opus" çerçeveleri gönder — sunucu içeriği asla açmadığı için gerçek
 *  codec'e gerek yok; yalnızca boyut/akış davranışı test edilir. */
function startTalking() {
  const callType = args.private > 0 ? CALL_PRIVATE : CALL_TG;
  const targetId = args.private > 0 ? args.private : args.tg;
  const frames = Math.max(1, Math.round(args.talk * 50)); // 20 ms → 50 çerçeve/sn

  say(`→ PTT_ON (${callType === CALL_PRIVATE ? 'özel çağrı' : 'TG'} ${targetId}, ${frames} çerçeve)`);
  udp.send(buildPacket(callType, PT_PTT_ON, args.id, targetId, 0, Buffer.alloc(0)), args.udp, args.host);

  let sent = 0;
  state.seq = 0;

  state.talkTimer = setInterval(() => {
    if (sent >= frames) {
      clearInterval(state.talkTimer);
      state.talkTimer = null;
      udp.send(buildPacket(callType, PT_PTT_OFF, args.id, targetId, state.seq, Buffer.alloc(0)), args.udp, args.host);
      say(`→ PTT_OFF (${sent} çerçeve gönderildi / frames sent)`);
      say('Dinlemeye devam / still listening. Çıkmak için Ctrl+C.');
      return;
    }
    // 30 baytlık sahte yük: gerçek Opus 8 kHz/20 ms/12 kbps çerçevesine yakın boyut.
    const payload = Buffer.alloc(30);
    payload.writeUInt16BE(state.seq & 0xffff, 0);
    payload.fill(0x5a, 2);
    udp.send(buildPacket(callType, PT_VOICE, args.id, targetId, state.seq, payload), args.udp, args.host);
    state.seq = (state.seq + 1) & 0xffff;
    sent += 1;
  }, 20);
}

function finish(code) {
  if (state.closing) {
    return;
  }
  state.closing = true;

  if (state.registerTimer) clearInterval(state.registerTimer);
  if (state.pingTimer) clearInterval(state.pingTimer);
  if (state.talkTimer) clearInterval(state.talkTimer);

  say('── özet / summary ──────────────────────────────');
  say(`alınan ses çerçevesi / voice frames received : ${state.rx.voice}`);
  say(`PTT_ON / PTT_OFF                             : ${state.rx.pttOn} / ${state.rx.pttOff}`);
  say(`REGISTER onayı / acks                        : ${state.rx.register}`);
  say(`toplam alınan bayt / bytes received          : ${state.rx.bytes}`);

  try { udp.close(); } catch (err) { /* yoksay */ }
  try { socket.destroy(); } catch (err) { /* yoksay */ }

  setTimeout(() => process.exit(code), 100);
}

process.on('SIGINT', () => {
  say('SIGINT — kapatılıyor / closing');
  try { socket.write('LOGOUT\n'); } catch (err) { /* yoksay */ }
  finish(0);
});
