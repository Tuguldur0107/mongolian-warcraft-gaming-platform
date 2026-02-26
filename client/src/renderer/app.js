const SERVER = 'https://mongolian-warcraft-gaming-platform-production.up.railway.app';

// ── Socket.io ─────────────────────────────────────────────
let socket = null;
let currentRoom = null;
let currentUser = null;
// Өрөөний мэдээлэл кэш (roomCard onclick-д ашиглана)
let roomsCache = {}; // id → room object

// ── ZeroTier IP хадгалалт ────────────────────────────────
let roomZtIps = {}; // userId → ip

// ── Sound + Notification систем ─────────────────────────
let _audioCtx = null;
function _getAudioCtx() {
  if (!_audioCtx) _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return _audioCtx;
}

function playSound(type) {
  if (localStorage.getItem('sound_enabled') === 'false') return;
  try {
    const ctx = _getAudioCtx();
    const now = ctx.currentTime;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, now);

    const tones = {
      dm:        [{ f: 880, t: 0, d: 0.1 }, { f: 1174, t: 0.12, d: 0.15 }],
      notify:    [{ f: 1047, t: 0, d: 0.18 }],
      gameStart: [{ f: 523, t: 0, d: 0.12 }, { f: 659, t: 0.14, d: 0.12 }, { f: 784, t: 0.28, d: 0.25 }],
      ready:     [{ f: 660, t: 0, d: 0.1 }, { f: 880, t: 0.1, d: 0.15 }],
      join:      [{ f: 700, t: 0, d: 0.06 }],
    };

    const notes = tones[type] || tones.notify;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(n.f, now + n.t);
      osc.connect(gain);
      osc.start(now + n.t);
      osc.stop(now + n.t + n.d);
    }
    gain.gain.setValueAtTime(0.15, now + notes[notes.length - 1].t + notes[notes.length - 1].d - 0.02);
    gain.gain.linearRampToValueAtTime(0, now + notes[notes.length - 1].t + notes[notes.length - 1].d);
  } catch {}
}

function showDesktopNotif(title, body) {
  if (localStorage.getItem('desktop_notif_enabled') === 'false') return;
  if (!document.hidden) return; // window focus байвал харуулахгүй
  try {
    if (Notification.permission === 'granted') {
      const n = new Notification(title, { body, silent: true });
      n.onclick = () => { window.focus(); n.close(); };
    } else if (Notification.permission !== 'denied') {
      Notification.requestPermission();
    }
  } catch {}
}

// ── Чат төлөв ─────────────────────────────────────────────
const dmConversations = {};
let activeDmUserId = null;
let chatUnreadCount = 0;

// ── DM Popup төлөв ────────────────────────────────────────
const MAX_DM_POPUPS = 3;
const activePopups = new Map(); // userId -> { element, minimized, emojiOpen, typingTimer, isTyping }

// ── Emoji Data ────────────────────────────────────────────
const EMOJI_DATA = {
  smileys: ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😙','🥲','😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔','🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🥴','😵','🤯','🥳','🥸','😎','🤓','🧐','😕','😟','🙁','☹️','😮','😯','😲','😳','🥺','🥹','😦','😧','😨','😰','😥','😢','😭','😱','😖','😣','😞','😓','😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  people:  ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','🖕','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💪','🦾','🦿','🦵','🦶','👂','👃','🧠','🦷','🦴','👀','👁️','👅','👄'],
  animals: ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐒','🐔','🐧','🐦','🐤','🐣','🦆','🦅','🦉','🦇','🐺','🐗','🐴','🦄','🐝','🐛','🦋','🐌','🐞','🐜','🐢','🐍','🦎','🦖','🦕','🐙','🦑','🦐','🦞','🦀','🐡','🐠','🐟','🐬','🐳','🐋','🦈','🐊','🐅','🐆','🦓','🦍','🦧','🐘','🦛','🦏'],
  food:    ['🍕','🍔','🍟','🌭','🍿','🥓','🥚','🍳','🥞','🧇','🍞','🧀','🥗','🥙','🥪','🌮','🌯','🍝','🍜','🍲','🍛','🍣','🍱','🥟','🍤','🍙','🍚','🍘','🍥','🍡','🍧','🍨','🍦','🥧','🧁','🍰','🎂','🍮','🍭','🍬','🍫','🍩','🍪','🍯','🥛','☕','🍵','🧃','🥤','🧋','🍶','🍺','🍻','🥂','🍷'],
  activities: ['⚽','🏀','🏈','⚾','🎾','🏐','🏉','🎱','🏓','🏸','🏒','🏑','🏏','⛳','🏹','🎣','🥊','🥋','🎽','🛹','🛷','⛸️','🥌','🎿','🏂','🏇','🏋️','🤸','⛹️','🤾','🏌️','🏄','🏊','🤽','🚣','🧗','🚴','🚵','🎮','🕹️','🎲','♟️','🎯','🎳','🎸','🎹','🥁','🎷','🎺','🎻'],
  objects: ['💡','🔦','🕯️','📱','💻','⌨️','🖥️','🖨️','💾','💿','📷','📹','🎥','📞','📺','📻','🎙️','🧭','⏱️','⏰','⌛','⏳','📡','🔋','🔌','💰','💴','💵','💶','💷','💳','💎','⚖️','🔧','🔩','⚙️','🔗','📎','📏','📐','✂️','🗑️','🔒','🔑','🗝️'],
  symbols: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟','☮️','✝️','☪️','🕉️','☸️','✡️','☯️','✅','✔️','☑️','❌','❎','➕','➖','➗','✖️','♾️','‼️','⁉️','❓','❗','💯','🔥','⭐','🌟','✨','💫','🎉','🎊'],
  flags:   ['🏳️','🏴','🏁','🚩','🏳️‍🌈','🇲🇳','🇺🇸','🇬🇧','🇫🇷','🇩🇪','🇯🇵','🇰🇷','🇨🇳','🇷🇺','🇦🇺','🇨🇦','🇧🇷','🇮🇳','🇮🇹','🇪🇸','🇲🇽','🇹🇷','🇸🇪','🇳🇴']
};

// ── Нийгмийн төлөв (friends / block) ──────────────────────
let myFriends        = [];   // { id, username, avatar_url }
let pendingRequests  = [];   // { id, username, avatar_url }
let blockedUsers     = [];   // { id, username, avatar_url }
let onlineUserIds    = new Set(); // онлайн хэрэглэгчийн userId-ийн Set

// Чат хэсгийн идэвхтэй tab
let activeDmTab = 'friends';

// ── Light / Dark горим ───────────────────────────────────
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
}

function toggleTheme() {
  const isLight = document.body.classList.contains('light');
  const next = isLight ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('theme', next);
}

// Хадгалагдсан горим ачааллах
applyTheme(localStorage.getItem('theme') || 'dark');

document.getElementById('btn-theme').onclick = toggleTheme;

// ── Цонх горимууд ────────────────────────────────────────
function isRoomMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'room';
}
function isDMMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'dm';
}
function isFriendsMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'friends';
}

async function connectSocket() {
  if (socket) socket.disconnect();
  const token = await window.api.getToken().catch(() => null);
  socket = io(SERVER, {
    transports: ['websocket'],
    auth: { token },
  });

  socket.on('connect', () => {
    console.log('Socket холбогдлоо');
    updateConnectionStatus('online');
    if (currentUser) {
      socket.emit('lobby:register');
      // Өрөөнд байсан бол автоматаар дахин нэгдэх (reconnect)
      if (currentRoom) {
        console.log(`[Rejoin] Дахин холбогдлоо, өрөө ${currentRoom.id} руу дахин нэгдэж байна`);
        socket.emit('room:join', { roomId: currentRoom.id });
      }
    }
  });

  // Найз хүсэлт ирэх
  socket.on('friend:request', ({ fromUserId, fromUsername }) => {
    const exists = pendingRequests.find(p => String(p.id) === String(fromUserId));
    if (!exists) {
      pendingRequests.push({ id: fromUserId, username: fromUsername, avatar_url: null });
      updatePendingBadge();
      renderFriendsTab();
      playSound('notify');
      showDesktopNotif('👋 Найзын хүсэлт', `${fromUsername} найз болохыг хүсэж байна`);
      showDMNotification(`${fromUsername} найз болохыг хүсэж байна`);
    }
  });

  // Найз хүсэлт зөвшөөрөгдсөн
  socket.on('friend:accepted', ({ byUserId, byUsername }) => {
    const exists = myFriends.find(f => String(f.id) === String(byUserId));
    if (!exists) {
      myFriends.push({ id: byUserId, username: byUsername, avatar_url: null });
      renderFriendsTab();
      playSound('notify');
      showDMNotification(`${byUsername} найз болохыг зөвшөөрлөө`);
    }
  });

  // Өрөөнд урих
  socket.on('room:invited', ({ fromUsername, fromUserId, roomId, roomName }) => {
    playSound('notify');
    showDesktopNotif('🎮 Өрөөний урилга', `${fromUsername} "${roomName}" өрөөнд урив`);
    showRoomInvite(fromUsername, roomId, roomName);
  });

  socket.on('disconnect', (reason) => {
    console.log('Socket салгагдлаа:', reason);
    updateConnectionStatus('offline');
    // ZT setup-ийн үед routing table өөрчлөгдөж түр тасрах нь хэвийн
    // Socket.io автомат дахин холбогдоно — хэрэглэгчид мэдэгдэх шаардлагагүй
    if (currentRoom && !_ztSetupInProgress) {
      appendSysMsg('⚠ Холболт тасарлаа. Дахин холбогдож байна...');
    }
  });
  socket.on('reconnecting', () => updateConnectionStatus('reconnecting'));

  // Өрөөний чат
  socket.on('chat:message',         (msg)        => appendMessage(msg));
  socket.on('chat:deleted', ({ time }) => {
    const box = document.getElementById('chat-messages');
    if (!box) return;
    const el = box.querySelector(`.msg[data-time="${time}"]`);
    if (el) { el.classList.add('msg-deleted'); el.querySelector('.msg-bubble').textContent = '[Устгагдсан мессеж]'; el.querySelector('.msg-delete')?.remove(); }
  });
  socket.on('lobby:deleted', ({ time }) => {
    const box = document.getElementById('lobby-chat-messages');
    if (!box) return;
    const el = box.querySelector(`.msg[data-time="${time}"]`);
    if (el) { el.classList.add('msg-deleted'); el.querySelector('.msg-bubble').textContent = '[Устгагдсан мессеж]'; el.querySelector('.msg-delete')?.remove(); }
  });
  socket.on('room:members',         (members)    => {
    if (currentRoom) {
      currentRoom.members = members;
      // Replay service-д гишүүдийг дамжуулах (player matching)
      window.api.setReplayMembers?.(members.map(m => ({
        id: m.id !== undefined ? m.id : null,
        name: m.name !== undefined ? m.name : String(m),
      }))).catch(() => {});
    }
    renderMembers(members);
  });
  socket.on('room:user_joined',     ({ username }) => { playSound('join'); appendSysMsg(`${username} нэгдлээ`); });
  socket.on('room:user_left',       ({ username }) => appendSysMsg(`${username} гарлаа`));
  socket.on('room:user_reconnecting', ({ username }) => appendSysMsg(`⚠ ${username} холболт тасарлаа, дахин холбогдохыг хүлээж байна...`));
  socket.on('room:user_rejoined',   ({ username }) => appendSysMsg(`✓ ${username} дахин нэгдлээ`));

  // Өрөөний тохиргоо шинэчлэгдсэн
  socket.on('room:updated', (room) => {
    if (currentRoom) {
      if (room.name) document.getElementById('room-title').textContent = room.name;
      if (room.max_players) {
        currentRoom.maxPlayers = room.max_players;
        const sel = document.getElementById('select-max-players');
        if (sel) sel.value = String(room.max_players);
      }
      appendSysMsg(`⚙ Өрөөний тохиргоо шинэчлэгдлээ`);
    }
  });

  // Баг солигдсон
  socket.on('room:team_changed', ({ userId, team }) => {
    appendSysMsg(`Тоглогч баг ${team} руу шилжлээ`);
  });

  // Лобби өрөөний жагсаалт автоматаар шинэчлэгдэх
  let _roomsRefreshTimer = null;
  socket.on('rooms:updated', () => {
    clearTimeout(_roomsRefreshTimer);
    _roomsRefreshTimer = setTimeout(() => {
      const lobbyTab = document.getElementById('tab-lobby');
      if (lobbyTab?.classList.contains('active')) loadRooms();
    }, 300);
  });

  // Онлайн тоглогчид (лобби)
  socket.on('lobby:online_users', (users) => {
    const prevOnlineIds = new Set(onlineUserIds);
    onlineUserIds = new Set(users.map(u => String(typeof u === 'object' ? u.userId : u)));
    renderOnlineUsers(users);
    renderFriendsTab();
    if (isFriendsMode()) renderFriendsWindow();
    // Найз онлайн болсон мэдэгдэл
    myFriends.forEach(f => {
      const uid = String(f.id);
      if (!prevOnlineIds.has(uid) && onlineUserIds.has(uid)) {
        showDMNotification(`${f.username} онлайн боллоо`);
      }
    });
  });

  // Нийтийн лобби чат
  socket.on('lobby:chat', (msg) => appendLobbyMessage(msg));

  // Лобби чатын түүх (нэвтрэхэд нэг удаа ирнэ)
  socket.on('lobby:history', (msgs) => {
    lobbyMessages.length = 0; // Хуучин мессежүүдийг цэвэрлэх
    const box = document.getElementById('lobby-chat-messages');
    if (box) box.innerHTML = '';
    msgs.forEach(msg => appendLobbyMessage(msg, true));
  });

  // Өрөөний чатын түүх
  socket.on('room:history', (msgs) => {
    msgs.forEach(msg => appendMessage(msg));
  });

  // Typing indicator (DM)
  socket.on('typing:start', ({ fromUserId, fromUsername }) => {
    const uid = String(fromUserId);
    if (isDMMode()) {
      if (activeDmUserId !== uid) return;
      const indicator = document.getElementById('dm-window-typing');
      if (indicator) {
        indicator.textContent = `${fromUsername} бичиж байна...`;
        indicator.style.display = 'block';
        clearTimeout(indicator._hideTimer);
        indicator._hideTimer = setTimeout(() => { indicator.style.display = 'none'; }, 2000);
      }
      return;
    }
    // Popup-д typing indicator харуулах
    if (activePopups.has(uid)) {
      const state = activePopups.get(uid);
      const typingEl = state.element.querySelector('.dm-popup-typing');
      if (typingEl) {
        typingEl.textContent = `${fromUsername} бичиж байна...`;
        typingEl.style.display = 'block';
        clearTimeout(typingEl._hideTimer);
        typingEl._hideTimer = setTimeout(() => { typingEl.style.display = 'none'; }, 2000);
      }
    }
  });

  socket.on('typing:stop', ({ fromUserId }) => {
    const uid = String(fromUserId);
    if (isDMMode()) {
      if (activeDmUserId !== uid) return;
      const indicator = document.getElementById('dm-window-typing');
      if (indicator) indicator.style.display = 'none';
      return;
    }
    if (activePopups.has(uid)) {
      const state = activePopups.get(uid);
      const typingEl = state.element.querySelector('.dm-popup-typing');
      if (typingEl) typingEl.style.display = 'none';
    }
  });

  // Хувийн мессеж
  socket.on('private:message', (msg) => handleIncomingDM(msg));
  socket.on('private:sent',    (msg) => handleSentDM(msg));

  // Өрөөний эзэн өрөөг хаасан
  socket.on('room:closed', ({ reason }) => {
    if (!currentRoom) return;
    appendSysMsg(`⚠️ ${reason || 'Өрөө хаагдлаа'}`);
    _hostRelayStarted = false;
    roomZtIps = {};
    try { window.api.stopRelay(); } catch {}
    setTimeout(() => {
      currentRoom = null;
      if (isRoomMode()) { window.close(); }
      else { showPage('page-main'); loadRooms(); }
    }, 1500);
  });

  // Kick хийгдсэн
  socket.on('room:kicked', ({ userId }) => {
    if (!currentUser || String(userId) !== String(currentUser.id)) return;
    appendSysMsg('⚠️ Та өрөөнөөс гаргагдлаа!');
    _hostRelayStarted = false;
    roomZtIps = {};
    try { window.api.stopRelay(); } catch {}
    setTimeout(() => {
      currentRoom = null;
      if (isRoomMode()) { window.close(); }
      else { showPage('page-main'); loadRooms(); }
    }, 1500);
  });

  // Тоглолт эхэлсэн (эзэн биш тоглогчдод) — WC3 автомат нээгдэнэ
  socket.on('room:started', async () => {
    // Host аль хэдийн WC3 нээсэн (btn-launch-wc3 handler-ээс) — давхар нээхгүй
    if (currentRoom?.isHost) return;
    playSound('gameStart');
    showDesktopNotif('▶ Тоглолт эхэллээ!', `${currentRoom?.name || 'Өрөө'} — WC3 нээж байна...`);
    appendSysMsg('▶ Тоглолт эхэллээ! WC3 нээж байна...');
    socket.emit('room:game_started');
    // "Дахин нэвтрэх" товчийг харуулах
    const launchBtn = document.getElementById('btn-launch-wc3');
    if (launchBtn) launchBtn.style.display = '';
    setLaunchBtnRejoin();
    try {
      await window.api.launchGame(currentRoom?.gameType || '');
      appendSysMsg('✓ Тоглоом нээгдлээ. Тоглоом хайж байна...');
    } catch (err) {
      appendSysMsg(`⚠️ WC3 нээхэд алдаа: ${err.message}`);
    }
  });

  // Host IP хүлээн авах (бусад тоглогчид) → Game Finder автомат эхлүүлэх
  socket.on('room:host_ip', async ({ ip, hostUsername }) => {
    showHostIp(ip);
    appendSysMsg(`🎯 ${hostUsername} тоглоом host хийлээ`);
    // PLAYER: Game Finder эхлүүлэх — host руу SEARCHGAME илгээж тоглоом олно
    if (!currentRoom?.isHost) {
      try {
        await window.api.startGameFinder(ip);
        appendSysMsg('📡 Тоглоом хайж байна... WC3 LAN жагсаалтад удахгүй харагдана.');
      } catch {}
    }
  });

  // Тоглогчдын ZeroTier IP жагсаалт
  socket.on('room:zt_ips', async ({ ips }) => {
    if (!ips) return;
    // IP-уудыг хадгалах
    roomZtIps = ips;
    if (currentRoom?.members) renderMembers(currentRoom.members);

    // Relay аль хэдийн ажиллаж байвал шинэ IP нэмнэ (WC3 нээгдсэний дараа л)
    if (_hostRelayStarted && currentRoom?.isHost) {
      const myId = String(currentUser?.id);
      const playerIps = Object.entries(ips)
        .filter(([uid]) => uid !== myId)
        .map(([, ip]) => ip);
      for (const ip of playerIps) {
        try { await window.api.addRelayPlayer(ip); } catch {}
      }
    }
  });

  // Host-оос ZT IP refresh хүсэлт ирэхэд
  socket.on('room:do_refresh_zt', async ({ targetUserId }) => {
    if (String(currentUser?.id) === String(targetUserId) && currentRoom) {
      try {
        const ip = await window.api.getZerotierIp();
        if (ip) {
          socket.emit('room:zt_ip', { roomId: currentRoom.id, ip });
          showToast(`IP автоматаар шинэчлэгдлээ: ${ip}`, 'success');
        }
      } catch {}
    }
  });

  // WC3 хаагдсан
  let _hostKilledGame = false; // host хаасан учир game:exited давхар харуулахгүй
  window.api.onGameExited(() => {
    if (!currentRoom) return;
    if (currentRoom.isHost) {
      // HOST: тоглогчдод мэдэгдэж, дахин эхлүүлэх товч харуулах
      if (socket) socket.emit('room:host_game_ended', { roomId: currentRoom.id });
      _hostRelayStarted = false;
      try { window.api.stopRelay(); } catch {}
      appendSysMsg('⚠ WC3 хаагдлаа. "▶ Тоглолт эхлүүлэх" дарж дахин эхлүүлнэ үү.');
      resetLaunchBtn(true);
      const launchBtn = document.getElementById('btn-launch-wc3');
      if (launchBtn) launchBtn.style.display = '';
    } else {
      // PLAYER: host хаасан үед killGame() → game:exited гарна, давхардуулахгүй
      if (_hostKilledGame) { _hostKilledGame = false; return; }
      appendSysMsg('⚠ WC3 хаагдлаа. Дахин нэвтрэхийн тулд доорх товчийг дарна уу.');
      setLaunchBtnRejoin();
      showToast('WC3 хаагдлаа — "↩ Дахин нэвтрэх" дарж буцаж орно уу', 'warning', 8000);
    }
  });

  // Host WC3 хаагдсан — тоглогчийн WC3-г автомат хаах
  socket.on('room:host_game_ended', async () => {
    if (!currentRoom || currentRoom.isHost) return;
    _hostKilledGame = true; // game:exited давхар handler-г зогсоох
    appendSysMsg('⚠ Host тоглоомыг хаалаа. Таны WC3 хаагдаж байна...');
    showToast('Host тоглоомыг хаалаа', 'warning', 5000);
    // WC3 kill + relay зогсоох
    try { await window.api.killGame(); } catch {}
    try { window.api.stopRelay(); } catch {}
    // Товчийг нуух — host дахин эхлүүлэхэд автомат нээгдэнэ
    const launchBtn = document.getElementById('btn-launch-wc3');
    if (launchBtn) launchBtn.style.display = 'none';
    appendSysMsg('⏳ Host дахин тоглоом эхлүүлэхийг хүлээж байна...');
  });
}

