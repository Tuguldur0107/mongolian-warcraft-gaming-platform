/**
 * WC3 UDP Game Relay — Найдвартай LAN тоглоом илрүүлэгч
 *
 * 2 давхар хамгаалалттай:
 *
 * HOST MODE (startHost):
 *   - Port 6112 дээр reuseAddr-ээр WC3 broadcast-ыг capture
 *   - Тоглогч бүрийн IP руу unicast forward
 *
 * PLAYER MODE (startFinder):
 *   - W3GS_SEARCHGAME packet-ыг host IP руу илгээнэ (олон WC3 хувилбар)
 *   - Host WC3 хариу GAMEINFO илгээнэ
 *   - GAMEINFO-г 255.255.255.255:6112 руу дахин broadcast → WC3 тоглоом харуулна
 *
 * WC3 protocol: 0xF7 header, UDP port 6112
 */
const dgram = require('dgram');

const WC3_PORT = 6112;
const W3_HEADER = 0xF7;
const W3_SEARCHGAME = 0x2F;
const W3_GAMEINFO = 0x30;

// Түгээмэл WC3 хувилбарууд (Frozen Throne + Reign of Chaos)
const SEARCH_VERSIONS = [
  { product: 'W3XP', version: 26 },  // TFT 1.26a (хамгийн түгээмэл)
  { product: 'W3XP', version: 28 },  // TFT 1.28
  { product: 'W3XP', version: 30 },  // TFT 1.30
  { product: 'W3XP', version: 31 },  // TFT 1.31
  { product: 'WAR3', version: 26 },  // RoC 1.26a
  { product: 'W3XP', version: 24 },  // TFT 1.24e
  { product: 'W3XP', version: 27 },  // TFT 1.27
  { product: 'W3XP', version: 29 },  // TFT 1.29
];

let _hostRelay = null;   // Host mode state
let _finder = null;      // Player/Finder mode state

// ═══════════════════════════════════════════════════════════
// W3GS SEARCHGAME packet бүтээх
// ═══════════════════════════════════════════════════════════
function makeSearchPacket(product, version) {
  const buf = Buffer.alloc(16);
  buf[0] = W3_HEADER;                  // 0xF7
  buf[1] = W3_SEARCHGAME;              // 0x2F
  buf.writeUInt16LE(16, 2);            // packet size
  buf.write(product, 4, 4, 'ascii');   // "W3XP" эсвэл "WAR3"
  buf.writeUInt32LE(version, 8);       // хувилбарын дугаар
  buf.writeUInt32LE(0, 12);            // host counter (0 = бүгдийг хай)
  return buf;
}

// ═══════════════════════════════════════════════════════════
// HOST MODE — WC3 broadcast capture + forward
// ═══════════════════════════════════════════════════════════
function startHost(playerIps) {
  stopHost();
  const ips = (playerIps || []).filter(Boolean);
  if (!ips.length) {
    console.log('[GameRelay:Host] Тоглогчийн IP байхгүй');
    return;
  }

  const state = { ips, running: true, listener: null, sender: null };

  // Sender — тоглогчид руу forward хийх (random port)
  state.sender = dgram.createSocket('udp4');
  state.sender.on('error', (e) => console.error('[GameRelay:Host] sender:', e.message));

  // Listener — port 6112 дээр WC3 broadcast capture
  state.listener = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  state.listener.on('error', (e) => {
    console.error('[GameRelay:Host] listener:', e.message);
  });

  state.listener.on('message', (msg, rinfo) => {
    if (!state.running) return;
    if (!msg.length || msg[0] !== W3_HEADER) return;
    // Тоглогчдоос ирсэн packet-ыг давтахгүй
    if (state.ips.includes(rinfo.address)) return;

    for (const ip of state.ips) {
      try {
        state.sender.send(msg, 0, msg.length, WC3_PORT, ip);
      } catch {}
    }
  });

  state.listener.bind(WC3_PORT, '0.0.0.0', () => {
    try { state.listener.setBroadcast(true); } catch {}
    console.log(`[GameRelay:Host] Эхэллээ — ${ips.length} тоглогчид`);
  });

  _hostRelay = state;
}

function stopHost() {
  if (!_hostRelay) return;
  _hostRelay.running = false;
  try { _hostRelay.listener?.close(); } catch {}
  try { _hostRelay.sender?.close(); } catch {}
  _hostRelay = null;
  console.log('[GameRelay:Host] Зогслоо');
}

function addHostPlayerIp(ip) {
  if (_hostRelay && ip && !_hostRelay.ips.includes(ip)) {
    _hostRelay.ips.push(ip);
    console.log(`[GameRelay:Host] +${ip} (нийт: ${_hostRelay.ips.length})`);
  }
}

