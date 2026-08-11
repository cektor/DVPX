'use strict';

/**
 * DVPX Reflector — ses paketi başlığı / voice packet header
 *
 * [MagicBytes 'D''V'] + [CallType] + [PacketType] + [SourceID] + [TargetID]
 * + [SeqNum] + [PayloadLen] + [OpusPayload]
 *
 *  offset  size  alan
 *  ------  ----  ----------------------------------------------------------
 *    0      2    magic 'D','V'            (0x44 0x56)
 *    2      1    callType   0=TG, 1=Private
 *    3      1    packetType 0=Voice, 1=PTT_ON, 2=PTT_OFF, 3=REGISTER
 *    4      4    sourceID   uint32 BE
 *    8      4    targetID   uint32 BE
 *   12      2    seqNum     uint16 BE
 *   14      2    payloadLen uint16 BE
 *   16      *    payload
 *
 * ÖNEMLİ: Bu modül yükü ASLA yorumlamaz/açmaz. Yalnızca başlığı okur.
 * Ayrıştırma hiçbir koşulda istisna atmaz; bozuk paket için `null` döner —
 * böylece kötü bir UDP datagramı süreci düşüremez.
 */

const HEADER_LEN = 16;

const MAGIC_0 = 0x44; // 'D'
const MAGIC_1 = 0x56; // 'V'

const CALL_TYPE = {
  TALKGROUP: 0,
  PRIVATE: 1,
};

const PACKET_TYPE = {
  VOICE: 0,
  PTT_ON: 1,
  PTT_OFF: 2,
  REGISTER: 3,
};

const PACKET_TYPE_NAMES = {
  0: 'VOICE',
  1: 'PTT_ON',
  2: 'PTT_OFF',
  3: 'REGISTER',
};

/** Geçersizlik nedenleri (istatistik/log için) */
const REJECT = {
  TOO_SHORT: 'too_short',
  BAD_MAGIC: 'bad_magic',
  BAD_CALL_TYPE: 'bad_call_type',
  BAD_PACKET_TYPE: 'bad_packet_type',
  LENGTH_MISMATCH: 'length_mismatch',
  PAYLOAD_TOO_BIG: 'payload_too_big',
  ZERO_SOURCE: 'zero_source',
  ZERO_TARGET: 'zero_target',
};

/**
 * Başlığı ayrıştırır.
 * @param {Buffer} buf gelen datagram
 * @param {number} maxPayload izin verilen en büyük yük (bayt)
 * @returns {{ok:true, header:object}|{ok:false, reason:string}}
 */
function parse(buf, maxPayload) {
  if (!Buffer.isBuffer(buf) || buf.length < HEADER_LEN) {
    return { ok: false, reason: REJECT.TOO_SHORT };
  }
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) {
    return { ok: false, reason: REJECT.BAD_MAGIC };
  }

  const callType = buf[2];
  const packetType = buf[3];

  if (callType !== CALL_TYPE.TALKGROUP && callType !== CALL_TYPE.PRIVATE) {
    return { ok: false, reason: REJECT.BAD_CALL_TYPE };
  }
  if (!Object.prototype.hasOwnProperty.call(PACKET_TYPE_NAMES, packetType)) {
    return { ok: false, reason: REJECT.BAD_PACKET_TYPE };
  }

  const sourceId = buf.readUInt32BE(4);
  const targetId = buf.readUInt32BE(8);
  const seqNum = buf.readUInt16BE(12);
  const payloadLen = buf.readUInt16BE(14);

  if (payloadLen !== buf.length - HEADER_LEN) {
    return { ok: false, reason: REJECT.LENGTH_MISMATCH };
  }
  const limit = Number.isFinite(maxPayload) && maxPayload > 0 ? maxPayload : 1024;
  if (payloadLen > limit) {
    return { ok: false, reason: REJECT.PAYLOAD_TOO_BIG };
  }
  if (sourceId === 0) {
    return { ok: false, reason: REJECT.ZERO_SOURCE };
  }
  // REGISTER hedef taşımaz; diğer tiplerde hedef zorunludur.
  if (targetId === 0 && packetType !== PACKET_TYPE.REGISTER) {
    return { ok: false, reason: REJECT.ZERO_TARGET };
  }

  return {
    ok: true,
    header: {
      callType,
      packetType,
      sourceId,
      targetId,
      seqNum,
      payloadLen,
      typeName: PACKET_TYPE_NAMES[packetType],
    },
  };
}

/**
 * Paket üretir (yalnızca REGISTER onayı ve testler için; ses yolunda kullanılmaz).
 * @param {{callType:number, packetType:number, sourceId:number, targetId:number, seqNum:number}} h
 * @param {Buffer} [payload]
 * @returns {Buffer}
 */
function build(h, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.alloc(0);
  const buf = Buffer.allocUnsafe(HEADER_LEN + body.length);
  buf[0] = MAGIC_0;
  buf[1] = MAGIC_1;
  buf[2] = h.callType & 0xff;
  buf[3] = h.packetType & 0xff;
  buf.writeUInt32BE(h.sourceId >>> 0, 4);
  buf.writeUInt32BE(h.targetId >>> 0, 8);
  buf.writeUInt16BE((h.seqNum || 0) & 0xffff, 12);
  buf.writeUInt16BE(body.length & 0xffff, 14);
  if (body.length) {
    body.copy(buf, HEADER_LEN);
  }
  return buf;
}

/** Yükü kopyalamadan döndürür (REGISTER jetonu okumak için). */
function payloadSlice(buf) {
  return buf.length > HEADER_LEN ? buf.subarray(HEADER_LEN) : Buffer.alloc(0);
}

module.exports = {
  HEADER_LEN,
  CALL_TYPE,
  PACKET_TYPE,
  PACKET_TYPE_NAMES,
  REJECT,
  parse,
  build,
  payloadSlice,
};