// ── Хуудас шилжилт ────────────────────────────────────────
function showPage(id) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  document.querySelector(`[data-tab="${name}"]`).classList.add('active');
  if (name === 'lobby')    loadRooms();
  if (name === 'ranking')  loadRanking();
  if (name === 'profile')  loadProfile();
  if (name === 'settings') loadSettings();
  if (name === 'discord')  loadDiscordServers();
  if (name === 'chat') {
    chatUnreadCount = 0;
    updateChatBadge();
    loadSocialData();
    rerenderLobbyMessages();
    setTimeout(() => {
      const box = document.getElementById('lobby-chat-messages');
      if (box) box.scrollTop = box.scrollHeight;
    }, 50);
  }
}

// ── Auth tab UI ───────────────────────────────────────────
document.querySelectorAll('.auth-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.auth-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const which = btn.dataset.auth;
    // classList ашиглах — style.display нь 'hidden' CSS классыг устгадаггүй учраас
    document.getElementById('auth-login').classList.toggle('hidden', which !== 'login');
    document.getElementById('auth-register').classList.toggle('hidden', which !== 'register');
    document.getElementById('auth-forgot').classList.add('hidden');
  };
});

// ── Эхлүүлэх ─────────────────────────────────────────────
async function init() {
  // Найзуудын тусдаа цонх горим
  if (isFriendsMode()) {
    document.getElementById('page-login').classList.remove('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const user = await window.api.getUser();
    if (!user) { window.close(); return; }
    currentUser = user;
    connectSocket();
    document.getElementById('friends-fullpage').classList.add('active');
    initFriendsWindowMode();
    return;
  }

  // DM тусдаа цонх горим
  if (isDMMode()) {
    document.getElementById('page-login').classList.remove('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const user = await window.api.getUser();
    if (!user) { window.close(); return; }
    currentUser = user;
    connectSocket();
    const p = new URLSearchParams(window.location.search);
    document.getElementById('dm-fullpage').classList.add('active');
    initDMWindowMode(p.get('dmUserId'), p.get('dmUsername'));
    window.addEventListener('beforeunload', () => {
      if (socket && activeDmUserId) socket.emit('typing:stop', { toUserId: activeDmUserId });
    });
    return;
  }

  // Өрөөний цонх горим: URL-аас params унших
  if (isRoomMode()) {
    // Нэвтрэх хуудас харагдахаас урьдчилан сэргийлэх
    document.getElementById('page-login').classList.remove('active');
    const user = await window.api.getUser();
    if (!user) { window.close(); return; }
    currentUser = user;
    connectSocket();

    const p       = new URLSearchParams(window.location.search);
    const id      = p.get('roomId');
    const name    = p.get('roomName') || 'Өрөө';
    const gameType= p.get('gameType') || 'DotA';
    const isHost  = p.get('isHost') === '1';
    const hostId  = p.get('hostId') || '';
    const status  = p.get('status') || '';
    const ztNetId = p.get('ztNetId') || '';

    _enterRoomUI(id, name, gameType, isHost, hostId, status, ztNetId);

    // Цонх хаагдахад өрөөнөөс гарах + relay зогсоох
    window.addEventListener('beforeunload', () => {
      if (currentRoom) {
        if (socket) {
          socket.emit('room:leave', { roomId: currentRoom.id });
        }
        window.api.stopRelay().catch(() => {});
        window.api.leaveRoom(currentRoom.id).catch(() => {});
      }
    });
    return;
  }

  // Тохируулгыг урьдчилан ачаалах (тоглоомуудын жагсаалт)
  loadSettings().catch(() => {});

  // Ердийн горим
  const user = await window.api.getUser();
  if (user) {
    currentUser = user;
    setUserUI(user);
    showPage('page-main');
    loadRooms();
    connectSocket();
    loadUnreadDMCounts();
    // Серверээс бүрэн мэдээлэл (avatar_url г.м.) шинэчлэх
    window.api.refreshUser?.().then(async () => {
      const fresh = await window.api.getUser();
      if (fresh) { currentUser = fresh; setUserUI(fresh); }
    }).catch(() => {});
  } else {
    showPage('page-login');
    loadQR();
  }

  window.api.onAuthSuccess((user) => {
    currentUser = user;
    setUserUI(user);
    showPage('page-main');
    loadRooms();
    connectSocket();
    loadUnreadDMCounts();
    if (!localStorage.getItem('onboarding_done')) setTimeout(() => startOnboarding(), 600);
  });

  window.api.onGameResult((data) => showGameResult(data));

  // Өрөөний цонх хаагдахад lobby шинэчлэх
  window.api.onRoomWindowClosed(() => loadRooms());

  // ── Auto-update мэдэгдлүүд ─────────────────────────────
  window.api.onUpdateAvailable(({ version }) => {
    showUpdateBar(`v${version} шинэ хувилбар байна. Татаж байна...`, null);
    setUpdateMsg(`v${version} шинэ хувилбар олдлоо. Татаж байна...`, 'info');
  });
  window.api.onUpdateProgress((pct) => {
    showUpdateBar(`Шинэ хувилбар татаж байна... ${pct}%`, null, pct);
    setUpdateMsg(`Татаж байна... ${pct}%`, 'info');
  });
  window.api.onUpdateDownloaded(({ version }) => {
    showUpdateBar(`v${version} бэлэн боллоо!`, true);
    setUpdateMsg(`v${version} татагдлаа! Дээрх "Суулгаж дахин эхлүүлэх" дарна уу.`, 'success');
  });
  window.api.onUpdateError?.((msg) => {
    setUpdateMsg(`Шинэчлэлийн алдаа: ${msg}`, 'error');
    showToast(`Шинэчлэлийн алдаа: ${msg}`, 'error', 6000);
  });

  // ── ZeroTier автомат тохиргоо статус ─────────────────
  _ztSetupInProgress = true;
  window.api.onZtSetupComplete?.(async (result) => {
    _ztSetupInProgress = false;
    if (result.ok) {
      console.log('[ZT] Автомат тохиргоо амжилттай. IP:', result.ip || 'хүлээж байна');

      // Adapter priority / Firewall амжилтгүй бол warning харуулах
      if (result.metricSet === false) {
        showToast('ZeroTier adapter priority тохируулж чадсангүй. Тоглоом олдохгүй бол апп-г admin эрхтэй нээнэ үү.', 'warning', 12000);
      }
      if (result.firewallSet === false) {
        showToast('Windows Firewall rule нэмж чадсангүй. Тоглоом олдохгүй бол Firewall-г шалгана уу.', 'warning', 10000);
      }

      // Серверээр автоматаар authorize хийлгэх (private network-д шаардлагатай)
      try {
        const nodeId = await window.api.getZerotierNodeId();
        const cfg = await fetch(SERVER + '/config').then(r => r.json());
        if (nodeId && cfg.zerotierNetworkId && socket) {
          socket.emit('zt:authorize', { nodeId, networkId: cfg.zerotierNetworkId });
        }
      } catch (e) { console.warn('[ZT] Authorize хүсэлт алдаа:', e.message); }
    } else {
      const msgs = {
        'install-failed': 'ZeroTier суулгалт амжилтгүй болсон. Гараар суулгана уу: zerotier.com/download',
        'service-failed': 'ZeroTier сервис эхлүүлж чадсангүй. Компьютерээ дахин асаагаад оролдоно уу.',
        'join-failed':    'ZeroTier сүлжээнд нэгдэж чадсангүй.',
        'no-network-id':  'Серверт ZeroTier сүлжээ тохируулаагүй байна.',
      };
      showToast(msgs[result.error] || `ZeroTier алдаа: ${result.error}`, 'error', 10000);
    }
  });

  // ── Хувилбар харуулах + гараар шалгах ─────────────────
  window.api.getAppVersion?.().then(v => {
    const el = document.getElementById('app-version');
    if (el) el.textContent = v || '—';
  });

  document.getElementById('btn-check-update')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-check-update');
    btn.disabled = true;
    btn.textContent = 'Шалгаж байна...';
    setUpdateMsg('', '');
    try {
      const res = await window.api.checkForUpdates();
      if (res?.error === 'dev') {
        setUpdateMsg('Dev горимд update шалгах боломжгүй.', 'warn');
      } else if (res?.error) {
        setUpdateMsg('Шалгах үед алдаа гарлаа: ' + res.error, 'error');
      } else {
        setUpdateMsg('Шалгаж байна — шинэ хувилбар байвал автоматаар татна.', 'info');
      }
    } catch {
      setUpdateMsg('Серверт холбогдож чадсангүй.', 'error');
    }
    btn.disabled = false;
    btn.innerHTML = `<svg class="btn-icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg> Шинэчлэл шалгах`;
  });
}

function setUpdateMsg(msg, type) {
  const el = document.getElementById('update-check-msg');
  if (!el) return;
  const colors = { info: 'var(--accent,#7c5cbf)', success: 'var(--success,#4caf50)', warn: '#f0a500', error: 'var(--danger,#e53935)' };
  el.textContent = msg;
  el.style.color = colors[type] || '';
}

function setUserUI(user) {
  document.getElementById('user-name').textContent = user.username;
  const av = document.getElementById('user-avatar');
  if (user.avatar_url) { av.src = user.avatar_url; av.style.display = 'block'; }
}

// ── Имэйл нэвтрэх ────────────────────────────────────────
document.getElementById('btn-email-login').onclick = async (e) => {
  const btn     = e.currentTarget;
  const email    = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl    = document.getElementById('login-error');
  errEl.textContent = '';
  if (!email || !password) { errEl.textContent = 'Бүх талбарыг бөглөнө үү'; return; }
  btn.disabled = true; btn.textContent = 'Нэвтэрч байна...';
  try {
    const { token, user } = await window.api.emailLogin({ email, password });
    currentUser = user;
    setUserUI(user);
    showPage('page-main');
    loadRooms();
    connectSocket();
    loadUnreadDMCounts();
    if (!localStorage.getItem('onboarding_done')) setTimeout(() => startOnboarding(), 600);
  } catch (err) {
    errEl.textContent = err.message || 'Нэвтрэхэд алдаа гарлаа';
    btn.disabled = false; btn.textContent = 'Нэвтрэх';
  }
};

document.getElementById('login-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-email-login').click();
});

// ── Нууц үг сэргээх (Forgot Password) ───────────────────
function showLoginForm()  { showAuthPanel('auth-login');  }
function showForgotForm() { showAuthPanel('auth-forgot'); }

function showAuthPanel(id) {
  ['auth-login', 'auth-register', 'auth-forgot'].forEach(p => {
    const el = document.getElementById(p);
    if (el) el.classList.toggle('hidden', el.id !== id);
  });
}

document.getElementById('btn-forgot-password').onclick = () => {
  showForgotForm();
  document.getElementById('forgot-step-1').classList.remove('hidden');
  document.getElementById('forgot-step-2').classList.add('hidden');
  document.getElementById('forgot-error').textContent = '';
};

document.getElementById('btn-back-to-login').onclick = () => showLoginForm();

document.getElementById('btn-forgot-send').onclick = async (e) => {
  const btn   = e.currentTarget;
  const email = document.getElementById('forgot-email').value.trim();
  const errEl = document.getElementById('forgot-error');
  errEl.textContent = '';
  if (!email) { errEl.textContent = 'Имэйл оруулна уу'; return; }
  btn.disabled = true; btn.textContent = '...';
  try {
    const data = await window.api.forgotPassword(email);
    // Show the reset token to the user (they copy it)
    document.getElementById('forgot-token-display').textContent = data.resetToken;
    document.getElementById('forgot-step-1').classList.add('hidden');
    document.getElementById('forgot-step-2').classList.remove('hidden');
  } catch (err) {
    errEl.textContent = err.message || 'Алдаа гарлаа';
  } finally {
    btn.disabled = false; btn.textContent = 'Код авах';
  }
};

document.getElementById('btn-forgot-reset').onclick = async (e) => {
  const btn      = e.currentTarget;
  const token    = document.getElementById('forgot-token-input').value.trim();
  const newPw    = document.getElementById('forgot-new-password').value;
  const errEl    = document.getElementById('forgot-reset-error');
  errEl.textContent = '';
  if (!token || !newPw) { errEl.textContent = 'Бүх талбарыг бөглөнө үү'; return; }
  if (newPw.length < 6) { errEl.textContent = 'Нууц үг хамгийн багадаа 6 тэмдэгт'; return; }
  btn.disabled = true; btn.textContent = '...';
  try {
    await window.api.resetPassword(token, newPw);
    showLoginForm();
    document.getElementById('login-error').textContent = '';
    // Show success briefly
    const errLogin = document.getElementById('login-error');
    errLogin.style.color = 'var(--green)';
    errLogin.textContent = '✓ Нууц үг амжилттай шинэчлэгдлээ. Нэвтэрнэ үү.';
    setTimeout(() => { errLogin.textContent = ''; errLogin.style.color = ''; }, 5000);
  } catch (err) {
    errEl.textContent = err.message || 'Token буруу эсвэл хугацаа дууссан';
  } finally {
    btn.disabled = false; btn.textContent = 'Нууц үг шинэчлэх';
  }
};

// ── Нууц үг харах/нуух toggle ────────────────────────────
document.querySelectorAll('.btn-eye').forEach(btn => {
  btn.addEventListener('click', () => {
    const input = document.getElementById(btn.dataset.target);
    if (!input) return;
    const isHidden = input.type === 'password';
    input.type = isHidden ? 'text' : 'password';
    btn.textContent = isHidden ? '🙈' : '👁';
  });
});

// ── Бүртгэл ──────────────────────────────────────────────
document.getElementById('btn-register').onclick = async (e) => {
  const btn      = e.currentTarget;
  const username = document.getElementById('reg-username').value.trim();
  const email    = document.getElementById('reg-email').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-password-confirm').value;
  const errEl    = document.getElementById('reg-error');
  errEl.textContent = '';
  if (!username || !email || !password || !confirm) { errEl.textContent = 'Бүх талбарыг бөглөнө үү'; return; }
  if (password !== confirm) { errEl.textContent = 'Нууц үг таарахгүй байна'; return; }
  btn.disabled = true; btn.textContent = 'Бүртгэж байна...';
  try {
    const { token, user } = await window.api.register({ username, email, password });
    currentUser = user;
    setUserUI(user);
    showPage('page-main');
    loadRooms();
    connectSocket();
    loadUnreadDMCounts();
    if (!localStorage.getItem('onboarding_done')) setTimeout(() => startOnboarding(), 600);
  } catch (err) {
    errEl.textContent = err.message || 'Бүртгэхэд алдаа гарлаа';
    btn.disabled = false; btn.textContent = 'Бүртгүүлэх';
  }
};

document.getElementById('btn-login').onclick       = () => window.api.login();
document.getElementById('btn-discord-reg').onclick = () => window.api.login();

// QR код үүсгэх
async function loadQR() {
  const img     = document.getElementById('qr-img');
  const loading = document.getElementById('qr-loading');
  if (!img || !loading) return;
  img.style.display = 'none';
  loading.style.display = 'block';
  loading.textContent = 'Ачааллаж байна...';
  try {
    const { dataUrl } = await window.api.getQR();
    img.src = dataUrl;
    img.style.display = 'block';
    loading.style.display = 'none';
  } catch {
    loading.textContent = 'QR үүсгэж чадсангүй';
  }
}
document.getElementById('btn-refresh-qr').onclick = loadQR;

// ── Header товчнууд ───────────────────────────────────────
document.getElementById('btn-logout').onclick = async () => {
  await window.api.logout();
  if (socket) socket.disconnect();
  currentUser = null;
  showPage('page-login');
  loadQR();
};

document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.onclick = () => showTab(btn.dataset.tab);
});

// ── DM panel tabs ──────────────────────────────────────────
document.querySelectorAll('.dm-tab').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('.dm-tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.dm-tab-content').forEach(c => c.classList.remove('active'));
    btn.classList.add('active');
    activeDmTab = btn.dataset.dmTab;
    const content = document.getElementById(`dm-tab-${activeDmTab}`);
    if (content) content.classList.add('active');
  };
});

// Найзуудын тусдаа цонх нээх товч
document.getElementById('btn-open-friends-window')?.addEventListener('click', () => {
  window.api.openFriendsWindow?.();
});

// ── Lobby — өрөөнүүд ─────────────────────────────────────
async function loadRooms() {
  const waiting = document.getElementById('rooms-waiting');
  const playing = document.getElementById('rooms-playing');
  waiting.innerHTML = renderRoomsSkeleton();
  playing.innerHTML = '';
  try {
    const rooms = await window.api.getRooms();
    roomsCache = {};
    rooms.forEach(r => { roomsCache[String(r.id)] = r; });
    populateGameTypeFilter(rooms);
    renderFilteredRooms();
  } catch {
    waiting.innerHTML = '<p class="empty-text">Серверт холбогдож чадсангүй</p>';
  }
}

