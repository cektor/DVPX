'use strict';

/**
 * DVPX Reflector — günlükçü / logger
 *
 * Bilinçli olarak bağımlılıksız: systemd/journalctl ve `node src/index.js >
 * dvpx.log` senaryolarının ikisinde de okunabilir tek satırlık kayıtlar üretir.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

let currentLevel = LEVELS.info;

function setLevel(name) {
  if (Object.prototype.hasOwnProperty.call(LEVELS, name)) {
    currentLevel = LEVELS[name];
  }
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function emit(level, tag, message, stream) {
  if (LEVELS[level] > currentLevel) {
    return;
  }
  const line = `${stamp()} [${level.toUpperCase().padEnd(5)}] [${tag}] ${message}`;
  try {
    stream.write(line + '\n');
  } catch (err) {
    // Boru kapandıysa (log rotasyonu vb.) süreç bundan etkilenmemeli.
  }
}

/** Etiketli bir günlükçü döndürür / returns a tagged logger */
function createLogger(tag) {
  return {
    error(msg) { emit('error', tag, msg, process.stderr); },
    warn(msg)  { emit('warn',  tag, msg, process.stderr); },
    info(msg)  { emit('info',  tag, msg, process.stdout); },
    debug(msg) { emit('debug', tag, msg, process.stdout); },
  };
}

module.exports = { createLogger, setLevel, LEVELS };