// ═══════════════════════════════════════════════════════════
// PLAYER MODE — Game Finder (SEARCHGAME → GAMEINFO → broadcast)
// ═══════════════════════════════════════════════════════════
function startFinder(hostIp) {
  stopFinder();
  if (!hostIp) {
    console.log('[GameRelay:Finder] Host IP байхгүй');
    return;
  }

  const state = {
    hostIp,
    running: true,
    socket: null,
    broadcaster: null,
    timer: null,
    versionIdx: 0,
    foundVersion: null, // Тоглоом олдсон хувилбар
  };

  // Socket — SEARCHGAME илгээх + GAMEINFO хүлээн авах (random port)
  state.socket = dgram.createSocket('udp4');
  state.socket.on('error', (e) => console.error('[GameRelay:Finder] socket:', e.message));

  state.socket.on('message', (msg, rinfo) => {
    if (!state.running) return;
    if (!msg.length || msg[0] !== W3_HEADER) return;

    // GAMEINFO хариу (0x30) хүлээн авсан!
    if (msg[1] === W3_GAMEINFO) {
      console.log(`[GameRelay:Finder] GAMEINFO олдлоо! (${rinfo.address}:${rinfo.port}, ${msg.length} bytes)`);

      // Олдсон хувилбарыг санах
      if (!state.foundVersion) {
        state.foundVersion = SEARCH_VERSIONS[state.versionIdx] || SEARCH_VERSIONS[0];
        console.log(`[GameRelay:Finder] WC3 хувилбар: ${state.foundVersion.product} v${state.foundVersion.version}`);
      }

      // GAMEINFO-г локал broadcast хийх → WC3 тоглоом харуулна
      broadcastGameInfo(state, msg);
    }
  });

  // Broadcaster — GAMEINFO-г 255.255.255.255:6112 руу broadcast
  state.broadcaster = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  state.broadcaster.on('error', (e) => console.error('[GameRelay:Finder] broadcaster:', e.message));
  state.broadcaster.bind(0, '0.0.0.0', () => {
    try { state.broadcaster.setBroadcast(true); } catch {}
  });

  // 3 секунд тутам SEARCHGAME илгээх
  function sendSearch() {
    if (!state.running) return;
    try {
      if (state.foundVersion) {
        // Олдсон хувилбараар л илгээнэ
        const pkt = makeSearchPacket(state.foundVersion.product, state.foundVersion.version);
        state.socket.send(pkt, 0, pkt.length, WC3_PORT, state.hostIp);
      } else {
        // Бүх хувилбарыг ээлжлэн туршина
        const v = SEARCH_VERSIONS[state.versionIdx % SEARCH_VERSIONS.length];
        const pkt = makeSearchPacket(v.product, v.version);
        state.socket.send(pkt, 0, pkt.length, WC3_PORT, state.hostIp);
        state.versionIdx++;
      }
    } catch {}
    state.timer = setTimeout(sendSearch, state.foundVersion ? 5000 : 2000);
  }

  sendSearch();
  console.log(`[GameRelay:Finder] Эхэллээ — host: ${hostIp}`);
  _finder = state;
}

function broadcastGameInfo(state, gameInfoPacket) {
  if (!state.broadcaster) return;
  try {
    // 255.255.255.255:6112 руу broadcast → WC3 тоглоом харагдана
    state.broadcaster.send(gameInfoPacket, 0, gameInfoPacket.length, WC3_PORT, '255.255.255.255');
  } catch (e) {
    console.error('[GameRelay:Finder] broadcast алдаа:', e.message);
    // Fallback: localhost руу илгээх
    try {
      state.broadcaster.send(gameInfoPacket, 0, gameInfoPacket.length, WC3_PORT, '127.0.0.1');
    } catch {}
  }
}

function stopFinder() {
  if (!_finder) return;
  _finder.running = false;
  if (_finder.timer) clearTimeout(_finder.timer);
  try { _finder.socket?.close(); } catch {}
  try { _finder.broadcaster?.close(); } catch {}
  _finder = null;
  console.log('[GameRelay:Finder] Зогслоо');
}

// ═══════════════════════════════════════════════════════════
// Бүгдийг зогсоох
// ═══════════════════════════════════════════════════════════
function stopAll() {
  stopHost();
  stopFinder();
}

function isRunning() {
  return !!_hostRelay || !!_finder;
}

module.exports = {
  startHost, stopHost, addHostPlayerIp,
  startFinder, stopFinder,
  stopAll, isRunning,
};