// Тоглоомын төрлийн filter dropdown-г populate хийх
function populateGameTypeFilter(rooms) {
  const sel = document.getElementById('room-filter-type');
  if (!sel) return;
  const prev = sel.value;
  const types = new Set();
  rooms.forEach(r => { if (r.game_type) types.add(r.game_type); });
  configuredGames.forEach(g => { if (g.name) types.add(g.name); });
  const sorted = [...types].sort();
  sel.innerHTML = '<option value="">Бүх төрөл</option>'
    + sorted.map(t => `<option value="${escHtml(t)}">${escHtml(t)}</option>`).join('');
  if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
}

// Шүүлтүүр + эрэмбэлэлт хийж render хийх
function renderFilteredRooms() {
  const waiting = document.getElementById('rooms-waiting');
  const playing = document.getElementById('rooms-playing');
  if (!waiting || !playing) return;

  const allRooms = Object.values(roomsCache);
  const filtered = getFilteredRooms(allRooms);
  const waitRooms = filtered.filter(r => r.status === 'waiting');
  const playRooms = filtered.filter(r => r.status === 'playing');

  const search = (document.getElementById('room-search')?.value || '').trim();
  const filterType = document.getElementById('room-filter-type')?.value || '';
  const hasFilter = search || filterType;
  const noResultMsg = hasFilter
    ? '<p class="empty-text">Хайлтад тохирох өрөө олдсонгүй</p>'
    : '';

  waiting.innerHTML = waitRooms.length
    ? waitRooms.map((r, i) => roomCard(r, false, i)).join('')
    : (noResultMsg || '<p class="empty-text">Одоогоор нээлттэй өрөө байхгүй</p>');
  playing.innerHTML = playRooms.length
    ? playRooms.map((r, i) => roomCard(r, true, i)).join('')
    : (noResultMsg || '<p class="empty-text">Одоогоор тоглолт явагдахгүй байна</p>');
}

// Rooms жагсаалтыг шүүж, эрэмбэлэх
function getFilteredRooms(rooms) {
  const search = (document.getElementById('room-search')?.value || '').trim().toLowerCase();
  const filterType = document.getElementById('room-filter-type')?.value || '';
  const sortBy = document.getElementById('room-sort')?.value || 'newest';

  let result = rooms;

  // Нэр / эзнээр хайлт
  if (search) {
    result = result.filter(r =>
      (r.name || '').toLowerCase().includes(search) ||
      (r.host_name || '').toLowerCase().includes(search)
    );
  }

  // Тоглоомын төрлөөр шүүх
  if (filterType) {
    result = result.filter(r => r.game_type === filterType);
  }

  // Эрэмбэлэх
  result = [...result];
  switch (sortBy) {
    case 'players-desc':
      result.sort((a, b) => (b.player_count || 0) - (a.player_count || 0));
      break;
    case 'players-asc':
      result.sort((a, b) => (a.player_count || 0) - (b.player_count || 0));
      break;
    case 'name':
      result.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      break;
    // 'newest' — серверийн анхны дарааллыг хэвээр ашиглана
  }

  return result;
}

// Filter event listeners (debounce-тай хайлт)
let _roomSearchTimer = null;
document.getElementById('room-search')?.addEventListener('input', () => {
  clearTimeout(_roomSearchTimer);
  _roomSearchTimer = setTimeout(() => renderFilteredRooms(), 200);
});
document.getElementById('room-filter-type')?.addEventListener('change', () => renderFilteredRooms());
document.getElementById('room-sort')?.addEventListener('change', () => renderFilteredRooms());

function roomCard(r, inProgress, idx = 0) {
  const myId     = String(currentUser?.id);
  const isMyRoom = String(r.host_id) === myId ||
                   (r.members || []).some(m => String(m.id) === myId);
  const memberSpans = (r.members || []).map(m => {
    const mid = m.id ? String(m.id) : '';
    const mname = m.name || m;
    return `<span class="clickable-name" data-user-id="${mid}">${escHtml(mname)}</span>`;
  }).join(', ');

  const lockIcon = r.has_password ? '<span class="room-lock">🔒</span>' : '';
  const modeBadge = r.game_mode ? `<span class="badge mode-badge">${escHtml(r.game_mode)}</span>` : '';
  const desc = (r.description || '').trim();
  const descHtml = desc ? `<div class="room-desc">${escHtml(desc)}</div>` : '';

  let joinBtn;
  if (isMyRoom) {
    joinBtn = `<button class="btn btn-sm btn-primary room-action-btn" data-action="rejoin" data-id="${r.id}" data-host="${r.host_id}" data-ishost="${String(r.host_id) === myId}">↩ Буцах</button>`;
  } else if (inProgress) {
    joinBtn = `<button class="btn btn-sm btn-primary btn-with-icon room-action-btn" data-action="join-playing" data-id="${r.id}" data-host="${r.host_id}"><svg class="btn-icon-svg" style="width:13px;height:13px"><use href="#ico-join"/></svg> Нэгдэх</button>`;
  } else {
    joinBtn = `<button class="btn btn-primary btn-sm room-action-btn" data-action="join" data-id="${r.id}" data-host="${r.host_id}" data-pass="${r.has_password}">Нэгдэх</button>`;
  }

  return `
    <div class="room-card ${inProgress ? 'room-playing' : ''} ${isMyRoom ? 'room-mine' : ''}" style="animation-delay:${idx * 0.05}s">
      <div class="room-card-header">
        <span class="badge game-badge" style="background:${gameTypeColor(r.game_type)}">${escHtml(r.game_type)}</span>
        ${modeBadge}
        ${lockIcon}
      </div>
      <div class="room-card-title">
        <span class="room-name">${escHtml(r.name)}</span>
        ${isMyRoom ? '<span class="my-room-tag">Миний өрөө</span>' : ''}
      </div>
      ${descHtml}
      <div class="room-card-info">
        <span>👤 ${escHtml(r.host_name)}</span>
        <span>👥 ${r.player_count}/${r.max_players}</span>
      </div>
      ${memberSpans ? `<div class="room-members">${memberSpans}</div>` : ''}
      <div class="room-card-footer">
        <div></div>
        ${joinBtn}
      </div>
    </div>
  `;
}

function rejoinMyRoom(id, name, gameType, hostId, isHost) {
  const cached = roomsCache[id] || {};
  enterRoom(id, name, gameType, isHost, hostId, cached.status, cached.zerotier_network_id);
}

async function joinPlayingRoom(id, name, gameType, hostId) {
  if (!await showConfirm('Тоглолтод нэгдэх', `"${name}" тоглолтод нэгдэх үү? "${gameType}" тоглоом нээгдэнэ.`)) return;
  try {
    await window.api.launchGame(gameType);
  } catch (err) {
    showToast(`Тоглоом нээхэд алдаа гарлаа: ${err.message}`, 'error');
  }
}

document.getElementById('btn-refresh').onclick = loadRooms;

// Room card дотор нэр дарахад profile нээх
document.addEventListener('click', e => {
  const nameEl = e.target.closest('.room-members .clickable-name');
  if (nameEl && nameEl.dataset.userId) {
    e.stopPropagation();
    openUserProfile(nameEl.dataset.userId);
    return;
  }
});

// Өрөөний товч event delegation (data-attribute ашиглан)
document.addEventListener('click', e => {
  const btn = e.target.closest('.room-action-btn');
  if (!btn) return;
  const id     = btn.dataset.id;
  const hostId = btn.dataset.host;
  const room   = roomsCache[id];
  if (!room) return;
  const action = btn.dataset.action;
  if (action === 'join') {
    joinRoom(id, room.name, room.game_type, room.has_password, hostId);
  } else if (action === 'join-playing') {
    joinPlayingRoom(id, room.name, room.game_type, hostId);
  } else if (action === 'rejoin') {
    const isHost = btn.dataset.ishost === 'true';
    rejoinMyRoom(id, room.name, room.game_type, hostId, isHost);
  }
});

// Хурдан тоглолт
document.getElementById('btn-quickmatch').onclick = async () => {
  const gameType = configuredGames[0]?.name;
  if (!gameType) { showToast('Эхлээд Тохируулга таб-д тоглоом нэмнэ үү', 'warning'); return; }
  const btn = document.getElementById('btn-quickmatch');
  btn.disabled = true; btn.textContent = '⏳ ...';
  try {
    const result = await window.api.quickMatch(gameType);
    const room = result.room;
    const isHost = !result.joined && String(room.host_id) === String(currentUser?.id);
    enterRoom(String(room.id), room.name, room.game_type, isHost, String(room.host_id), room.status, room.zerotier_network_id);
  } catch (err) {
    showToast(`Хурдан тоглолт: ${err.message}`, 'error');
  } finally {
    btn.disabled = false; btn.textContent = '⚡ Хурдан';
  }
};

// Өрөө үүсгэх форм
document.getElementById('btn-create-room').onclick = () => {
  const f = document.getElementById('create-room-form');
  const isHidden = f.style.display === 'none' || f.style.display === '';
  f.style.display = isHidden ? 'block' : 'none';
  if (isHidden) populateRoomTypeSelect(); // Тоглоомуудын жагсаалтыг шинэчлэх
};
document.getElementById('btn-cancel-room').onclick = () => {
  document.getElementById('create-room-form').style.display = 'none';
};
document.getElementById('room-has-password').onchange = function () {
  document.getElementById('room-password').style.display = this.checked ? 'block' : 'none';
};
document.getElementById('btn-submit-room').onclick = async () => {
  const name        = document.getElementById('room-name').value.trim();
  const game_type   = document.getElementById('room-type').value;
  const game_mode   = document.getElementById('room-mode')?.value || '';
  const max_players = parseInt(document.getElementById('room-max').value);
  const description = document.getElementById('room-desc')?.value?.trim() || '';
  const hasPass     = document.getElementById('room-has-password').checked;
  const password    = hasPass ? document.getElementById('room-password').value : null;
  if (!name)             { showToast('Өрөөний нэр оруулна уу', 'warning'); return; }
  if (!game_type)        { showToast('Тоглоом сонгоно уу (Тохируулга таб-д тоглоом нэмнэ үү)', 'warning'); return; }
  if (hasPass && !password) { showToast('Нууц үг оруулна уу', 'warning'); return; }
  async function _doCreateRoom() {
    const room = await window.api.createRoom({ name, max_players, game_type, password, description, game_mode });
    document.getElementById('create-room-form').style.display = 'none';
    document.getElementById('room-name').value = '';
    document.getElementById('room-desc').value = '';
    document.getElementById('room-mode').value = '';
    document.getElementById('room-has-password').checked = false;
    document.getElementById('room-password').value = '';
    document.getElementById('room-password').style.display = 'none';
    showToast(`"${room.name}" өрөө үүслээ`, 'success');
    enterRoom(room.id, room.name, room.game_type, true, null, room.status, room.zerotier_network_id);
  }
  try {
    await _doCreateRoom();
  } catch (err) {
    if (err.message?.includes('аль хэдийн')) {
      // Хуучин өрөө DB-д үлдсэн — хэрэглэгчээс хаах зөвшөөрөл авах
      const myRoom = await window.api.getMyRoom().catch(() => null);
      const oldName = myRoom?.name || 'хуучин өрөө';
      const ok = await showConfirm('Хуучин өрөө байна', `"${oldName}" гэсэн хуучин өрөөтэй байна. Хаагаад шинэ өрөө үүсгэх үү?`);
      if (!ok) return;
      try {
        if (myRoom) await window.api.closeRoom(myRoom.id);
        await _doCreateRoom();
      } catch (err2) { showToast(`Алдаа: ${err2.message}`, 'error'); }
    } else {
      showToast(`Алдаа: ${err.message}`, 'error');
    }
  }
};

// ── Өрөөнд нэгдэх ────────────────────────────────────────
let _pendingJoin = null;

async function joinRoom(id, name, gameType, hasPassword, hostId) {
  if (hasPassword) {
    _pendingJoin = { id, name, gameType, hostId };
    document.getElementById('join-password').value = '';
    document.getElementById('join-password-error').textContent = '';
    document.getElementById('password-modal').style.display = 'flex';
    return;
  }
  await doJoinRoom(id, name, gameType, null, hostId);
}

async function doJoinRoom(id, name, gameType, password, hostId) {
  try {
    await window.api.joinRoom(id, password);
    enterRoom(id, name, gameType, false, hostId);
  } catch (err) {
    if (err.message?.includes('Нууц үг шаардлагатай')) {
      joinRoom(id, name, gameType, true, hostId);
    } else {
      showToast(`Алдаа: ${err.message}`, 'error');
    }
  }
}

document.getElementById('btn-join-confirm').onclick = async () => {
  if (!_pendingJoin) return;
  const password = document.getElementById('join-password').value;
  const errEl    = document.getElementById('join-password-error');
  errEl.textContent = '';
  try {
    await window.api.joinRoom(_pendingJoin.id, password);
    document.getElementById('password-modal').style.display = 'none';
    enterRoom(_pendingJoin.id, _pendingJoin.name, _pendingJoin.gameType, false, _pendingJoin.hostId);
    _pendingJoin = null;
  } catch (err) {
    errEl.textContent = err.message || 'Нууц үг буруу';
  }
};
document.getElementById('btn-join-cancel').onclick = () => {
  document.getElementById('password-modal').style.display = 'none';
  _pendingJoin = null;
};
document.getElementById('join-password').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('btn-join-confirm').click();
});

// ── Өрөөнд орох ──────────────────────────────────────────
// Үндсэн цонхноос дуудагдана → шинэ цонх нээнэ
function enterRoom(id, name, gameType, isHost, hostId, status, ztNetId) {
  const resolvedHostId = hostId ? String(hostId) : String(currentUser?.id);
  window.api.openRoomWindow({ id, name, gameType, isHost, hostId: resolvedHostId, status: status || '', zerotierNetworkId: ztNetId || '' });
}

// Өрөөний цонхны UI тохируулга (room цонхноос шууд дуудагдана)
function _enterRoomUI(id, name, gameType, isHost, hostId, status, ztNetId) {
  // Хуучин relay зогсоож, state reset хийх
  _hostRelayStarted = false;
  _launchInProgress = false;
  try { window.api.stopRelay(); } catch {}
  const cached = roomsCache[id] || {};
  currentRoom = { id, name, gameType, isHost, hostId: hostId || String(currentUser?.id), maxPlayers: cached.max_players || 10 };

  document.getElementById('room-title').textContent = name;
  document.getElementById('room-badge').textContent = gameType;
  document.getElementById('room-badge').className   = 'badge game-badge';
  document.getElementById('room-badge').style.background = gameTypeColor(gameType);
  document.getElementById('room-info-text').textContent = `${name} | ${gameType}`;
  document.getElementById('chat-messages').innerHTML  = '';
  document.getElementById('members-list').innerHTML   = '';
  // Хост: "Өрөөг хаах" харуулж "Гарах" нуух — хост гарахад room устдаг учир хоёулаа байх хэрэггүй
  document.getElementById('btn-close-room').style.display = isHost ? 'block' : 'none';
  document.getElementById('btn-leave-room').style.display = isHost ? 'none' : 'block';
  document.getElementById('btn-close-room').classList.remove('hidden');

  // Host: гишүүний дээд хязгаар тохируулах
  const maxRow = document.getElementById('max-players-row');
  if (maxRow) {
    if (isHost) {
      maxRow.classList.remove('hidden');
      const sel = document.getElementById('select-max-players');
      sel.value = String(currentRoom.maxPlayers || 10);
      sel.onchange = async () => {
        try {
          await window.api.updateRoom(currentRoom.id, { max_players: Number(sel.value) });
          currentRoom.maxPlayers = Number(sel.value);
          appendSysMsg(`⚙ Дээд хязгаар: ${sel.value} тоглогч`);
        } catch {}
      };
    } else {
      maxRow.classList.add('hidden');
    }
  }

  // Host биш бол "Тоглолт эхлүүлэх" товчийг нуух — host эхлүүлэхэд автоматаар нээгдэнэ
  const launchBtn = document.getElementById('btn-launch-wc3');
  if (status === 'playing') {
    launchBtn.style.display = '';
    setLaunchBtnRejoin();
  } else if (isHost) {
    launchBtn.style.display = '';
    resetLaunchBtn(isHost);
  } else {
    // Бусад тоглогч: товч нуугдана, host эхлүүлэхэд WC3 автомат нээгдэнэ
    launchBtn.style.display = 'none';
  }

  // Найз урих товч (бүх тоглогчид харуулна)
  const inviteBtn = document.getElementById('btn-invite-friends');
  if (inviteBtn) inviteBtn.style.display = 'block';
  const inviteDD = document.getElementById('invite-friends-dropdown');
  if (inviteDD) inviteDD.classList.add('hidden');

  showPage('page-room');

  if (socket && currentUser) {
    socket.emit('room:join', { roomId: id });
    // Өрөөний ZT IP-уудыг авах
    roomZtIps = {};
    socket.emit('room:get_zt_ips', { roomId: id });
    // ZeroTier IP-г серверт мэдэгдэх (relay-д хэрэгтэй) — retry логиктой
    (async () => {
      for (let attempt = 0; attempt < 5; attempt++) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const myIp = await window.api.getZerotierIp();
          if (myIp && socket) {
            socket.emit('room:zt_ip', { roomId: id, ip: myIp });
            console.log('[ZT] IP бүртгэгдлээ:', myIp);
            return;
          }
        } catch {}
      }
      console.warn('[ZT] IP бүртгэж чадсангүй (5 оролдлого)');
    })();
  }
  appendSysMsg(`"${name}" өрөөнд нэгдлээ.`);
}

// ── Өрөөний товчнууд ──────────────────────────────────────
document.getElementById('btn-leave-room').onclick = async () => {
  if (!currentRoom) return;
  _hostRelayStarted = false;
  try { await window.api.stopRelay(); } catch {}
  if (socket && currentUser) {
    socket.emit('room:leave', { roomId: currentRoom.id });
  }
  try { await window.api.leaveRoom(currentRoom.id); } catch {}
  currentRoom = null;
  roomZtIps = {};
  if (isRoomMode()) { window.close(); }
  else { showPage('page-main'); loadRooms(); }
};

document.getElementById('btn-close-room').onclick = async () => {
  if (!currentRoom) return;
  if (!await showConfirm('Өрөө хаах', `"${currentRoom.name}" өрөөг хаах уу? Бүх тоглогчид гарна.`)) return;
  _hostRelayStarted = false;
  roomZtIps = {};
  try { await window.api.stopRelay(); } catch {}
  try {
    await window.api.closeRoom(currentRoom.id);
    currentRoom = null;
    if (isRoomMode()) { window.close(); }
    else { showPage('page-main'); loadRooms(); }
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  }
};

// Launch товчийг "↩ Дахин нэвтрэх" горимд тавих
function setLaunchBtnRejoin() {
  const btn = document.getElementById('btn-launch-wc3');
  if (!btn) return;
  btn.querySelector('span').textContent = '↩ Дахин нэвтрэх';
  btn.classList.remove('btn-primary');
  btn.classList.add('btn-success');
}

