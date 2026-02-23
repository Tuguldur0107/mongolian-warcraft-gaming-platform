/**
 * WC3 UDP Game Relay
 *
 * Host дээр WC3-ийн LAN game broadcast (UDP port 6112)-ыг барьж,
 * тоглогч бүрийн ZeroTier IP руу шууд (unicast) дамжуулна.
 * Ингэснээр тоглогчдын WC3 дээр тоглоом автоматаар харагдана.
 *
 * WC3 protocol: 0xF7 header, port 6112
 */
const dgram = require('dgram');

const WC3_PORT = 6112;
const W3_HEADER = 0xF7; // Warcraft III game protocol header

let listener = null;    // reuseAddr socket — WC3 broadcast барих
let sender   = null;    // тоглогчид руу дамжуулах socket
let playerIps = [];     // тоглогчдын ZeroTier IP жагсаалт
let _running  = false;

/**
 * Relay эхлүүлэх (Host дээр дуудна)
 * @param {string[]} ips - Тоглогчдын ZeroTier IP хаягууд
 */
function start(ips) {
  if (_running) stop();
  playerIps = (ips || []).filter(Boolean);
  if (!playerIps.length) {
    console.log('[GameRelay] Тоглогчийн IP байхгүй, relay эхлэхгүй');
    return;
  }

  _running = true;

  // Sender socket — тоглогчид руу packet илгээх (random port)
  sender = dgram.createSocket('udp4');
  sender.on('error', (err) => {
    console.error('[GameRelay] sender алдаа:', err.message);
  });

  // Listener socket — WC3-ийн broadcast-ыг барих (reuseAddr)
  listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });

  listener.on('error', (err) => {
    console.error('[GameRelay] listener алдаа:', err.message);
    // Port conflict байвал зогсоох
    stop();
  });

  listener.on('message', (msg, rinfo) => {
    // WC3 protocol packet-ыг шалгах (0xF7 header)
    if (!msg.length || msg[0] !== W3_HEADER) return;

    // Зөвхөн локал машинаас ирсэн broadcast-ыг дамжуулна
    // (өөрийн илгээсэн packet-ыг давтахгүйн тулд)
    if (playerIps.includes(rinfo.address)) return;

    // Тоглогч бүрийн ZeroTier IP руу unicast илгээх
    for (const ip of playerIps) {
      try {
        sender.send(msg, 0, msg.length, WC3_PORT, ip);
      } catch (e) {
        console.error(`[GameRelay] ${ip} руу илгээхэд алдаа:`, e.message);
      }
    }
  });

  listener.bind(WC3_PORT, '0.0.0.0', () => {
    try { listener.setBroadcast(true); } catch {}
    console.log(`[GameRelay] Эхэллээ — ${playerIps.length} тоглогчид дамжуулна`);
  });
}

/**
 * Тоглогчийн IP нэмэх (шинэ тоглогч нэгдэхэд)
 */
function addPlayerIp(ip) {
  if (ip && !playerIps.includes(ip)) {
    playerIps.push(ip);
    console.log(`[GameRelay] Тоглогч нэмэгдлээ: ${ip} (нийт: ${playerIps.length})`);
  }
}

/**
 * Тоглогчийн IP хасах
 */
function removePlayerIp(ip) {
  playerIps = playerIps.filter(i => i !== ip);
}

/**
 * Relay зогсоох
 */
function stop() {
  _running = false;
  playerIps = [];
  if (listener) {
    try { listener.close(); } catch {}
    listener = null;
  }
  if (sender) {
    try { sender.close(); } catch {}
    sender = null;
  }
  console.log('[GameRelay] Зогслоо');
}

function isRunning() {
  return _running;
}

module.exports = { start, stop, addPlayerIp, removePlayerIp, isRunning };