// Launch товчийг анхны горимд буцаах
function resetLaunchBtn(isHost) {
  const btn = document.getElementById('btn-launch-wc3');
  if (!btn) return;
  btn.querySelector('span').textContent = isHost ? 'Тоглолт эхлүүлэх' : 'Тоглоом эхлүүлэх';
  btn.classList.remove('btn-success');
  btn.classList.add('btn-primary');
}

// ── ZeroTier setup flag (апп эхлэхэд initZeroTier ажиллаж байгааг мэдэх) ──
let _ztSetupInProgress = false;

// Host IP-г UI-д харуулах helper (no-op when elements removed)
function showHostIp(ip) {
  const el = document.getElementById('zt-host-ip');
  const val = document.getElementById('zt-host-ip-val');
  if (el && val && ip) {
    val.textContent = ip;
    el.style.display = 'block';
  }
}

// Тоглоом эхлүүлэх / дахин нэвтрэх
let _hostRelayStarted = false;
let _launchInProgress = false;
document.getElementById('btn-launch-wc3').onclick = async () => {
  if (_launchInProgress) return; // Double-click хамгаалалт
  _launchInProgress = true;
  const gameType = currentRoom?.gameType || '';
  const isRejoin = document.getElementById('btn-launch-wc3').querySelector('span')?.textContent?.includes('Дахин');
  appendSysMsg(isRejoin ? '↩ WC3 дахин нээж байна...' : `"${gameType}" тоглоом эхлүүлж байна...`);

  try {
    // WC3-г ЭХЛЭЭД нээнэ — port 6112-г WC3 эзэлнэ
    await window.api.launchGame(gameType);
    appendSysMsg('✓ Тоглоом нээгдлээ. LAN горим сонгоно уу.');
    if (!isRejoin && currentRoom?.isHost) {
      try {
        await window.api.startRoom(currentRoom.id);
        appendSysMsg('▶ Тоглолт эхэллээ!');
        if (socket) socket.emit('room:game_started');
        setLaunchBtnRejoin();
        // Host IP-г олж бусад тоглогчдод broadcast хийх
        try {
          const ip = await window.api.getZerotierIp();
          if (ip && socket) {
            socket.emit('room:host_ip', { roomId: currentRoom.id, ip });
            showHostIp(ip);
            appendSysMsg(`🎯 Таны IP: ${ip}`);
          }
        } catch {}
        // WC3 port 6112-г bind хийх хугацаа өгөөд ДАРАА нь relay эхлүүлнэ
        // (reuseAddr-тай учир WC3-тай хамт ажиллана)
        setTimeout(async () => {
          if (!_hostRelayStarted && currentRoom?.isHost) {
            const myId = String(currentUser?.id);
            const playerIps = Object.entries(roomZtIps || {})
              .filter(([uid]) => uid !== myId)
              .map(([, ip]) => ip);
            if (playerIps.length > 0) {
              try {
                await window.api.startHostRelay(playerIps);
                _hostRelayStarted = true;
                appendSysMsg(`📡 Relay: ${playerIps.length} тоглогчид дамжуулж байна`);
              } catch {}
            }
            // Шинэ IP-уудыг авах (relay эхэлсний дараа)
            socket.emit('room:get_zt_ips', { roomId: currentRoom.id });
          }
        }, 3000);
      } catch {}
    }
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  } finally {
    _launchInProgress = false;
  }
};

// ── Өрөөний чат ──────────────────────────────────────────
function appendMessage({ userId, username, text, time }) {
  const box  = document.getElementById('chat-messages');
  const isMe = username === currentUser?.username;
  const t    = new Date(time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : 'other'}`;
  div.dataset.time = time;
  div.dataset.userId = userId || '';
  const nameEl = isMe ? 'Та' : `<span class="clickable-name" data-user-id="${userId}">${escHtml(username)}</span>`;
  const deleteBtn = isMe ? `<button class="msg-delete" title="Устгах">🗑️</button>` : '';
  div.innerHTML = `
    <div class="msg-header">${nameEl}${deleteBtn}</div>
    <div class="msg-bubble">${parseMentions(escHtml(text), !isMe)}</div>
    <div class="msg-time">${t}</div>
  `;
  if (!isMe && userId) {
    div.querySelector('.clickable-name')?.addEventListener('click', () => openUserProfile(userId));
  }
  if (isMe) {
    div.querySelector('.msg-delete')?.addEventListener('click', () => {
      if (socket && currentRoom) socket.emit('chat:delete', { roomId: currentRoom.id, time });
    });
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function appendSysMsg(text) {
  const box = document.getElementById('chat-messages');
  if (!box) return;
  const div = document.createElement('div');
  div.className = 'sys-msg';
  div.textContent = text;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function sendMessage() {
  const input = document.getElementById('chat-input');
  const text  = input.value.trim();
  if (!text || !currentRoom || !socket) return;
  socket.emit('chat:message', { roomId: currentRoom.id, text });
  input.value = '';
}

document.getElementById('btn-send').onclick = sendMessage;
document.getElementById('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMessage();
});

// ── Тоглогчдын жагсаалт ──────────────────────────────────
function renderMembers(members) {
  const ul      = document.getElementById('members-list');
  const countEl = document.getElementById('members-count');
  const isHost  = currentRoom?.isHost;
  const myId    = String(currentUser?.id);
  const hostId  = currentRoom?.hostId;

  if (countEl) countEl.textContent = `(${members.length})`;

  ul.innerHTML = members.map(m => {
    const id   = m.id   !== undefined ? String(m.id) : null;
    const name = m.name !== undefined ? m.name : m;
    const isMe       = id ? id === myId   : name === currentUser?.username;
    const isRoomHost = id ? id === hostId : false;
    const kickBtn = (isHost && !isMe)
      ? `<button class="btn btn-sm btn-danger kick-btn" data-id="${id}" data-name="${name}">Kick</button>`
      : '';
    const nameSpan = (!isMe && id) ? `<span class="clickable-name" data-user-id="${id}">${name}</span>` : name;
    const ztIp = id && roomZtIps[id] ? `<span class="member-zt-ip">${roomZtIps[id]}</span>` : '';
    return `<li class="${isMe ? 'me' : ''}">
      <div class="member-info">
        <div>${isRoomHost ? '👑 ' : ''}${nameSpan}${isMe ? ' (Та)' : ''}</div>
        ${ztIp}
      </div>
      ${kickBtn}
    </li>`;
  }).join('');

  ul.querySelectorAll('.kick-btn').forEach(btn => {
    btn.onclick = (e) => { e.stopPropagation(); kickPlayer(btn.dataset.id, btn.dataset.name); };
  });
  ul.querySelectorAll('.clickable-name').forEach(el => {
    el.addEventListener('click', () => openUserProfile(el.dataset.userId));
  });
}

// (Ready system устгагдсан — launch товч үргэлж идэвхтэй)

// ── Өрөөнөөс найз урих ──────────────────────────────────
document.getElementById('btn-invite-friends').onclick = () => {
  const dd = document.getElementById('invite-friends-dropdown');
  const isHidden = dd.classList.contains('hidden');
  if (isHidden) {
    renderInviteFriendsList();
    dd.classList.remove('hidden');
  } else {
    dd.classList.add('hidden');
  }
};

function renderInviteFriendsList() {
  const ul = document.getElementById('invite-friends-list');
  const noEl = document.getElementById('invite-no-friends');
  if (!ul) return;

  const memberIds = new Set(
    (currentRoom?.members || []).map(m => String(m.id !== undefined ? m.id : ''))
  );
  const onlineFriends = myFriends.filter(f => onlineUserIds.has(String(f.id)));

  if (onlineFriends.length === 0) {
    ul.innerHTML = '';
    noEl.style.display = 'block';
    return;
  }
  noEl.style.display = 'none';

  ul.innerHTML = onlineFriends.map(f => {
    const fid = String(f.id);
    const inRoom = memberIds.has(fid);
    return `<li data-id="${fid}">
      <span class="invite-name">${escHtml(f.username)}</span>
      ${inRoom
        ? '<span class="invite-in-room">өрөөнд байна</span>'
        : `<button class="btn btn-primary btn-invite-send" data-id="${fid}" data-name="${escHtml(f.username)}">Урих</button>`
      }
    </li>`;
  }).join('');

  ul.querySelectorAll('.btn-invite-send').forEach(btn => {
    btn.onclick = () => {
      if (!currentRoom || !socket) return;
      socket.emit('room:invite', {
        toUserId: btn.dataset.id,
        roomId: currentRoom.id,
        roomName: currentRoom.name,
      });
      btn.disabled = true;
      btn.outerHTML = '<span class="invite-sent">Илгээгдлээ</span>';
      showToast(`${btn.dataset.name}-д урилга илгээлээ`, 'success', 3000);
    };
  });
}

async function kickPlayer(targetId, targetName) {
  if (!currentRoom || !targetId) return;
  if (!await showConfirm('Гаргах', `${targetName}-г өрөөнөөс гаргах уу?`)) return;
  try {
    await window.api.kickPlayer(currentRoom.id, targetId);
    appendSysMsg(`✓ ${targetName} гаргагдлаа`);
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  }
}

// ── Нийтийн лобби чат ────────────────────────────────────
const lobbyMessages = []; // Лобби чатын мессежүүд санах ойд хадгалагдана

function appendLobbyMessage({ userId, username, text, time }, isHistory = false) {
  // Санах ойд хадгалах
  lobbyMessages.push({ userId, username, text, time });
  // Хэт олон мессеж хуримтлагдахаас сэргийлэх (сүүлийн 200)
  if (lobbyMessages.length > 200) lobbyMessages.splice(0, lobbyMessages.length - 200);

  const box = document.getElementById('lobby-chat-messages');
  if (!box) return;
  _appendLobbyMsgDOM(box, { userId, username, text, time });

  if (username !== currentUser?.username && !isHistory) {
    const chatTab = document.getElementById('tab-chat');
    if (!chatTab?.classList.contains('active')) {
      chatUnreadCount++;
      updateChatBadge();
    }
  }
}

function _appendLobbyMsgDOM(box, { userId, username, text, time }) {
  const isMe = username === currentUser?.username;
  const t    = new Date(time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : 'other'}`;
  div.dataset.time = time;
  div.dataset.userId = userId || '';
  const nameEl = isMe ? 'Та' : `<span class="clickable-name" data-user-id="${userId}">${escHtml(username)}</span>`;
  const deleteBtn = isMe ? `<button class="msg-delete" title="Устгах">🗑️</button>` : '';
  div.innerHTML = `
    <div class="msg-header">${nameEl}${deleteBtn}</div>
    <div class="msg-bubble">${parseMentions(escHtml(text), !isMe)}</div>
    <div class="msg-time">${t}</div>
  `;
  if (!isMe && userId) {
    div.querySelector('.clickable-name')?.addEventListener('click', () => openUserProfile(userId));
  }
  if (isMe) {
    div.querySelector('.msg-delete')?.addEventListener('click', () => {
      if (socket) socket.emit('lobby:delete', { time });
    });
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}

function rerenderLobbyMessages() {
  const box = document.getElementById('lobby-chat-messages');
  if (!box || box.children.length > 0) return; // Аль хэдийн рендэрлэгдсэн бол дахин хийхгүй
  lobbyMessages.forEach(msg => _appendLobbyMsgDOM(box, msg));
  box.scrollTop = box.scrollHeight;
}

function sendLobbyMessage() {
  const input = document.getElementById('lobby-chat-input');
  const text  = input.value.trim();
  if (!text || !socket || !currentUser) return;
  socket.emit('lobby:chat', { text });
  input.value = '';
}

document.getElementById('btn-lobby-send').onclick = sendLobbyMessage;
document.getElementById('lobby-chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendLobbyMessage();
});

function updateChatBadge() {
  const badge = document.getElementById('chat-badge');
  if (!badge) return;
  if (chatUnreadCount > 0) {
    badge.textContent = chatUnreadCount;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ── Уншаагүй DM тоог серверээс авах ─────────────────────
async function loadUnreadDMCounts() {
  try {
    const counts = await window.api.getUnreadCount();
    Object.entries(counts).forEach(([userId, count]) => {
      if (!dmConversations[userId]) {
        dmConversations[userId] = { username: '', messages: [], unread: 0 };
      }
      dmConversations[userId].unread = count;
    });
    renderDMUsersBadges();
    const total = Object.values(counts).reduce((s, c) => s + c, 0);
    if (total > 0) {
      chatUnreadCount += total;
      updateChatBadge();
    }
  } catch {}
}

// ── Private мессеж (DM) — Floating Popup систем ──────────
function openDM(userId, username) {
  const uid = String(userId);

  // Popup аль хэдийн нээлттэй бол focus хийх
  if (activePopups.has(uid)) {
    const popup = activePopups.get(uid);
    if (popup.minimized) togglePopupMinimize(uid);
    popup.element.querySelector('.dm-popup-input').focus();
    return;
  }

  // Хамгийн ихдээ MAX_DM_POPUPS popup нээх
  if (activePopups.size >= MAX_DM_POPUPS) {
    const oldestKey = activePopups.keys().next().value;
    closeDMPopup(oldestKey);
  }

  createDMPopup(uid, username);
}

async function createDMPopup(userId, username) {
  const uid = String(userId);
  const container = document.getElementById('dm-popups-container');
  if (!container) return;

  if (!dmConversations[uid]) {
    dmConversations[uid] = { username, messages: [], unread: 0 };
  }
  dmConversations[uid].unread = 0;
  renderDMUsersBadges();

  const isOnline = onlineUserIds.has(Number(uid)) || onlineUserIds.has(uid);

  const popup = document.createElement('div');
  popup.className = 'dm-popup';
  popup.dataset.userId = uid;
  popup.innerHTML = `
    <div class="dm-popup-header">
      <div class="dm-popup-header-info">
        <span class="dm-popup-status ${isOnline ? 'online' : 'offline'}"></span>
        <span class="dm-popup-username">${escHtml(username)}</span>
        <span class="dm-popup-unread-badge">0</span>
      </div>
      <div class="dm-popup-header-actions">
        <button type="button" class="dm-popup-minimize-btn" title="Жижигрүүлэх">—</button>
        <button type="button" class="dm-popup-popout-btn" title="Тусдаа цонхоор нээх">↗</button>
        <button type="button" class="dm-popup-close-btn" title="Хаах">✕</button>
      </div>
    </div>
    <div class="dm-popup-body">
      <div class="dm-popup-messages"></div>
      <div class="dm-popup-typing"></div>
      <div class="dm-popup-input-row">
        <button type="button" class="dm-popup-emoji-btn" title="Emoji">😊</button>
        <input type="text" class="dm-popup-input" placeholder="Мессеж бичих..." />
        <button type="button" class="dm-popup-send-btn" title="Илгээх">
          <svg class="btn-icon-svg"><use href="#ico-send"/></svg>
        </button>
      </div>
    </div>
  `;

  container.appendChild(popup);

  activePopups.set(uid, {
    element: popup,
    minimized: false,
    emojiOpen: false,
    typingTimer: null,
    isTyping: false
  });

  setupPopupListeners(uid, popup, username);

  // Мессежийн түүх татах
  try {
    const history = await window.api.getDMHistory(userId);
    if (history.length > 0) {
      dmConversations[uid].messages = history.map(m => ({
        fromUsername: m.sender_username,
        fromUserId:   String(m.sender_id),
        text:         m.text,
        time:         m.created_at,
        id:           m.id,
      }));
    }
  } catch {}

  renderPopupMessages(uid);
  window.api.markDMRead(userId).catch(() => {});
  setTimeout(() => popup.querySelector('.dm-popup-input').focus(), 100);
}

function setupPopupListeners(uid, popup, username) {
  const input = popup.querySelector('.dm-popup-input');
  const sendBtn = popup.querySelector('.dm-popup-send-btn');
  const closeBtn = popup.querySelector('.dm-popup-close-btn');
  const minimizeBtn = popup.querySelector('.dm-popup-minimize-btn');
  const popoutBtn = popup.querySelector('.dm-popup-popout-btn');
  const header = popup.querySelector('.dm-popup-header');
  const emojiBtn = popup.querySelector('.dm-popup-emoji-btn');
  const state = activePopups.get(uid);

  const doSend = () => {
    const text = input.value.trim();
    if (!text || !socket) return;
    socket.emit('private:message', { toUserId: uid, text });
    input.value = '';
    if (state.emojiOpen) toggleEmojiPicker(uid);
  };

  sendBtn.onclick = doSend;
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doSend(); });

  // Typing indicator
  input.addEventListener('input', () => {
    if (!socket) return;
    if (!state.isTyping) {
      state.isTyping = true;
      socket.emit('typing:start', { toUserId: uid });
    }
    clearTimeout(state.typingTimer);
    state.typingTimer = setTimeout(() => {
      state.isTyping = false;
      socket.emit('typing:stop', { toUserId: uid });
    }, 2000);
  });

  closeBtn.onclick = (e) => { e.stopPropagation(); closeDMPopup(uid); };

  header.addEventListener('click', (e) => {
    if (e.target.closest('.dm-popup-header-actions')) return;
    togglePopupMinimize(uid);
  });

  minimizeBtn.onclick = (e) => { e.stopPropagation(); togglePopupMinimize(uid); };

  popoutBtn.onclick = (e) => {
    e.stopPropagation();
    closeDMPopup(uid);
    window.api.openDMWindow({ userId: uid, username });
  };

  emojiBtn.onclick = () => toggleEmojiPicker(uid);
}

function closeDMPopup(uid) {
  const state = activePopups.get(uid);
  if (!state) return;
  if (state.isTyping && socket) {
    socket.emit('typing:stop', { toUserId: uid });
  }
  state.element.style.animation = 'dm-popup-down 0.2s ease-in forwards';
  setTimeout(() => {
    state.element.remove();
    activePopups.delete(uid);
  }, 200);
}

function togglePopupMinimize(uid) {
  const state = activePopups.get(uid);
  if (!state) return;
  state.minimized = !state.minimized;
  state.element.classList.toggle('minimized', state.minimized);

  if (!state.minimized) {
    const badge = state.element.querySelector('.dm-popup-unread-badge');
    if (badge) { badge.style.display = 'none'; badge.textContent = '0'; }
    window.api.markDMRead(uid).catch(() => {});
    if (dmConversations[uid]) dmConversations[uid].unread = 0;
    renderDMUsersBadges();
    const msgBox = state.element.querySelector('.dm-popup-messages');
    setTimeout(() => {
      msgBox.scrollTop = msgBox.scrollHeight;
      state.element.querySelector('.dm-popup-input').focus();
    }, 50);
  }
}

function renderPopupMessages(uid) {
  const state = activePopups.get(uid);
  if (!state) return;
  const box = state.element.querySelector('.dm-popup-messages');
  const conv = dmConversations[uid];
  if (!conv || !box) return;
  box.innerHTML = '';

  if (conv.messages.length === 0) {
    box.innerHTML = `<p class="sys-msg" style="margin-top:20px">${escHtml(conv.username)}-д анхны мессеж илгээгээрэй 💬</p>`;
    return;
  }

  conv.messages.forEach(msg => {
    const isMe = msg.fromUsername === currentUser?.username;
    const t = new Date(msg.time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `msg ${isMe ? 'me' : 'other'}`;
    div.innerHTML = `
      <div class="msg-name">${isMe ? 'Та' : escHtml(msg.fromUsername)}</div>
      <div class="msg-bubble">${parseMentions(escHtml(msg.text), false)}</div>
      <div class="msg-time">${t}</div>
    `;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

// ── Emoji Picker ──────────────────────────────────────────
function toggleEmojiPicker(uid) {
  const state = activePopups.get(uid);
  if (!state) return;
  const body = state.element.querySelector('.dm-popup-body');
  let picker = body.querySelector('.emoji-picker');

  if (state.emojiOpen && picker) {
    picker.remove();
    state.emojiOpen = false;
    return;
  }

  picker = document.createElement('div');
  picker.className = 'emoji-picker';

  const catIcons = { smileys:'😀', people:'👋', animals:'🐶', food:'🍕',
                     activities:'⚽', objects:'💡', symbols:'❤️', flags:'🏳️' };

  picker.innerHTML = `
    <div class="emoji-picker-header">
      <div class="emoji-categories">
        ${Object.keys(EMOJI_DATA).map((cat, i) =>
          `<button type="button" class="emoji-cat-btn ${i===0?'active':''}" data-cat="${cat}">${catIcons[cat]}</button>`
        ).join('')}
      </div>
      <input type="text" class="emoji-search" placeholder="Emoji хайх..." />
    </div>
    <div class="emoji-grid"></div>
  `;

  const inputRow = body.querySelector('.dm-popup-input-row');
  body.insertBefore(picker, inputRow);
  state.emojiOpen = true;

  renderEmojiCategory(picker, 'smileys', uid);

  picker.querySelectorAll('.emoji-cat-btn').forEach(btn => {
    btn.onclick = () => {
      picker.querySelectorAll('.emoji-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEmojiCategory(picker, btn.dataset.cat, uid);
      picker.querySelector('.emoji-search').value = '';
    };
  });

  picker.querySelector('.emoji-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase().trim();
    if (!q) {
      const activeCat = picker.querySelector('.emoji-cat-btn.active')?.dataset.cat || 'smileys';
      renderEmojiCategory(picker, activeCat, uid);
      return;
    }
    const grid = picker.querySelector('.emoji-grid');
    const allEmojis = Object.values(EMOJI_DATA).flat();
    grid.innerHTML = allEmojis.map(em =>
      `<button type="button" class="emoji-item">${em}</button>`
    ).join('');
    wireEmojiClicks(grid, uid);
  });

  const closeOnOutside = (e) => {
    if (!picker.contains(e.target) && !e.target.classList.contains('dm-popup-emoji-btn')) {
      picker.remove();
      state.emojiOpen = false;
      document.removeEventListener('mousedown', closeOnOutside);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', closeOnOutside), 10);
}

function renderEmojiCategory(picker, category, uid) {
  const grid = picker.querySelector('.emoji-grid');
  const emojis = EMOJI_DATA[category] || [];
  grid.innerHTML = emojis.map(em =>
    `<button type="button" class="emoji-item">${em}</button>`
  ).join('');
  wireEmojiClicks(grid, uid);
}

function wireEmojiClicks(grid, uid) {
  grid.querySelectorAll('.emoji-item').forEach(btn => {
    btn.onclick = () => {
      const state = activePopups.get(uid);
      if (!state) return;
      const input = state.element.querySelector('.dm-popup-input');
      const start = input.selectionStart;
      const end = input.selectionEnd;
      const emoji = btn.textContent;
      input.value = input.value.substring(0, start) + emoji + input.value.substring(end);
      input.focus();
      const newPos = start + emoji.length;
      input.setSelectionRange(newPos, newPos);
    };
  });
}

// ── DM тусдаа цонх горимын функцүүд ────────────────────
async function initDMWindowMode(userId, username) {
  activeDmUserId = String(userId);
  if (!dmConversations[activeDmUserId]) {
    dmConversations[activeDmUserId] = { username, messages: [], unread: 0 };
  }
  dmConversations[activeDmUserId].unread = 0;
  document.getElementById('dm-window-title').textContent = username;
  document.title = `${username} — DM`;

  try {
    const history = await window.api.getDMHistory(userId);
    if (history.length > 0) {
      dmConversations[activeDmUserId].messages = history.map(m => ({
        fromUsername: m.sender_username,
        fromUserId:   String(m.sender_id),
        text:         m.text,
        time:         m.created_at,
        id:           m.id,
      }));
    }
  } catch {}
  renderDMWindowMessages();
  window.api.markDMRead(userId).catch(() => {});

  document.getElementById('dm-window-send').onclick = sendDMFromWindow;
  document.getElementById('dm-window-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') sendDMFromWindow();
  });
  // Typing indicator
  let _dmWinTyping = false, _dmWinTimer = null;
  document.getElementById('dm-window-input').addEventListener('input', () => {
    if (!activeDmUserId || !socket) return;
    if (!_dmWinTyping) { _dmWinTyping = true; socket.emit('typing:start', { toUserId: activeDmUserId }); }
    clearTimeout(_dmWinTimer);
    _dmWinTimer = setTimeout(() => { _dmWinTyping = false; socket.emit('typing:stop', { toUserId: activeDmUserId }); }, 2000);
  });
  setTimeout(() => document.getElementById('dm-window-input').focus(), 100);
}

function sendDMFromWindow() {
  const input = document.getElementById('dm-window-input');
  const text = input.value.trim();
  if (!text || !activeDmUserId || !socket) return;
  socket.emit('private:message', { toUserId: activeDmUserId, text });
  input.value = '';
}

function renderDMWindowMessages() {
  const box = document.getElementById('dm-window-messages');
  const conv = dmConversations[activeDmUserId];
  if (!conv || !box) return;
  box.innerHTML = '';
  if (conv.messages.length === 0) {
    box.innerHTML = `<p class="sys-msg" style="margin-top:20px">${escHtml(conv.username)}-д анхны мессеж илгээгээрэй</p>`;
    return;
  }
  conv.messages.forEach(msg => {
    const isMe = msg.fromUsername === currentUser?.username;
    const t = new Date(msg.time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
    const div = document.createElement('div');
    div.className = `msg ${isMe ? 'me' : 'other'}`;
    div.innerHTML = `
      <div class="msg-name">${isMe ? 'Та' : escHtml(msg.fromUsername)}</div>
      <div class="msg-bubble">${escHtml(msg.text)}</div>
      <div class="msg-time">${t}</div>`;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function handleIncomingDM({ fromUsername, fromUserId, text, time }) {
  const uid = String(fromUserId);
  if (!dmConversations[uid]) {
    dmConversations[uid] = { username: fromUsername, messages: [], unread: 0 };
  }
  dmConversations[uid].messages.push({ fromUsername, text, time });

  // Sound + desktop notification
  playSound('dm');
  showDesktopNotif(`💬 ${fromUsername}`, text?.slice(0, 100) || '');

  if (isDMMode()) {
    if (activeDmUserId === uid) {
      renderDMWindowMessages();
      window.api.markDMRead(uid).catch(() => {});
    }
    return;
  }

  // Popup нээлттэй бол тийшээ route хийх
  if (activePopups.has(uid)) {
    const state = activePopups.get(uid);
    if (state.minimized) {
      // Minimized → автоматаар нээх (restore)
      togglePopupMinimize(uid);
    } else {
      window.api.markDMRead(uid).catch(() => {});
    }
    renderPopupMessages(uid);
    return;
  }

  // Popup нээгдээгүй — автоматаар popup нээж шууд харуулах
  openDM(uid, fromUsername);
}

function handleSentDM({ fromUsername, toUserId, text, time }) {
  const uid = String(toUserId);
  if (!dmConversations[uid]) return;
  dmConversations[uid].messages.push({ fromUsername, text, time });

  if (isDMMode()) {
    if (activeDmUserId === uid) renderDMWindowMessages();
    return;
  }

  if (activePopups.has(uid)) {
    renderPopupMessages(uid);
    return;
  }
}

function showDMNotification(text) {
  const toast = document.createElement('div');
  toast.className = 'dm-toast';
  toast.textContent = `💬 ${text}`;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

// Өрөөний урилгын notification
function showRoomInvite(fromUsername, roomId, roomName) {
  const existing = document.getElementById('room-invite-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'room-invite-toast';
  toast.className = 'invite-toast';
  toast.innerHTML = `
    <div class="invite-toast-title">📨 Өрөөнд урилаа</div>
    <div style="font-size:0.83rem">${escHtml(fromUsername)}: <b>${escHtml(roomName)}</b></div>
    <div class="invite-toast-btns">
      <button id="invite-accept-btn" class="btn btn-primary btn-sm">Нэгдэх</button>
      <button id="invite-decline-btn" class="btn btn-sm btn-secondary">Татгалзах</button>
    </div>
  `;
  document.body.appendChild(toast);

  document.getElementById('invite-accept-btn').onclick = async () => {
    toast.remove();
    try {
      await window.api.joinRoom(roomId, null);
      // Өрөөний мэдээллийг авах шаардлагатай — энгийн байдлаар redirect
      const rooms = await window.api.getRooms();
      const room  = rooms.find(r => String(r.id) === String(roomId));
      if (room) enterRoom(room.id, room.name, room.game_type, false, room.host_id);
    } catch (err) {
      showDMNotification(`Нэгдэхэд алдаа: ${err.message}`);
    }
  };
  document.getElementById('invite-decline-btn').onclick = () => toast.remove();
  setTimeout(() => { if (document.getElementById('room-invite-toast') === toast) toast.remove(); }, 30000);
}

// ── Нийгмийн өгөгдөл ачаалах ──────────────────────────────
async function loadSocialData() {
  try {
    [myFriends, pendingRequests, blockedUsers] = await Promise.all([
      window.api.getFriends().catch(() => []),
      window.api.getPendingRequests().catch(() => []),
      window.api.getBlockedUsers().catch(() => []),
    ]);
    updatePendingBadge();
    renderFriendsTab();
    renderBlockedTab();
  } catch {}
}

function updatePendingBadge() {
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  if (pendingRequests.length > 0) {
    badge.textContent   = pendingRequests.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

// ── Найзуудын tab дүрслэх ─────────────────────────────────
function renderFriendsTab() {
  const pendingSection  = document.getElementById('pending-requests-section');
  const pendingList     = document.getElementById('pending-requests-list');
  const onlineList      = document.getElementById('friends-online-list');
  const offlineList     = document.getElementById('friends-offline-list');
  const onlineLabel     = document.getElementById('friends-online-label');
  const offlineLabel    = document.getElementById('friends-offline-label');
  const noFriendsText   = document.getElementById('no-friends-text');
  if (!pendingList) return;

  // Хүлээгдэж буй хүсэлтүүд
  if (pendingRequests.length > 0) {
    pendingSection.style.display = 'block';
    pendingList.innerHTML = pendingRequests.map(p => `
      <li class="pending-item" data-id="${p.id}" data-username="${escHtml(p.username)}">
        <span class="dm-username">${escHtml(p.username)}</span>
        <div class="pending-actions">
          <button class="btn btn-sm btn-primary pending-accept-btn">✓</button>
          <button class="btn btn-sm btn-danger  pending-decline-btn">✕</button>
        </div>
      </li>
    `).join('');
    pendingList.querySelectorAll('.pending-accept-btn').forEach(btn => {
      const li = btn.closest('li');
      btn.addEventListener('click', () => acceptFriend(li.dataset.id, li.dataset.username));
    });
    pendingList.querySelectorAll('.pending-decline-btn').forEach(btn => {
      const li = btn.closest('li');
      btn.addEventListener('click', () => declineFriend(li.dataset.id));
    });
  } else {
    pendingSection.style.display = 'none';
  }

  const onlineFriends  = myFriends.filter(f => onlineUserIds.has(String(f.id)));
  const offlineFriends = myFriends.filter(f => !onlineUserIds.has(String(f.id)));
  const hasFriends     = myFriends.length > 0;
  if (noFriendsText) noFriendsText.style.display = (hasFriends || pendingRequests.length > 0) ? 'none' : 'block';

  if (onlineList) {
    onlineLabel.style.display = onlineFriends.length > 0 ? 'block' : 'none';
    onlineList.innerHTML = onlineFriends.map(f => friendItemHTML(f, true)).join('');
    bindFriendListEvents(onlineList);
  }
  if (offlineList) {
    offlineLabel.style.display = offlineFriends.length > 0 ? 'block' : 'none';
    offlineList.innerHTML = offlineFriends.map(f => friendItemHTML(f, false)).join('');
    bindFriendListEvents(offlineList);
  }
}

function friendItemHTML(f, isOnline) {
  const dotClass = isOnline ? 'dm-status-dot' : 'dm-status-dot offline';
  return `<li data-id="${f.id}" data-username="${escHtml(f.username)}">
    <span class="${dotClass}"></span>
    <span class="dm-username">${escHtml(f.username)}</span>
    ${isOnline ? `<button class="btn btn-sm dm-btn friend-dm-btn">DM</button>` : ''}
    <button class="btn btn-sm btn-danger-soft remove-btn friend-remove-btn" title="Найзаас хасах">✕</button>
  </li>`;
}

function bindFriendListEvents(ul) {
  ul.querySelectorAll('.friend-dm-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => { e.stopPropagation(); openDM(li.dataset.id, li.dataset.username); });
  });
  ul.querySelectorAll('.friend-remove-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => { e.stopPropagation(); removeFriendClick(li.dataset.id, li.dataset.username); });
  });
}

async function acceptFriend(fromId, fromUsername) {
  try {
    await window.api.acceptFriendRequest(fromId);
    pendingRequests = pendingRequests.filter(p => String(p.id) !== String(fromId));
    if (!myFriends.find(f => String(f.id) === String(fromId))) {
      myFriends.push({ id: fromId, username: fromUsername, avatar_url: null });
    }
    updatePendingBadge();
    renderFriendsTab();
  } catch (err) { showToast(err.message, 'error'); }
}

async function declineFriend(fromId) {
  try {
    await window.api.declineFriendRequest(fromId);
    pendingRequests = pendingRequests.filter(p => String(p.id) !== String(fromId));
    updatePendingBadge();
    renderFriendsTab();
  } catch (err) { showToast(err.message, 'error'); }
}

async function removeFriendClick(friendId, friendName) {
  if (!await showConfirm('Найз хасах', `${friendName}-г найзуудаас хасах уу?`)) return;
  try {
    await window.api.removeFriend(friendId);
    myFriends = myFriends.filter(f => String(f.id) !== String(friendId));
    renderFriendsTab();
    renderOnlineUsersFromCache();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Найзуудын тусдаа цонх горим ──────────────────────────
async function initFriendsWindowMode() {
  // Нийгмийн мэдээлэл ачаалах
  try {
    const [friends, pending, blocked] = await Promise.all([
      window.api.getFriends(),
      window.api.getPendingRequests(),
      window.api.getBlockedUsers(),
    ]);
    myFriends = friends || [];
    pendingRequests = pending || [];
    blockedUsers = blocked || [];
  } catch {}
  renderFriendsWindow();
}

function renderFriendsWindow() {
  const pendingSection = document.getElementById('fw-pending-section');
  const pendingList    = document.getElementById('fw-pending-list');
  const onlineList     = document.getElementById('fw-online-list');
  const offlineList    = document.getElementById('fw-offline-list');
  const onlineLabel    = document.getElementById('fw-online-label');
  const offlineLabel   = document.getElementById('fw-offline-label');
  const noFriends      = document.getElementById('fw-no-friends');
  if (!onlineList) return;

  // Хүсэлтүүд
  if (pendingRequests.length > 0) {
    pendingSection.style.display = 'block';
    pendingList.innerHTML = pendingRequests.map(p => `
      <li class="pending-item" data-id="${p.id}" data-username="${escHtml(p.username)}">
        <span class="dm-username clickable-name" data-user-id="${p.id}">${escHtml(p.username)}</span>
        <div class="pending-actions">
          <button class="btn btn-sm btn-primary pending-accept-btn">✓</button>
          <button class="btn btn-sm btn-danger pending-decline-btn">✕</button>
        </div>
      </li>
    `).join('');
    pendingList.querySelectorAll('.pending-accept-btn').forEach(btn => {
      const li = btn.closest('li');
      btn.addEventListener('click', () => acceptFriend(li.dataset.id, li.dataset.username));
    });
    pendingList.querySelectorAll('.pending-decline-btn').forEach(btn => {
      const li = btn.closest('li');
      btn.addEventListener('click', () => declineFriend(li.dataset.id));
    });
  } else {
    pendingSection.style.display = 'none';
  }

  const onlineFriends  = myFriends.filter(f => onlineUserIds.has(String(f.id)));
  const offlineFriends = myFriends.filter(f => !onlineUserIds.has(String(f.id)));
  noFriends.style.display = myFriends.length > 0 || pendingRequests.length > 0 ? 'none' : 'block';

  onlineLabel.style.display = onlineFriends.length > 0 ? 'block' : 'none';
  onlineList.innerHTML = onlineFriends.map(f => fwFriendItem(f, true)).join('');
  bindFwEvents(onlineList);

  offlineLabel.style.display = offlineFriends.length > 0 ? 'block' : 'none';
  offlineList.innerHTML = offlineFriends.map(f => fwFriendItem(f, false)).join('');
  bindFwEvents(offlineList);
}

function fwFriendItem(f, isOnline) {
  const dot = isOnline ? 'dm-status-dot' : 'dm-status-dot offline';
  return `<li data-id="${f.id}" data-username="${escHtml(f.username)}">
    <span class="${dot}"></span>
    <span class="dm-username clickable-name" data-user-id="${f.id}">${escHtml(f.username)}</span>
    ${isOnline ? '<button class="btn btn-sm dm-btn fw-dm-btn">DM</button>' : ''}
    <button class="btn btn-sm fw-profile-btn" title="Профайл">👤</button>
    <button class="btn btn-sm btn-danger-soft fw-remove-btn" title="Хасах">✕</button>
  </li>`;
}

function bindFwEvents(ul) {
  ul.querySelectorAll('.fw-dm-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => { e.stopPropagation(); openDM(li.dataset.id, li.dataset.username); });
  });
  ul.querySelectorAll('.fw-profile-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => { e.stopPropagation(); openUserProfile(li.dataset.id); });
  });
  ul.querySelectorAll('.fw-remove-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => { e.stopPropagation(); removeFriendClick(li.dataset.id, li.dataset.username); });
  });
  ul.querySelectorAll('.clickable-name').forEach(el => {
    el.addEventListener('click', e => { e.stopPropagation(); openUserProfile(el.dataset.userId); });
  });
}

// ── Хаасан хэрэглэгчдийн tab дүрслэх ─────────────────────
function renderBlockedTab() {
  const list = document.getElementById('blocked-users-list');
  if (!list) return;
  if (blockedUsers.length === 0) {
    list.innerHTML = '<li class="empty-text" style="padding:12px;font-size:0.8rem">Хаасан хэрэглэгч байхгүй</li>';
    return;
  }
  list.innerHTML = blockedUsers.map(u => `
    <li data-id="${u.id}" data-username="${escHtml(u.username)}">
      <span class="dm-username">${escHtml(u.username)}</span>
      <button class="btn btn-sm unblock-btn">Нээх</button>
    </li>
  `).join('');

  list.querySelectorAll('.unblock-btn').forEach(btn => {
    const li = btn.closest('li');
    btn.addEventListener('click', e => {
      e.stopPropagation();
      unblockUserClick(li.dataset.id, li.dataset.username);
    });
  });
}

async function blockUserClick(targetId, targetName) {
  if (!await showConfirm('Хэрэглэгч хаах', `${targetName}-г хаах уу? Найзлалт устгагдана.`)) return;
  try {
    await window.api.blockUser(targetId);
    myFriends       = myFriends.filter(f => String(f.id) !== String(targetId));
    pendingRequests = pendingRequests.filter(p => String(p.id) !== String(targetId));
    if (!blockedUsers.find(b => String(b.id) === String(targetId))) {
      blockedUsers.push({ id: targetId, username: targetName, avatar_url: null });
    }
    updatePendingBadge();
    renderFriendsTab();
    renderBlockedTab();
    renderOnlineUsersFromCache();
  } catch (err) { showToast(err.message, 'error'); }
}

async function unblockUserClick(targetId, targetName) {
  if (!await showConfirm('Хаалт нээх', `${targetName}-г хаалтаас гаргах уу?`)) return;
  try {
    await window.api.unblockUser(targetId);
    blockedUsers = blockedUsers.filter(b => String(b.id) !== String(targetId));
    renderBlockedTab();
    renderOnlineUsersFromCache();
  } catch (err) { showToast(err.message, 'error'); }
}

async function addFriendClick(targetId, targetName) {
  try {
    await window.api.sendFriendRequest(targetId);
    showDMNotification(`${targetName}-д найз хүсэлт илгээлээ`);
    renderOnlineUsersFromCache();
  } catch (err) { showToast(err.message || 'Найз хүсэлт илгээхэд алдаа гарлаа', 'error'); }
}

function renderDMUsersBadges() {
  const list = document.getElementById('dm-users-list');
  if (!list) return;
  list.querySelectorAll('[data-user-id]').forEach(li => {
    const uid   = li.dataset.userId;
    const badge = li.querySelector('.dm-unread');
    if (!badge) return;
    const unread = dmConversations[uid]?.unread || 0;
    if (unread > 0) {
      badge.textContent    = unread;
      badge.style.display  = 'inline-block';
    } else {
      badge.style.display = 'none';
    }
  });
}

// DM popup cleanup (зөвхөн үндсэн цонхонд)
if (!isDMMode()) {
  window.addEventListener('beforeunload', () => {
    activePopups.forEach((state, uid) => {
      if (state.isTyping && socket) {
        socket.emit('typing:stop', { toUserId: uid });
      }
    });
  });
  // DM цонх хаагдахад unread шинэчлэх
  window.api.onDMWindowClosed(() => loadUnreadDMCounts());
}

// ── Онлайн тоглогчид ─────────────────────────────────────
let _cachedOnlineUsers = [];

function renderOnlineUsers(users) {
  _cachedOnlineUsers = users;
  const countEl = document.getElementById('online-count');
  const namesEl = document.getElementById('online-names');
  const total   = users.length;
  const names   = users.map(u => (typeof u === 'object' ? u.username : u));

  if (countEl) countEl.textContent = total;
  if (namesEl) namesEl.textContent = total ? '— ' + names.join(', ') : '';

  // Онлайн tab тоо шинэчлэх
  const onlineBadge = document.getElementById('dm-online-badge');
  const others = users.filter(u => {
    const uid = typeof u === 'object' ? String(u.userId) : null;
    return uid && uid !== String(currentUser?.id);
  });
  if (onlineBadge) onlineBadge.textContent = others.length;

  renderOnlineTab(others);
}

function renderOnlineUsersFromCache() {
  renderOnlineUsers(_cachedOnlineUsers);
}

function renderOnlineTab(others) {
  const dmList = document.getElementById('dm-users-list');
  if (!dmList) return;

  if (others.length === 0) {
    dmList.innerHTML = '<li class="empty-text" style="padding:12px;font-size:0.8rem">Онлайн хэрэглэгч байхгүй</li>';
    return;
  }

  const blockedIds = new Set(blockedUsers.map(b => String(b.id)));
  const friendIds  = new Set(myFriends.map(f => String(f.id)));

  dmList.innerHTML = others.map(u => {
    const uid    = typeof u === 'object' ? String(u.userId) : '';
    const uname  = typeof u === 'object' ? u.username : u;
    const status = typeof u === 'object' ? (u.status || 'online') : 'online';
    const unread = dmConversations[uid]?.unread || 0;
    const badge  = `<span class="dm-unread" style="${unread > 0 ? '' : 'display:none'}">${unread}</span>`;

    // Статус badge
    const statusBadge = status === 'in_room'
      ? `<span class="status-in-room">🟡 Өрөөнд</span>`
      : status === 'in_game'
      ? `<span class="status-in-game">🔴 Тоглоомд</span>`
      : ``;

    const isBlocked = blockedIds.has(uid);
    const isFriend  = friendIds.has(uid);

    let actionBtns;
    if (isBlocked) {
      actionBtns = `<span class="dm-blocked-tag">Хаасан</span>`;
    } else {
      const friendBtn = isFriend
        ? ''
        : `<button class="btn btn-sm btn-add-friend add-friend-btn" title="Найз нэмэх">+</button>`;
      // Урих товч: зөвхөн та өрөөнд байгаа үед
      const inviteBtn = currentRoom
        ? `<button class="btn btn-sm invite-btn" title="Өрөөнд урих">📨</button>`
        : '';
      actionBtns = `
        <button class="btn btn-sm dm-btn dm-open-btn">DM</button>
        ${friendBtn}
        ${inviteBtn}
        <button class="btn btn-sm btn-block-user block-user-btn" title="Хаах">🚫</button>
      `;
    }

    return `<li data-user-id="${uid}" data-username="${escHtml(uname)}" class="online-user-item">
      <span class="dm-status-dot"></span>
      <span class="dm-username">${escHtml(uname)}</span>
      ${statusBadge}
      ${badge}
      <div class="dm-action-btns">${actionBtns}</div>
    </li>`;
  }).join('');

  dmList.querySelectorAll('.online-user-item').forEach(li => {
    const uid   = li.dataset.userId;
    const uname = li.dataset.username;

    li.addEventListener('click', () => openDM(uid, uname));

    const dmBtn = li.querySelector('.dm-open-btn');
    if (dmBtn) dmBtn.addEventListener('click', e => { e.stopPropagation(); openDM(uid, uname); });

    const addBtn = li.querySelector('.add-friend-btn');
    if (addBtn) addBtn.addEventListener('click', e => { e.stopPropagation(); addFriendClick(uid, uname); });

    const blockBtn = li.querySelector('.block-user-btn');
    if (blockBtn) blockBtn.addEventListener('click', e => { e.stopPropagation(); blockUserClick(uid, uname); });

    const inviteBtn = li.querySelector('.invite-btn');
    if (inviteBtn) inviteBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (currentRoom && socket) {
        socket.emit('room:invite', {
          toUserId: uid,
          roomId: currentRoom.id,
          roomName: currentRoom.name,
        });
        showDMNotification(`${uname}-д урилга илгээлээ`);
      }
    });
  });
}

// ── Ranking ───────────────────────────────────────────────
let rankingPage = 1;
let rankingSort = 'wins';

async function loadRanking(page = rankingPage, sort = rankingSort) {
  rankingPage = page;
  rankingSort = sort;
  const tbody    = document.getElementById('ranking-body');
  const pagDiv   = document.getElementById('ranking-pagination');
  const sortSel  = document.getElementById('ranking-sort');
  if (sortSel) sortSel.value = sort;
  tbody.innerHTML = Array(5).fill('<tr><td colspan="5"><div class="skeleton" style="height:32px;border-radius:6px;margin:4px 0"></div></td></tr>').join('');
  try {
    const currentUser = await window.api.getUser();
    const data = await window.api.getRanking({ sort, page });
    const players = data?.players || [];
    const totalPages = data?.totalPages || 0;
    const offset = (page - 1) * 20;

    if (!players.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="empty-text">Одоогоор мэдээлэл байхгүй</td></tr>';
      pagDiv.classList.add('hidden');
      return;
    }

    tbody.innerHTML = players.map((p, i) => {
      const rank = offset + i + 1;
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : rank;
      const isSelf = currentUser && String(p.id) === String(currentUser.id);
      return `<tr class="ranking-row${isSelf ? ' ranking-self' : ''}" data-userid="${p.id}" data-username="${p.username}" style="cursor:pointer">
        <td>${medal}</td>
        <td>${p.username}</td>
        <td style="color:var(--green)">${p.wins}</td>
        <td style="color:var(--red)">${p.losses}</td>
        <td>${p.winrate}%</td>
      </tr>`;
    }).join('');

    // Pagination
    if (totalPages > 1) {
      pagDiv.classList.remove('hidden');
      pagDiv.innerHTML = renderPagination(page, totalPages, (p) => loadRanking(p, sort));
    } else {
      pagDiv.classList.add('hidden');
    }

    // Row click → profile popup
    tbody.querySelectorAll('.ranking-row').forEach(row => {
      row.addEventListener('click', () => openUserProfile(Number(row.dataset.userid)));
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-text">Серверт холбогдож чадсангүй</td></tr>';
    pagDiv.classList.add('hidden');
  }
}

function renderPagination(current, total, onPage) {
  let html = '';
  if (current > 1)
    html += `<button class="btn btn-sm pagination-btn" data-page="${current - 1}">‹</button>`;
  html += `<span class="pagination-info">${current} / ${total}</span>`;
  if (current < total)
    html += `<button class="btn btn-sm pagination-btn" data-page="${current + 1}">›</button>`;

  setTimeout(() => {
    document.querySelectorAll('.pagination-btn').forEach(btn => {
      btn.addEventListener('click', () => onPage(Number(btn.dataset.page)));
    });
  }, 0);
  return html;
}

// ── User Profile Popup ────────────────────────────────────
async function openUserProfile(userId) {
  const modal = document.getElementById('user-profile-modal');
  const currentUser = await window.api.getUser();
  modal.classList.remove('hidden');

  // Reset
  document.getElementById('popup-username').textContent = '...';
  document.getElementById('popup-wins').textContent     = '';
  document.getElementById('popup-losses').textContent   = '';
  document.getElementById('popup-winrate').textContent  = '';
  document.getElementById('popup-history-body').innerHTML = '<tr><td colspan="3" class="empty-text">Ачааллаж байна...</td></tr>';
  document.getElementById('popup-friend-btn-wrap').innerHTML = '';

  const avatarEl = document.getElementById('popup-avatar');
  avatarEl.src = ''; avatarEl.style.display = 'none';

  try {
    const [stats, history] = await Promise.all([
      window.api.getPlayerStatsById(userId),
      window.api.getGameHistory(userId, 1),
    ]);

    document.getElementById('popup-username').textContent = stats.username;
    document.getElementById('popup-wins').textContent     = `${stats.wins} хожил`;
    document.getElementById('popup-losses').textContent   = `${stats.losses} хожигдол`;
    document.getElementById('popup-winrate').textContent  = stats.winrate;
    if (stats.avatar_url) { avatarEl.src = stats.avatar_url; avatarEl.style.display = 'block'; }

    const games = history?.games || [];
    const tbody = document.getElementById('popup-history-body');
    if (games.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="empty-text">Тоглоом байхгүй</td></tr>';
    } else {
      tbody.innerHTML = games.slice(0, 5).map(g => {
        const date   = new Date(g.played_at).toLocaleDateString('mn-MN');
        const result = g.is_winner ? '<span style="color:var(--green)">Хожив</span>' : '<span style="color:var(--red)">Хожигдов</span>';
        return `<tr><td>${date}</td><td>${g.team}</td><td>${result}</td></tr>`;
      }).join('');
    }

    // Friend + DM buttons (don't show for self)
    if (currentUser && String(userId) !== String(currentUser.id)) {
      const wrap = document.getElementById('popup-friend-btn-wrap');
      // DM товч
      const dmBtn = document.createElement('button');
      dmBtn.className = 'btn btn-sm btn-primary';
      dmBtn.textContent = '💬 Мессеж';
      dmBtn.onclick = () => {
        openDM(userId, stats.username);
        modal.classList.add('hidden');
      };
      wrap.appendChild(dmBtn);
      // Найз товч
      const btn  = document.createElement('button');
      btn.className   = 'btn btn-sm btn-primary';
      btn.textContent = 'Найз болох';
      btn.onclick = async () => {
        try {
          await window.api.sendFriendRequest(userId);
          btn.textContent = '✓ Хүсэлт илгээгдлээ';
          btn.disabled = true;
        } catch {}
      };
      wrap.appendChild(btn);
    }
  } catch {
    document.getElementById('popup-username').textContent = 'Алдаа гарлаа';
  }
}

document.getElementById('btn-close-user-profile').onclick = () => {
  document.getElementById('user-profile-modal').classList.add('hidden');
};

// ── Profile ───────────────────────────────────────────────
let gameHistoryPage = 1;

// ── Rank систем ───────────────────────────────────────────
function getRank(wins) {
  if (wins >= 50) return { name: 'Diamond',  icon: '⚡', css: 'rank-diamond' };
  if (wins >= 30) return { name: 'Platinum', icon: '💎', css: 'rank-platinum' };
  if (wins >= 15) return { name: 'Gold',     icon: '👑', css: 'rank-gold' };
  if (wins >= 5)  return { name: 'Silver',   icon: '🗡️', css: 'rank-silver' };
  return              { name: 'Bronze',  icon: '⚔️', css: 'rank-bronze' };
}

async function loadProfile() {
  try {
    await window.api.refreshUser?.();
    const user = await window.api.getUser();
    if (!user) return;
    document.getElementById('profile-name').textContent  = user.username;
    document.getElementById('profile-email').textContent = user.email || '';
    const avatarEl = document.getElementById('profile-avatar');
    if (user.avatar_url) {
      avatarEl.src = user.avatar_url;
      avatarEl.style.display = 'block';
    } else {
      avatarEl.style.display = 'none';
    }

    const total   = (user.wins || 0) + (user.losses || 0);
    const winrate = total > 0 ? ((user.wins / total) * 100).toFixed(1) : '0';
    document.getElementById('stat-wins').textContent    = user.wins || 0;
    document.getElementById('stat-losses').textContent  = user.losses || 0;
    document.getElementById('stat-winrate').textContent = winrate + '%';

    // Rank badge
    const rank = getRank(user.wins || 0);
    const rankEl = document.getElementById('profile-rank');
    if (rankEl) {
      rankEl.className = `rank-badge ${rank.css}`;
      rankEl.textContent = `${rank.icon} ${rank.name}`;
    }

    const linkedEl   = document.getElementById('discord-linked');
    const linkBtnEl  = document.getElementById('btn-link-discord');
    const discNameEl = document.getElementById('discord-username');
    if (user.discord_id) {
      linkedEl.style.display  = 'flex';
      linkBtnEl.style.display = 'none';
      discNameEl.textContent  = `@${user.username}`;
    } else {
      linkedEl.style.display  = 'none';
      linkBtnEl.style.display = 'block';
    }

    // Тоглоомын түүх ачааллах
    gameHistoryPage = 1;
    await loadGameHistory(user.id, 1);
  } catch {}
}

async function loadGameHistory(userId, page) {
  gameHistoryPage = page;
  const tbody  = document.getElementById('game-history-body');
  const pagDiv = document.getElementById('game-history-pagination');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" class="empty-text">Ачааллаж байна...</td></tr>';
  try {
    const data  = await window.api.getGameHistory(userId, page);
    const games = data?.games || [];

    if (games.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-text">Одоогоор тоглоом байхгүй</td></tr>';
      pagDiv.classList.add('hidden');
      return;
    }

    tbody.innerHTML = games.map(g => {
      const date     = new Date(g.played_at).toLocaleDateString('mn-MN');
      const result   = g.is_winner
        ? '<span style="color:var(--green)">Хожив</span>'
        : '<span style="color:var(--red)">Хожигдов</span>';
      const duration = g.duration_minutes ? `${g.duration_minutes} мин` : '—';
      return `<tr>
        <td>${date}</td>
        <td>${g.game_type || '—'}</td>
        <td>${g.room_name || '—'}</td>
        <td>${g.team}</td>
        <td>${result}</td>
        <td>${duration}</td>
      </tr>`;
    }).join('');

    if ((data.totalPages || 0) > 1) {
      pagDiv.classList.remove('hidden');
      pagDiv.innerHTML = renderPagination(page, data.totalPages, (p) => loadGameHistory(userId, p));
    } else {
      pagDiv.classList.add('hidden');
    }
  } catch {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-text">Серверт холбогдож чадсангүй</td></tr>';
  }
}

document.getElementById('btn-link-discord').onclick = () => window.api.linkDiscord();

// ── Username засах ────────────────────────────────────────
document.getElementById('btn-edit-username').onclick = () => {
  const form = document.getElementById('username-edit-form');
  form.classList.toggle('hidden');
  if (!form.classList.contains('hidden')) {
    const input = document.getElementById('username-input');
    input.value = document.getElementById('profile-name').textContent;
    input.focus();
  }
};
document.getElementById('btn-username-cancel').onclick = () => {
  document.getElementById('username-edit-form').classList.add('hidden');
  document.getElementById('username-edit-error').textContent = '';
};
document.getElementById('btn-username-save').onclick = async (e) => {
  const btn   = e.currentTarget;
  const val   = document.getElementById('username-input').value.trim();
  const errEl = document.getElementById('username-edit-error');
  errEl.textContent = '';
  if (!val || val.length < 2 || val.length > 20) {
    errEl.textContent = 'Username 2-20 тэмдэгт байх ёстой';
    return;
  }
  btn.disabled = true; btn.textContent = '...';
  try {
    const data = await window.api.changeUsername(val);
    document.getElementById('profile-name').textContent = data.username;
    document.getElementById('user-name').textContent    = data.username;
    document.getElementById('username-edit-form').classList.add('hidden');
  } catch (err) {
    errEl.textContent = err.message || 'Алдаа гарлаа';
  } finally {
    btn.disabled = false; btn.textContent = 'Хадгалах';
  }
};

// ── Discord салгах ────────────────────────────────────────
const btnUnlinkDiscord = document.getElementById('btn-unlink-discord');
if (btnUnlinkDiscord) {
  btnUnlinkDiscord.onclick = async () => {
    if (!await showConfirm('Discord салгах', 'Discord холболтыг салгахдаа итгэлтэй байна уу? Нэвтрэхэд нууц үг шаардлагатай болно.')) return;
    try {
      await window.api.unlinkDiscord();
      loadProfile();
    } catch (err) {
      showToast(err.message || 'Алдаа гарлаа', 'error');
    }
  };
}

// ── Нууц үг солих ─────────────────────────────────────────
document.getElementById('btn-change-password').onclick = async (e) => {
  const btn        = e.currentTarget;
  const oldPw      = document.getElementById('old-password').value;
  const newPw      = document.getElementById('new-password').value;
  const confirmPw  = document.getElementById('new-password-confirm').value;
  const errEl      = document.getElementById('pw-change-error');
  const successEl  = document.getElementById('pw-change-success');
  errEl.textContent = ''; successEl.textContent = '';

  if (!oldPw || !newPw || !confirmPw) { errEl.textContent = 'Бүх талбарыг бөглөнө үү'; return; }
  if (newPw !== confirmPw) { errEl.textContent = 'Шинэ нууц үг таарахгүй байна'; return; }
  if (newPw.length < 6) { errEl.textContent = 'Шинэ нууц үг хамгийн багадаа 6 тэмдэгт байна'; return; }

  btn.disabled = true; btn.textContent = 'Солж байна...';
  try {
    await window.api.changePassword(oldPw, newPw);
    successEl.textContent = '✓ Нууц үг амжилттай солигдлоо';
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('new-password-confirm').value = '';
  } catch (err) {
    errEl.textContent = err.message || 'Нууц үг солиход алдаа гарлаа';
  } finally {
    btn.disabled = false; btn.textContent = 'Солих';
  }
};

// Профайл зураг оруулах
document.getElementById('btn-upload-avatar').onclick = async () => {
  const btn = document.getElementById('btn-upload-avatar');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    const result = await window.api.uploadAvatar();
    if (result?.avatar_url) {
      document.getElementById('profile-avatar').src = result.avatar_url;
      document.getElementById('profile-avatar').style.display = 'block';
      // Header дахь avatar шинэчлэх
      const headerAv = document.getElementById('user-avatar');
      headerAv.src = result.avatar_url;
      headerAv.style.display = 'block';
      if (currentUser) currentUser.avatar_url = result.avatar_url;
    }
  } catch (err) {
    if (err.message) showToast(`Зураг оруулахад алдаа: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📷';
  }
};

// ── Тохируулга ────────────────────────────────────────────
let configuredGames = []; // { id, name, path }

async function loadSettings() {
  try {
    const settings = await window.api.getSettings();
    configuredGames = settings.games || [];
    renderGamesList();
    populateRoomTypeSelect();
  } catch {}
  // ZeroTier статус харуулах
  try {
    const st = await window.api.getZerotierStatus();
    const ipEl = document.getElementById('settings-zt-ip');
    const stEl = document.getElementById('settings-zt-status');
    if (ipEl) ipEl.textContent = st.ip || '---';
    if (stEl) {
      if (!st.installed) stEl.textContent = '(суулгаагүй)';
      else if (!st.running) stEl.textContent = '(сервис зогссон)';
      else if (!st.connected) stEl.textContent = '(холбогдоогүй)';
      else stEl.textContent = '(холбогдсон)';
    }
    // Node ID харуулах (диагностик)
    const nodeId = await window.api.getZerotierNodeId();
    const msgEl = document.getElementById('zt-refresh-msg');
    if (msgEl && (nodeId || st.networkId)) {
      const parts = [];
      if (nodeId) parts.push(`Node ID: ${nodeId}`);
      if (st.networkId) parts.push(`Network: ${st.networkId}`);
      msgEl.innerHTML = parts.join('<br>');
      msgEl.style.color = '';
    }
  } catch {}

  // Мэдэгдлийн тохиргоо ачаалах
  const soundChk = document.getElementById('setting-sound');
  const notifChk = document.getElementById('setting-desktop-notif');
  if (soundChk) soundChk.checked = localStorage.getItem('sound_enabled') !== 'false';
  if (notifChk) notifChk.checked = localStorage.getItem('desktop_notif_enabled') !== 'false';
}

// Мэдэгдлийн тохиргоо toggle
document.getElementById('setting-sound')?.addEventListener('change', (e) => {
  localStorage.setItem('sound_enabled', e.target.checked ? 'true' : 'false');
});
document.getElementById('setting-desktop-notif')?.addEventListener('change', (e) => {
  localStorage.setItem('desktop_notif_enabled', e.target.checked ? 'true' : 'false');
  if (e.target.checked && Notification.permission !== 'granted') {
    Notification.requestPermission();
  }
});
document.getElementById('btn-test-sound')?.addEventListener('click', () => {
  playSound('dm');
});

// ZeroTier IP шинэчлэх товч (Тохируулга)
document.getElementById('btn-zt-refresh')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-zt-refresh');
  const msgEl = document.getElementById('zt-refresh-msg');
  btn.disabled = true;
  if (btn.querySelector('svg')) {
    // SVG icon байвал зөвхөн текстийг солих
    btn.lastChild.textContent = ' Тохируулж байна...';
  } else {
    btn.textContent = 'Тохируулж байна...';
  }
  if (msgEl) { msgEl.textContent = ''; msgEl.style.color = ''; }
  try {
    const result = await window.api.refreshZerotier();
    const ipEl = document.getElementById('settings-zt-ip');
    const stEl = document.getElementById('settings-zt-status');
    if (ipEl) ipEl.textContent = result.ip || '---';
    if (stEl) {
      if (result.ok && result.ip) stEl.textContent = '(холбогдсон)';
      else if (result.ok) stEl.textContent = '(IP хүлээж байна)';
      else stEl.textContent = `(${result.error || 'алдаа'})`;
    }
    if (msgEl) {
      const lines = [];
      if (result.nodeId) lines.push(`Node ID: ${result.nodeId}`);
      if (result.networkId) lines.push(`Network: ${result.networkId}`);
      if (result.ip) {
        lines.push(`IP: ${result.ip}`);
        msgEl.style.color = 'var(--green)';
      } else {
        lines.push('IP олдсонгүй — authorize хийгдээгүй эсвэл сүлжээ өөр байж магадгүй');
        msgEl.style.color = 'var(--red)';
      }
      msgEl.innerHTML = lines.join('<br>');
    }
  } catch (err) {
    if (msgEl) { msgEl.textContent = `Алдаа: ${err.message}`; msgEl.style.color = 'var(--red)'; }
  } finally {
    btn.disabled = false;
    if (btn.querySelector('svg')) {
      btn.lastChild.textContent = ' IP шинэчлэх';
    } else {
      btn.textContent = 'IP шинэчлэх';
    }
  }
});

function renderGamesList() {
  const ul = document.getElementById('games-list');
  if (!ul) return;
  if (configuredGames.length === 0) {
    ul.innerHTML = '<li class="empty-text" style="padding:10px 0;font-size:0.82rem">Тоглоом нэмэгдээгүй байна</li>';
    return;
  }
  ul.innerHTML = configuredGames.map(g => `
    <li class="game-item" data-game-id="${escHtml(g.id)}">
      <div class="game-item-info">
        <span class="game-item-name">${escHtml(g.name)}</span>
        <span class="game-item-path hint">${escHtml(g.path)}</span>
      </div>
      <button class="btn btn-sm btn-danger remove-game-btn">Устгах</button>
    </li>
  `).join('');

  ul.querySelectorAll('.remove-game-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.closest('li').dataset.gameId;
      removeGameClick(id);
    });
  });
}

function populateRoomTypeSelect() {
  const sel = document.getElementById('room-type');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = configuredGames.length
    ? configuredGames.map(g => `<option value="${escHtml(g.name)}">${escHtml(g.name)}</option>`).join('')
    : '<option value="">— Эхлээд тоглоом нэмнэ үү —</option>';
  if (current && [...sel.options].some(o => o.value === current)) sel.value = current;
}

// Тоглоом нэмэх — exe сонгоход файлын нэрийг автоматаар авна
document.getElementById('btn-add-game').onclick = async () => {
  const btn = document.getElementById('btn-add-game');
  btn.disabled = true;
  btn.textContent = '...';
  try {
    // 1. Exe сонгох
    const result = await window.api.selectGameExe();
    if (!result) return; // хэрэглэгч цуцаллаа

    // 2. Тоглоом нэмэх
    const games = await window.api.addGame({ name: result.suggestedName, path: result.path });
    configuredGames = games || [];
    renderGamesList();
    populateRoomTypeSelect();
  } catch (err) {
    showToast('Тоглоом нэмэхэд алдаа гарлаа: ' + (err?.message || String(err)), 'error');
    console.error('addGame error:', err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="btn-icon-svg"><use href="#ico-plus"/></svg> Тоглоом нэмэх';
  }
};

async function removeGameClick(id) {
  if (!await showConfirm('Тоглоом устгах', 'Энэ тоглоомыг жагсаалтаас устгах уу?')) return;
  try {
    configuredGames = await window.api.removeGame(id);
    renderGamesList();
    populateRoomTypeSelect();
  } catch (err) { showToast(err.message, 'error'); }
}

// ── Тоглоом дуусах ───────────────────────────────────────
function showGameResult(data) {
  const modal = document.getElementById('result-modal');
  const content = document.getElementById('result-content');
  if (!modal || !content) return;

  // Алдаатай бол
  if (data.error) {
    content.innerHTML = `
      <h2>⚠️ Тоглоом дууслаа</h2>
      <p class="result-error">${data.error}</p>
      <button type="button" id="btn-close-result" class="btn btn-primary">Хаах</button>
    `;
    modal.style.display = 'flex';
    document.getElementById('btn-close-result').onclick = () => { modal.style.display = 'none'; };
    return;
  }

  const winners = (data.players || []).filter(p => p.team === data.winner_team);
  const losers  = (data.players || []).filter(p => p.team !== data.winner_team);

  const raceEmoji = { Human: '🏰', Orc: '⚔️', 'Night Elf': '🌙', NightElf: '🌙', Undead: '💀', Random: '🎲' };

  const renderPlayers = (list, isWinner) => list.map(p => {
    const race = raceEmoji[p.race] || '';
    const matched = p.user_id ? '✓' : '';
    return `<div class="result-player ${isWinner ? 'winner' : 'loser'}">
      <span class="result-player-name">${race} ${p.name} ${matched}</span>
      ${p.apm ? `<span class="result-player-apm">${p.apm} APM</span>` : ''}
    </div>`;
  }).join('');

  const savedMsg = data.saved
    ? '<p class="result-saved">✅ Статистик амжилттай хадгалагдлаа</p>'
    : data.saveError
    ? `<p class="result-save-error">⚠️ ${data.saveError}</p>`
    : '';

  content.innerHTML = `
    <h2>🏆 Тоглоом дууслаа!</h2>
    <p class="result-duration">Үргэлжлэлт: ${data.duration_minutes || 0} мин</p>
    <div class="result-teams">
      <div class="result-team result-team-win">
        <h3>🏆 Хожсон</h3>
        ${renderPlayers(winners, true)}
      </div>
      <div class="result-team result-team-lose">
        <h3>💀 Хожигдсон</h3>
        ${renderPlayers(losers, false)}
      </div>
    </div>
    ${savedMsg}
    <button type="button" id="btn-close-result" class="btn btn-primary" style="margin-top:12px">Хаах</button>
  `;

  modal.style.display = 'flex';
  document.getElementById('btn-close-result').onclick = () => { modal.style.display = 'none'; };
}

// ── Update notification bar ───────────────────────────────
function showUpdateBar(message, showInstallBtn, percent = null) {
  let bar = document.getElementById('update-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'update-bar';
    bar.style.cssText = `
      position:fixed; top:0; left:0; right:0; z-index:9999;
      background:#1565c0; color:#fff; font-size:13px;
      display:flex; align-items:center; justify-content:center; gap:12px;
      padding:8px 16px; box-shadow:0 2px 8px rgba(0,0,0,.4);
    `;
    document.body.appendChild(bar);
  }
  const progressHtml = (percent !== null)
    ? `<span style="background:rgba(255,255,255,.25);border-radius:8px;width:120px;height:6px;display:inline-block;overflow:hidden;vertical-align:middle">
         <span style="display:block;height:100%;width:${percent}%;background:#90caf9;transition:width .3s"></span>
       </span>`
    : '';
  const btnHtml = showInstallBtn
    ? `<button id="btn-install-update" style="
         background:#fff;color:#1565c0;border:none;border-radius:6px;
         padding:4px 14px;font-weight:700;cursor:pointer;font-size:13px;">
         ↺ Дахин эхлүүлэх
       </button>`
    : '';
  bar.innerHTML = `<span>🔄 ${message}</span>${progressHtml}${btnHtml}`;
  if (showInstallBtn) {
    const btn = bar.querySelector('#btn-install-update');
    if (btn) btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Суулгаж байна...';
      try {
        await window.api.installUpdate();
      } catch (e) {
        btn.disabled = false;
        btn.textContent = '↺ Дахин эхлүүлэх';
        showToast('Алдаа: ' + (e?.message || 'Шинэчлэл суулгах боломжгүй'), 'error', 5000);
      }
    });
  }
}

// ── Toast notifications ───────────────────────────────────
function showToast(message, type = 'info', duration = 3000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

// ── Confirm modal ─────────────────────────────────────────
function showConfirm(title, message) {
  return new Promise(resolve => {
    document.getElementById('confirm-title').textContent   = title;
    document.getElementById('confirm-message').textContent = message;
    const modal = document.getElementById('confirm-modal');
    modal.style.display = 'flex';
    const cleanup = (result) => {
      modal.style.display = 'none';
      resolve(result);
    };
    document.getElementById('confirm-ok').onclick     = () => cleanup(true);
    document.getElementById('confirm-cancel').onclick = () => cleanup(false);
  });
}

// ── withLoading helper ────────────────────────────────────
function withLoading(button, asyncFn) {
  return async (...args) => {
    if (button.disabled) return;
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = '⏳ ...';
    try {
      await asyncFn(...args);
    } catch (e) {
      showToast(e.message || 'Алдаа гарлаа', 'error');
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  };
}

// ── Skeleton helpers ──────────────────────────────────────
function renderRoomsSkeleton() {
  return Array(3).fill('').map(() => `
    <div class="room-card skeleton" style="height:120px;margin-bottom:12px;"></div>
  `).join('');
}

// ── Холболтын төлөв ───────────────────────────────────────
function updateConnectionStatus(status) {
  const indicator = document.getElementById('connection-status');
  if (!indicator) return;
  indicator.className = `connection-status ${status}`;
  indicator.textContent = {
    online:       '🟢 Холбогдсон',
    offline:      '🔴 Салгагдсан',
    reconnecting: '🟡 Дахин холбогдож байна...',
  }[status] || '';
}

// ── Хэрэгслүүд ───────────────────────────────────────────
function escHtml(t) {
  return String(t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// @mention parse: escHtml() дараа дуудна — аюулгүй HTML оруулна
function parseMentions(escapedText, triggerSound) {
  const myName = currentUser?.username;
  let mentionedMe = false;
  const result = escapedText.replace(/@(\w{2,20})/g, (match, name) => {
    const isMe = myName && name.toLowerCase() === myName.toLowerCase();
    if (isMe) mentionedMe = true;
    return `<span class="mention${isMe ? ' mention-me' : ''}">${match}</span>`;
  });
  if (mentionedMe && triggerSound) playSound('notify');
  return result;
}

// ── @mention autocomplete ────────────────────────────────
function setupMentionAutocomplete(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;
  let dropdown = null;
  let activeIdx = -1;
  let names = [];

  function getNames() {
    const set = new Set();
    // Өрөөний гишүүд
    if (currentRoom?.members) currentRoom.members.forEach(m => { if (m.name) set.add(m.name); });
    // Онлайн хэрэглэгчид
    const onlineEl = document.querySelectorAll('.online-user-item .online-user-name');
    onlineEl.forEach(el => { if (el.textContent) set.add(el.textContent.trim()); });
    // Өөрийгөө хасах
    if (currentUser?.username) set.delete(currentUser.username);
    return [...set];
  }

  function close() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    activeIdx = -1; names = [];
  }

  function render(filtered) {
    if (!dropdown) {
      dropdown = document.createElement('div');
      dropdown.className = 'mention-dropdown';
      input.parentElement.appendChild(dropdown);
    }
    dropdown.innerHTML = filtered.map((n, i) =>
      `<div class="mention-dropdown-item${i === activeIdx ? ' active' : ''}" data-name="${escHtml(n)}">@${escHtml(n)}</div>`
    ).join('');
    dropdown.querySelectorAll('.mention-dropdown-item').forEach(el => {
      el.addEventListener('mousedown', (e) => {
        e.preventDefault();
        pick(el.dataset.name);
      });
    });
  }

  function pick(name) {
    const v = input.value;
    const cursor = input.selectionStart;
    const before = v.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1) { close(); return; }
    input.value = before.slice(0, atIdx) + '@' + name + ' ' + v.slice(cursor);
    input.focus();
    const newPos = atIdx + name.length + 2;
    input.setSelectionRange(newPos, newPos);
    close();
  }

  input.addEventListener('input', () => {
    const v = input.value;
    const cursor = input.selectionStart;
    const before = v.slice(0, cursor);
    const atIdx = before.lastIndexOf('@');
    if (atIdx === -1 || (atIdx > 0 && before[atIdx - 1] !== ' ')) { close(); return; }
    const query = before.slice(atIdx + 1).toLowerCase();
    if (!query || query.length > 20 || /\s/.test(query)) { close(); return; }
    const all = getNames();
    const filtered = all.filter(n => n.toLowerCase().startsWith(query)).slice(0, 6);
    if (filtered.length === 0) { close(); return; }
    names = filtered; activeIdx = 0;
    render(filtered);
  });

  input.addEventListener('keydown', (e) => {
    if (!dropdown || names.length === 0) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); activeIdx = (activeIdx + 1) % names.length; render(names); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); activeIdx = (activeIdx - 1 + names.length) % names.length; render(names); }
    else if (e.key === 'Tab' || e.key === 'Enter') {
      if (activeIdx >= 0 && activeIdx < names.length) { e.preventDefault(); pick(names[activeIdx]); }
    }
    else if (e.key === 'Escape') { close(); }
  });

  input.addEventListener('blur', () => setTimeout(close, 150));
}

// Chat input-уудад autocomplete идэвхжүүлэх
setupMentionAutocomplete('chat-input');
setupMentionAutocomplete('lobby-chat-input');

// Тоглоомын нэрнээс тогтмол өнгө үүсгэх
const _gameColors = ['#e74c3c','#2980b9','#27ae60','#8e44ad','#e67e22','#16a085','#c0392b','#1a5276'];
function gameTypeColor(name) {
  if (!name) return _gameColors[0];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return _gameColors[h % _gameColors.length];
}

// ── Хэрэглэгч хайх ───────────────────────────────────────
let _searchTimer = null;
const userSearchInput = document.getElementById('user-search-input');
if (userSearchInput) {
  userSearchInput.addEventListener('input', () => {
    clearTimeout(_searchTimer);
    const q = userSearchInput.value.trim();
    const resultsEl = document.getElementById('user-search-results');
    if (!q || q.length < 2) {
      if (resultsEl) resultsEl.innerHTML = '';
      return;
    }
    _searchTimer = setTimeout(async () => {
      try {
        const results = await window.api.searchUsers(q);
        if (!resultsEl) return;
        if (!results.length) {
          resultsEl.innerHTML = '<div class="search-result-item" style="color:var(--text2)">Олдсонгүй</div>';
          return;
        }
        const friendIds  = new Set(myFriends.map(f => String(f.id)));
        const blockedIds = new Set(blockedUsers.map(b => String(b.id)));
        resultsEl.innerHTML = results.map(u => {
          const uid    = String(u.id);
          const isFriend  = friendIds.has(uid);
          const isBlocked = blockedIds.has(uid);
          const addBtn = (!isFriend && !isBlocked)
            ? `<button class="btn btn-sm btn-add-friend search-add-btn" data-id="${uid}" data-name="${escHtml(u.username)}">+ Найз</button>`
            : (isFriend ? '<span style="font-size:0.75rem;color:var(--green)">✓ Найз</span>' : '');
          return `<div class="search-result-item">
            <span class="result-username">${escHtml(u.username)}</span>
            ${addBtn}
          </div>`;
        }).join('');
        resultsEl.querySelectorAll('.search-add-btn').forEach(btn => {
          btn.addEventListener('click', () => addFriendClick(btn.dataset.id, btn.dataset.name));
        });
      } catch {}
    }, 500);
  });
}

// Ranking sort сонголт өөрчлөгдөхөд дахин ачааллах
const rankingSortEl = document.getElementById('ranking-sort');
if (rankingSortEl) {
  rankingSortEl.addEventListener('change', () => loadRanking(1, rankingSortEl.value));
}

// ── Keyboard shortcuts ────────────────────────────────────
function toggleShortcutsModal() {
  const m = document.getElementById('shortcuts-modal');
  if (!m) return;
  const visible = !m.classList.contains('hidden');
  if (visible) { m.classList.add('hidden'); m.style.display = 'none'; }
  else { m.classList.remove('hidden'); m.style.display = 'flex'; }
}
document.getElementById('btn-close-shortcuts')?.addEventListener('click', () => {
  const m = document.getElementById('shortcuts-modal');
  if (m) { m.classList.add('hidden'); m.style.display = 'none'; }
});

document.addEventListener('keydown', (e) => {
  const tag = (e.target.tagName || '').toUpperCase();
  const isInput = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

  // Escape: modal + create-room-form хаах (input дотор ч ажиллана)
  if (e.key === 'Escape') {
    const modals = [
      'shortcuts-modal',
      'user-profile-modal',
      'confirm-modal',
      'dm-modal',
      'password-modal',
    ];
    for (const id of modals) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden') && el.style.display !== 'none') {
        el.classList.add('hidden');
        el.style.display = 'none';
        return;
      }
    }
    // create-room-form (display: block/none ашигладаг)
    const crForm = document.getElementById('create-room-form');
    if (crForm && crForm.style.display === 'block') {
      crForm.style.display = 'none';
      return;
    }
    // Input-д байвал blur хийх
    if (isInput) { e.target.blur(); return; }
    return;
  }

  // Ctrl+Enter: чат input дотроос мессеж илгээх
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    const activeEl = document.activeElement;
    if (activeEl?.id === 'chat-input') {
      document.getElementById('btn-send')?.click();
    } else if (activeEl?.id === 'dm-input') {
      document.getElementById('btn-dm-send')?.click();
    }
    return;
  }

  // Ctrl+K: room search focus (input дотор ч ажиллана)
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    const search = document.getElementById('room-search');
    if (search) { search.focus(); search.select(); }
    return;
  }

  // Input дотор бол бусад shortcut skip
  if (isInput) return;

  const mainActive = document.getElementById('page-main')?.classList.contains('active');

  // ? → shortcut help
  if (e.key === '?') { toggleShortcutsModal(); return; }

  // Alt+1/2/3 → tab шилжих
  if (e.altKey && e.key === '1' && mainActive) { e.preventDefault(); showTab('lobby'); return; }
  if (e.altKey && e.key === '2' && mainActive) { e.preventDefault(); showTab('ranking'); return; }
  if (e.altKey && e.key === '3' && mainActive) { e.preventDefault(); showTab('settings'); return; }

  // Alt+N → create room toggle
  if (e.altKey && (e.key === 'n' || e.key === 'N') && mainActive) {
    e.preventDefault();
    document.getElementById('btn-create-room')?.click();
    return;
  }

  // Alt+Q → quickmatch
  if (e.altKey && (e.key === 'q' || e.key === 'Q') && mainActive) {
    e.preventDefault();
    document.getElementById('btn-quickmatch')?.click();
    return;
  }

  // Alt+R → refresh rooms
  if (e.altKey && (e.key === 'r' || e.key === 'R') && mainActive) {
    e.preventDefault();
    loadRooms();
    return;
  }
});

// ── Scroll-to-top ────────────────────────────────────────
const _scrollTopBtn = document.getElementById('scroll-top-btn');
if (_scrollTopBtn) {
  _scrollTopBtn.addEventListener('click', () => {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab) activeTab.scrollTo({ top: 0, behavior: 'smooth' });
  });
  // Tab scroll event → show/hide button
  document.addEventListener('scroll', (e) => {
    const tab = e.target.closest?.('.tab');
    if (tab && tab.classList.contains('active')) {
      _scrollTopBtn.classList.toggle('visible', tab.scrollTop > 200);
    }
  }, true);
}

// ── Onboarding Tour ──────────────────────────────────────
const ONBOARDING_STEPS = [
  { target: '[data-tab="lobby"]',    title: 'Lobby',          text: 'Энд бүх өрөөнүүдийг харж, нэгдэж болно.' },
  { target: '#btn-create-room',      title: 'Өрөө үүсгэх',   text: 'Шинэ тоглоомын өрөө үүсгэхийн тулд энд дарна.' },
  { target: '#btn-quickmatch',       title: 'Хурдан тоглолт', text: 'Нэг товчоор боломжтой өрөөнд автоматаар нэгдэнэ.' },
  { target: '#room-search',          title: 'Хайлт',          text: 'Өрөөг нэрээр хайх боломжтой. Ctrl+K товчоор хурдан нээнэ.' },
  { target: '#lobby-chat-input',     title: 'Чат',            text: 'Бүх хэрэглэгчидтэй чатлах боломжтой. @нэр бичвэл mention хийнэ.' },
  { target: '[data-tab="ranking"]',  title: 'Ranking',        text: 'Тоглогчдын чансааг энд харна.' },
  { target: '[data-tab="settings"]', title: 'Тохиргоо',       text: 'Профайл засах, нууц үг солих, тоглоом нэмэх зэрэг тохиргоо.' },
  { target: '#btn-theme',            title: 'Загвар',         text: 'Гэрэл/харанхуй горим сольж болно.' },
];

let _onboardStep = 0;
let _onboardOverlay = null;
let _onboardSpotlight = null;
let _onboardTooltip = null;

function startOnboarding() {
  if (localStorage.getItem('onboarding_done')) return;
  // Аль хэдийн ажиллаж байвал давхар нээхгүй
  if (_onboardOverlay) return;
  _onboardStep = 0;

  // Overlay
  _onboardOverlay = document.createElement('div');
  _onboardOverlay.className = 'onboarding-overlay';
  _onboardOverlay.addEventListener('click', (e) => {
    if (e.target === _onboardOverlay) _onboardNext();
  });
  document.body.appendChild(_onboardOverlay);

  // Spotlight
  _onboardSpotlight = document.createElement('div');
  _onboardSpotlight.className = 'onboarding-spotlight';
  document.body.appendChild(_onboardSpotlight);

  // Tooltip
  _onboardTooltip = document.createElement('div');
  _onboardTooltip.className = 'onboarding-tooltip';
  document.body.appendChild(_onboardTooltip);

  _onboardShow();
}

function _onboardShow() {
  const step = ONBOARDING_STEPS[_onboardStep];
  if (!step) { _onboardFinish(); return; }

  const el = document.querySelector(step.target);
  if (!el) { _onboardStep++; _onboardShow(); return; }

  // Spotlight position
  const rect = el.getBoundingClientRect();
  const pad = 6;
  _onboardSpotlight.style.left   = (rect.left - pad) + 'px';
  _onboardSpotlight.style.top    = (rect.top - pad) + 'px';
  _onboardSpotlight.style.width  = (rect.width + pad * 2) + 'px';
  _onboardSpotlight.style.height = (rect.height + pad * 2) + 'px';

  // Tooltip content
  const isLast = _onboardStep === ONBOARDING_STEPS.length - 1;
  _onboardTooltip.innerHTML = `
    <h4>${step.title}</h4>
    <p>${step.text}</p>
    <div class="onboarding-actions">
      <span class="onboarding-steps">${_onboardStep + 1} / ${ONBOARDING_STEPS.length}</span>
      <div style="display:flex;gap:6px">
        <button class="btn" id="ob-skip">Алгасах</button>
        <button class="btn btn-primary" id="ob-next">${isLast ? 'Дуусгах' : 'Дараах'}</button>
      </div>
    </div>
  `;

  // Tooltip position — prefer below, fallback above
  const ttW = 280;
  let ttLeft = rect.left + rect.width / 2 - ttW / 2;
  let ttTop = rect.bottom + 12;
  if (ttTop + 150 > window.innerHeight) {
    ttTop = rect.top - 12;
    _onboardTooltip.style.transform = 'translateY(-100%)';
  } else {
    _onboardTooltip.style.transform = 'none';
  }
  ttLeft = Math.max(8, Math.min(ttLeft, window.innerWidth - ttW - 8));
  _onboardTooltip.style.left = ttLeft + 'px';
  _onboardTooltip.style.top = ttTop + 'px';
  _onboardTooltip.style.width = ttW + 'px';

  document.getElementById('ob-next').onclick = _onboardNext;
  document.getElementById('ob-skip').onclick = _onboardFinish;
}

function _onboardNext() {
  _onboardStep++;
  if (_onboardStep >= ONBOARDING_STEPS.length) { _onboardFinish(); return; }
  _onboardShow();
}

function _onboardFinish() {
  localStorage.setItem('onboarding_done', '1');
  if (_onboardOverlay) _onboardOverlay.remove();
  if (_onboardSpotlight) _onboardSpotlight.remove();
  if (_onboardTooltip) _onboardTooltip.remove();
  _onboardOverlay = _onboardSpotlight = _onboardTooltip = null;
  showToast('Тавтай морил! Тоглоомоо эхлүүлээрэй', 'success');
}

// Resize → reposition
window.addEventListener('resize', () => {
  if (_onboardTooltip) _onboardShow();
});

// Сургалт дахин эхлүүлэх товч
document.getElementById('btn-restart-tour')?.addEventListener('click', () => {
  localStorage.removeItem('onboarding_done');
  // Тохиргоо табаас lobby таб руу шилжих
  document.querySelector('[data-tab="lobby"]')?.click();
  setTimeout(() => startOnboarding(), 400);
});

// ── Discord Servers ───────────────────────────────────────
// "Сервер нэмэх" товч — жагсаалтын эхэнд тод card байрлуулна
function _discordAddCard() {
  return `
    <div class="room-card discord-server-card" id="discord-add-card"
         style="border:2px dashed var(--accent);cursor:pointer;text-align:center;padding:18px;opacity:0.85;"
         title="Сервер нэмэх">
      <div style="font-size:2rem;margin-bottom:6px">➕</div>
      <strong style="color:var(--accent)">Сервер нэмэх</strong>
      <p class="meta hint" style="margin-top:4px">Discord серверийнхаа урилга холбоосыг нэмнэ үү</p>
    </div>`;
}

async function loadDiscordServers() {
  const list = document.getElementById('discord-servers-list');
  if (!list) return;
  list.innerHTML = '<p class="empty-text">Ачааллаж байна...</p>';
  try {
    const servers = await window.api.getDiscordServers();
    const addCard = _discordAddCard();
    if (!servers.length) {
      list.innerHTML = addCard;
      list.querySelector('#discord-add-card').addEventListener('click', () => toggleDiscordForm());
      return;
    }
    list.innerHTML = addCard + servers.map(s => {
      const isOwn = currentUser && String(s.added_by_id) === String(currentUser.id);
      const m = s.discord_meta;
      const expired = s.invite_expired;
      const iconUrl = m && m.guild_icon
        ? `https://cdn.discordapp.com/icons/${m.guild_id}/${m.guild_icon}.png?size=64`
        : '';
      const iconHtml = iconUrl
        ? `<img class="discord-guild-icon" src="${iconUrl}" alt="" />`
        : `<span class="discord-guild-icon-placeholder">🎮</span>`;
      const memberHtml = m && m.member_count
        ? `<span class="discord-meta-counts"><span class="discord-members">👥 ${m.member_count.toLocaleString()} гишүүн</span><span class="discord-online">🟢 ${m.presence_count.toLocaleString()} онлайн</span></span>`
        : '';
      const expiredHtml = expired
        ? `<p class="discord-expired-warning">⚠️ Урилга холбоос хүчингүй болсон${isOwn ? ' — Засах товч дарж шинэ холбоос оруулна уу' : ''}</p>`
        : '';
      return `
        <div class="room-card discord-server-card${expired ? ' discord-expired' : ''}">
          <div class="room-card-header">
            ${iconHtml}
            <div class="discord-header-text">
              <strong>${escHtml(m && m.guild_name ? m.guild_name : s.name)}</strong>
              ${memberHtml}
            </div>
          </div>
          ${s.description ? `<p class="meta">${escHtml(s.description)}</p>` : ''}
          ${expiredHtml}
          <p class="meta hint">Нэмсэн: <a href="#" class="discord-added-by-link" data-user-id="${s.added_by_id}" data-username="${escHtml(s.added_by_username)}">${escHtml(s.added_by_username)}</a></p>
          <div class="discord-card-footer">
            <button type="button" class="btn btn-primary btn-sm btn-discord-join${expired ? ' btn-disabled' : ''}" data-url="${escHtml(s.invite_url)}"${expired ? ' disabled' : ''}>
              ${expired ? 'Холбоос хүчингүй' : 'Нэгдэх →'}
            </button>
            ${!isOwn && currentUser ? `<button type="button" class="btn btn-sm btn-ds-dm" data-user-id="${s.added_by_id}" data-username="${escHtml(s.added_by_username)}">💬 DM</button>` : ''}
            ${isOwn ? `
              <button type="button" class="btn btn-sm btn-ds-edit" data-id="${s.id}"
                data-name="${escHtml(s.name)}" data-url="${escHtml(s.invite_url)}"
                data-desc="${escHtml(s.description || '')}">✏️ Засах</button>
              <button type="button" class="btn btn-sm btn-danger-soft btn-ds-delete" data-id="${s.id}">Устгах</button>
            ` : ''}
          </div>
        </div>`;
    }).join('');

    list.querySelector('#discord-add-card')?.addEventListener('click', () => toggleDiscordForm());
    list.querySelectorAll('.btn-discord-join').forEach(btn => {
      btn.onclick = () => window.api.openDiscordInvite(btn.dataset.url);
    });
    list.querySelectorAll('.btn-ds-delete').forEach(btn => {
      btn.onclick = async () => {
        if (!await showConfirm('Сервер устгах', 'Энэ Discord серверийг жагсаалтаас устгах уу?')) return;
        try {
          await window.api.deleteDiscordServer(Number(btn.dataset.id));
          showToast('Устгагдлаа', 'success');
          loadDiscordServers();
        } catch (err) {
          showToast(`Алдаа: ${err.message}`, 'error');
        }
      };
    });
    list.querySelectorAll('.btn-ds-edit').forEach(btn => {
      btn.onclick = () => {
        const form = document.getElementById('discord-server-form');
        const title = form.querySelector('h3');
        const submitBtn = document.getElementById('btn-ds-submit');
        document.getElementById('ds-name').value        = btn.dataset.name || '';
        document.getElementById('ds-invite-url').value  = btn.dataset.url  || '';
        document.getElementById('ds-description').value = btn.dataset.desc || '';
        document.getElementById('ds-form-error').textContent = '';
        form.dataset.editingId = btn.dataset.id;
        if (title)    title.textContent    = 'Discord сервер засах';
        if (submitBtn) submitBtn.textContent = 'Хадгалах';
        form.classList.remove('hidden');
        document.getElementById('ds-name').focus();
        form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };
    });
    // Нэмсэн хүний нэр дарахад profile нээх
    list.querySelectorAll('.discord-added-by-link').forEach(link => {
      link.onclick = (e) => {
        e.preventDefault();
        const uid = link.dataset.userId;
        if (uid && currentUser && String(uid) !== String(currentUser.id)) {
          openUserProfile(Number(uid));
        }
      };
    });
    // DM товч
    list.querySelectorAll('.btn-ds-dm').forEach(btn => {
      btn.onclick = (e) => {
        e.stopPropagation();
        openDM(btn.dataset.userId, btn.dataset.username);
      };
    });
  } catch (err) {
    list.innerHTML = `<p class="empty-text">Серверийн жагсаалт ачаалахад алдаа гарлаа</p>`;
  }
}

function toggleDiscordForm() {
  const form = document.getElementById('discord-server-form');
  const isHidden = form.classList.contains('hidden');
  if (isHidden) {
    const title = form.querySelector('h3');
    const submitBtn = document.getElementById('btn-ds-submit');
    delete form.dataset.editingId;
    if (title)    title.textContent     = 'Шинэ Discord сервер нэмэх';
    if (submitBtn) submitBtn.textContent = 'Нэмэх';
    form.classList.remove('hidden');
    document.getElementById('ds-name').focus();
  } else {
    _resetDiscordForm();
  }
};

function _resetDiscordForm() {
  const form = document.getElementById('discord-server-form');
  const title = form.querySelector('h3');
  const submitBtn = document.getElementById('btn-ds-submit');
  form.classList.add('hidden');
  delete form.dataset.editingId;
  document.getElementById('ds-name').value        = '';
  document.getElementById('ds-invite-url').value  = '';
  document.getElementById('ds-description').value = '';
  document.getElementById('ds-form-error').textContent = '';
  if (title)    title.textContent     = 'Шинэ Discord сервер нэмэх';
  if (submitBtn) submitBtn.textContent = 'Нэмэх';
}

document.getElementById('btn-ds-cancel').onclick = _resetDiscordForm;

document.getElementById('btn-ds-submit').onclick = async () => {
  const name        = document.getElementById('ds-name').value.trim();
  const invite_url  = document.getElementById('ds-invite-url').value.trim();
  const description = document.getElementById('ds-description').value.trim();
  const errEl       = document.getElementById('ds-form-error');
  const form        = document.getElementById('discord-server-form');
  errEl.textContent = '';
  if (!name)       { errEl.textContent = 'Серверийн нэр оруулна уу';  return; }
  if (!invite_url) { errEl.textContent = 'Discord урилгын холбоос оруулна уу'; return; }

  const editingId = form.dataset.editingId ? Number(form.dataset.editingId) : null;
  try {
    if (editingId) {
      await window.api.editDiscordServer(editingId, { name, invite_url, description });
      showToast('Discord сервер шинэчлэгдлээ! ✅', 'success');
    } else {
      await window.api.addDiscordServer({ name, invite_url, description });
      showToast('Discord сервер нэмэгдлээ! 🎮', 'success');
    }
    _resetDiscordForm();
    loadDiscordServers();
  } catch (err) {
    errEl.textContent = err.message;
  }
};

// ── Эхлүүлэх ─────────────────────────────────────────────
init();
