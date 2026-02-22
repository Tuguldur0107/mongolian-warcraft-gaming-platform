const SERVER = 'https://mongolian-warcraft-gaming-platform-production.up.railway.app';

// ── Socket.io ─────────────────────────────────────────────
let socket = null;
let currentRoom = null;
let currentUser = null;

// ── Чат төлөв ─────────────────────────────────────────────
const dmConversations = {};
let activeDmUserId = null;
let chatUnreadCount = 0;

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

// ── Өрөөний цонх горим ───────────────────────────────────
function isRoomMode() {
  return new URLSearchParams(window.location.search).get('mode') === 'room';
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
      // JWT middleware-ийн ачаар username/userId-г серверт дахин илгээх шаардлагагүй
      // Гэхдээ lobby-д бүртгүүлэхийн тулд event илгээнэ
      socket.emit('lobby:register');
    }
  });

  // Найз хүсэлт ирэх
  socket.on('friend:request', ({ fromUserId, fromUsername }) => {
    const exists = pendingRequests.find(p => String(p.id) === String(fromUserId));
    if (!exists) {
      pendingRequests.push({ id: fromUserId, username: fromUsername, avatar_url: null });
      updatePendingBadge();
      renderFriendsTab();
      showDMNotification(`${fromUsername} найз болохыг хүсэж байна`);
    }
  });

  // Найз хүсэлт зөвшөөрөгдсөн
  socket.on('friend:accepted', ({ byUserId, byUsername }) => {
    const exists = myFriends.find(f => String(f.id) === String(byUserId));
    if (!exists) {
      myFriends.push({ id: byUserId, username: byUsername, avatar_url: null });
      renderFriendsTab();
      showDMNotification(`${byUsername} найз болохыг зөвшөөрлөө`);
    }
  });

  // Өрөөнд урих
  socket.on('room:invited', ({ fromUsername, fromUserId, roomId, roomName }) => {
    showRoomInvite(fromUsername, roomId, roomName);
  });

  socket.on('disconnect', () => {
    console.log('Socket салгагдлаа');
    updateConnectionStatus('offline');
  });
  socket.on('reconnecting', () => updateConnectionStatus('reconnecting'));

  // Өрөөний чат
  socket.on('chat:message',     (msg)     => appendMessage(msg));
  socket.on('room:members',     (members) => renderMembers(members));
  socket.on('room:user_joined', ({ username }) => appendSysMsg(`${username} нэгдлээ`));
  socket.on('room:user_left',   ({ username }) => appendSysMsg(`${username} гарлаа`));

  // Өрөөний тохиргоо шинэчлэгдсэн
  socket.on('room:updated', (room) => {
    if (currentRoom) {
      if (room.name) document.getElementById('room-title').textContent = room.name;
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
    }, 2000);
  });

  // Онлайн тоглогчид (лобби)
  socket.on('lobby:online_users', (users) => {
    const prevOnlineIds = new Set(onlineUserIds);
    onlineUserIds = new Set(users.map(u => String(typeof u === 'object' ? u.userId : u)));
    renderOnlineUsers(users);
    renderFriendsTab();
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
    const box = document.getElementById('lobby-chat-messages');
    if (!box) return;
    box.innerHTML = '';
    msgs.forEach(msg => appendLobbyMessage(msg, true)); // true = историйн мессеж (тоолохгүй)
    box.scrollTop = box.scrollHeight;
  });

  // Өрөөний чатын түүх
  socket.on('room:history', (msgs) => {
    msgs.forEach(msg => appendMessage(msg));
  });

  // Typing indicator (DM)
  socket.on('typing:start', ({ fromUserId, fromUsername }) => {
    if (activeDmUserId !== String(fromUserId)) return;
    let indicator = document.getElementById('dm-typing-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'dm-typing-indicator';
      indicator.className = 'sys-msg';
      document.getElementById('dm-messages')?.after(indicator);
    }
    indicator.textContent = `${fromUsername} бичиж байна...`;
    indicator.style.display = 'block';
    clearTimeout(indicator._hideTimer);
    indicator._hideTimer = setTimeout(() => { indicator.style.display = 'none'; }, 2000);
  });

  socket.on('typing:stop', ({ fromUserId }) => {
    if (activeDmUserId !== String(fromUserId)) return;
    const indicator = document.getElementById('dm-typing-indicator');
    if (indicator) indicator.style.display = 'none';
  });

  // Хувийн мессеж
  socket.on('private:message', (msg) => handleIncomingDM(msg));
  socket.on('private:sent',    (msg) => handleSentDM(msg));

  // Өрөөний эзэн өрөөг хаасан
  socket.on('room:closed', ({ reason }) => {
    if (!currentRoom) return;
    appendSysMsg(`⚠️ ${reason || 'Өрөө хаагдлаа'}`);
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
    setTimeout(() => {
      currentRoom = null;
      if (isRoomMode()) { window.close(); }
      else { showPage('page-main'); loadRooms(); }
    }, 1500);
  });

  // Тоглолт эхэлсэн (эзэн биш тоглогчдод)
  socket.on('room:started', () => {
    appendSysMsg('▶ Тоглолт эхэллээ!');
    socket.emit('room:game_started'); // статусыг 'in_game' болгох
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
  if (name === 'chat') {
    chatUnreadCount = 0;
    updateChatBadge();
    loadSocialData();
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
    document.getElementById('auth-login').style.display    = which === 'login'    ? '' : 'none';
    document.getElementById('auth-register').style.display = which === 'register' ? '' : 'none';
    document.getElementById('auth-forgot').style.display   = 'none';
  };
});

// ── Эхлүүлэх ─────────────────────────────────────────────
async function init() {
  // Өрөөний цонх горим: URL-аас params унших
  if (isRoomMode()) {
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

    _enterRoomUI(id, name, gameType, isHost, hostId);

    // Цонх хаагдахад өрөөнөөс гарах
    window.addEventListener('beforeunload', () => {
      if (currentRoom) {
        if (socket) {
          socket.emit('room:leave', { roomId: currentRoom.id });
        }
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
  });

  window.api.onGameResult((data) => showGameResult(data));

  // Өрөөний цонх хаагдахад lobby шинэчлэх
  window.api.onRoomWindowClosed(() => loadRooms());
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

// ── Lobby — өрөөнүүд ─────────────────────────────────────
async function loadRooms() {
  const waiting = document.getElementById('rooms-waiting');
  const playing = document.getElementById('rooms-playing');
  waiting.innerHTML = '<p class="empty-text">Ачааллаж байна...</p>';
  playing.innerHTML = '';
  try {
    const rooms = await window.api.getRooms();
    const waitRooms = rooms.filter(r => r.status === 'waiting');
    const playRooms = rooms.filter(r => r.status === 'playing');
    waiting.innerHTML = waitRooms.length
      ? waitRooms.map(r => roomCard(r, false)).join('')
      : '<p class="empty-text">Одоогоор нээлттэй өрөө байхгүй</p>';
    playing.innerHTML = playRooms.length
      ? playRooms.map(r => roomCard(r, true)).join('')
      : '<p class="empty-text">Одоогоор тоглолт явагдахгүй байна</p>';
  } catch {
    waiting.innerHTML = '<p class="empty-text">Серверт холбогдож чадсангүй</p>';
  }
}

function roomCard(r, inProgress) {
  const lock     = r.has_password ? '🔒 ' : '';
  const myId     = String(currentUser?.id);
  const isMyRoom = String(r.host_id) === myId ||
                   (r.members || []).some(m => String(m.id) === myId);
  const names    = (r.members || []).map(m => m.name || m).slice(0, 6).join(', ');
  const overflow = (r.members?.length || 0) > 6 ? '...' : '';

  let joinBtn;
  if (isMyRoom) {
    joinBtn = `<button class="btn btn-sm btn-primary" onclick="rejoinMyRoom('${r.id}','${r.name}','${r.game_type}','${r.host_id}',${String(r.host_id) === myId})">↩ Буцах</button>`;
  } else if (inProgress) {
    joinBtn = `<button class="btn btn-sm btn-primary btn-with-icon" onclick="joinPlayingRoom('${r.id}','${r.name}','${r.game_type}','${r.host_id}')"><svg class="btn-icon-svg" style="width:13px;height:13px"><use href="#ico-join"/></svg> Нэгдэх</button>`;
  } else {
    joinBtn = `<button class="btn btn-primary btn-sm" onclick="joinRoom('${r.id}','${r.name}','${r.game_type}',${r.has_password},'${r.host_id}')">Нэгдэх</button>`;
  }

  return `
    <div class="room-card ${inProgress ? 'room-playing' : ''} ${isMyRoom ? 'room-mine' : ''}">
      <div class="room-card-header">
        <span class="badge game-badge" style="background:${gameTypeColor(r.game_type)}">${escHtml(r.game_type)}</span>
        <span class="room-name">${lock}${r.name}</span>
        ${isMyRoom ? '<span class="my-room-tag">Миний өрөө</span>' : ''}
      </div>
      <div class="meta">👥 ${r.player_count}/${r.max_players} &nbsp;|&nbsp; Эзэн: ${r.host_name}</div>
      ${names ? `<div class="room-members">${names}${overflow}</div>` : ''}
      ${joinBtn}
    </div>
  `;
}

function rejoinMyRoom(id, name, gameType, hostId, isHost) {
  enterRoom(id, name, gameType, isHost, hostId);
}

async function joinPlayingRoom(id, name, gameType, hostId) {
  if (!confirm(`"${name}" тоглолтод нэгдэх үү? "${gameType}" тоглоом нээгдэнэ.`)) return;
  try {
    await window.api.launchGame(gameType);
  } catch (err) {
    alert(`Тоглоом нээхэд алдаа гарлаа: ${err.message}`);
  }
}

document.getElementById('btn-refresh').onclick = loadRooms;

// Хурдан тоглолт
document.getElementById('btn-quickmatch').onclick = async () => {
  const gameType = configuredGames[0]?.name;
  if (!gameType) return alert('Эхлээд Тохируулга таб-д тоглоом нэмнэ үү');
  const btn = document.getElementById('btn-quickmatch');
  btn.disabled = true; btn.textContent = '⏳ ...';
  try {
    const result = await window.api.quickMatch(gameType);
    const room = result.room;
    const isHost = !result.joined && String(room.host_id) === String(currentUser?.id);
    enterRoom(String(room.id), room.name, room.game_type, isHost, String(room.host_id));
  } catch (err) {
    alert(`Хурдан тоглолт: ${err.message}`);
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
  const max_players = parseInt(document.getElementById('room-max').value);
  const hasPass     = document.getElementById('room-has-password').checked;
  const password    = hasPass ? document.getElementById('room-password').value : null;
  if (!name) return alert('Өрөөний нэр оруулна уу');
  if (!game_type) return alert('Тоглоом сонгоно уу (Тохируулга таб-д тоглоом нэмнэ үү)');
  if (hasPass && !password) return alert('Нууц үг оруулна уу');
  try {
    const room = await window.api.createRoom({ name, max_players, game_type, password });
    document.getElementById('create-room-form').style.display = 'none';
    document.getElementById('room-name').value = '';
    document.getElementById('room-has-password').checked = false;
    document.getElementById('room-password').value = '';
    document.getElementById('room-password').style.display = 'none';
    enterRoom(room.id, room.name, room.game_type, true);
  } catch (err) { alert(`Алдаа: ${err.message}`); }
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
      alert(`Алдаа: ${err.message}`);
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
function enterRoom(id, name, gameType, isHost, hostId) {
  const resolvedHostId = hostId ? String(hostId) : String(currentUser?.id);
  window.api.openRoomWindow({ id, name, gameType, isHost, hostId: resolvedHostId });
}

// Өрөөний цонхны UI тохируулга (room цонхноос шууд дуудагдана)
function _enterRoomUI(id, name, gameType, isHost, hostId) {
  currentRoom = { id, name, gameType, isHost, hostId: hostId || String(currentUser?.id) };

  document.getElementById('room-title').textContent = name;
  document.getElementById('room-badge').textContent = gameType;
  document.getElementById('room-badge').className   = 'badge game-badge';
  document.getElementById('room-badge').style.background = gameTypeColor(gameType);
  document.getElementById('room-info-text').textContent = `${name} | ${gameType}`;
  document.getElementById('chat-messages').innerHTML  = '';
  document.getElementById('members-list').innerHTML   = '';
  document.getElementById('btn-close-room').style.display = isHost ? 'block' : 'none';

  const launchBtn = document.getElementById('btn-launch-wc3');
  launchBtn.querySelector('span').textContent = isHost ? 'Тоглолт эхлүүлэх' : 'Тоглоом эхлүүлэх';

  showPage('page-room');

  if (socket && currentUser) {
    socket.emit('room:join', { roomId: id });
  }
  appendSysMsg(`"${name}" өрөөнд нэгдлээ.`);
}

// ── Өрөөний товчнууд ──────────────────────────────────────
document.getElementById('btn-leave-room').onclick = async () => {
  if (!currentRoom) return;
  if (socket && currentUser) {
    socket.emit('room:leave', { roomId: currentRoom.id });
  }
  try { await window.api.leaveRoom(currentRoom.id); } catch {}
  currentRoom = null;
  if (isRoomMode()) { window.close(); }
  else { showPage('page-main'); loadRooms(); }
};

document.getElementById('btn-close-room').onclick = async () => {
  if (!currentRoom) return;
  if (!confirm(`"${currentRoom.name}" өрөөг хаах уу? Бүх тоглогчид гарна.`)) return;
  try {
    await window.api.closeRoom(currentRoom.id);
    currentRoom = null;
    if (isRoomMode()) { window.close(); }
    else { showPage('page-main'); loadRooms(); }
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  }
};

// Тоглоом эхлүүлэх
document.getElementById('btn-launch-wc3').onclick = async () => {
  const gameType = currentRoom?.gameType || '';
  appendSysMsg(`"${gameType}" тоглоом эхлүүлж байна...`);
  try {
    await window.api.launchGame(gameType);
    appendSysMsg('✓ Тоглоом нээгдлээ. LAN горим сонгоно уу.');
    if (currentRoom?.isHost) {
      try {
        await window.api.startRoom(currentRoom.id);
        appendSysMsg('▶ Тоглолт эхэллээ!');
        if (socket) socket.emit('room:game_started');
      } catch {}
    }
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  }
};

// ── Өрөөний чат ──────────────────────────────────────────
function appendMessage({ username, text, time }) {
  const box  = document.getElementById('chat-messages');
  const isMe = username === currentUser?.username;
  const t    = new Date(time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : 'other'}`;
  div.innerHTML = `
    <div class="msg-name">${isMe ? 'Та' : escHtml(username)}</div>
    <div class="msg-bubble">${escHtml(text)}</div>
    <div class="msg-time">${t}</div>
  `;
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
    return `<li class="${isMe ? 'me' : ''}">
      ${isRoomHost ? '👑 ' : ''}${name}${isMe ? ' (Та)' : ''}
      ${kickBtn}
    </li>`;
  }).join('');

  ul.querySelectorAll('.kick-btn').forEach(btn => {
    btn.onclick = () => kickPlayer(btn.dataset.id, btn.dataset.name);
  });
}

async function kickPlayer(targetId, targetName) {
  if (!currentRoom || !targetId) return;
  if (!confirm(`${targetName}-г өрөөнөөс гаргах уу?`)) return;
  try {
    await window.api.kickPlayer(currentRoom.id, targetId);
    appendSysMsg(`✓ ${targetName} гаргагдлаа`);
  } catch (err) {
    appendSysMsg(`⚠️ ${err.message}`);
  }
}

// ── Нийтийн лобби чат ────────────────────────────────────
function appendLobbyMessage({ username, text, time }, isHistory = false) {
  const box = document.getElementById('lobby-chat-messages');
  if (!box) return;
  const isMe = username === currentUser?.username;
  const t    = new Date(time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
  const div  = document.createElement('div');
  div.className = `msg ${isMe ? 'me' : 'other'}`;
  div.innerHTML = `
    <div class="msg-name">${isMe ? 'Та' : escHtml(username)}</div>
    <div class="msg-bubble">${escHtml(text)}</div>
    <div class="msg-time">${t}</div>
  `;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;

  if (!isMe && !isHistory) {
    const chatTab = document.getElementById('tab-chat');
    if (!chatTab?.classList.contains('active')) {
      chatUnreadCount++;
      updateChatBadge();
    }
  }
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

// ── Private мессеж (DM) ───────────────────────────────────
async function openDM(userId, username) {
  activeDmUserId = String(userId);
  if (!dmConversations[activeDmUserId]) {
    dmConversations[activeDmUserId] = { username, messages: [], unread: 0 };
  }
  dmConversations[activeDmUserId].unread = 0;
  document.getElementById('dm-title').textContent = `🔒 ${escHtml(username)}`;
  document.getElementById('dm-modal').style.display = 'flex';
  setTimeout(() => document.getElementById('dm-input').focus(), 50);

  // Серверээс DM түүх татах
  try {
    const history = await window.api.getDMHistory(userId);
    if (history.length > 0) {
      // Серверийн мессежийг стандарт хэлбэрт хөрвүүлэх
      const conv = dmConversations[activeDmUserId];
      conv.messages = history.map(m => ({
        fromUsername: m.sender_username,
        fromUserId:   String(m.sender_id),
        text:         m.text,
        time:         m.created_at,
        id:           m.id,
      }));
      renderDMMessages();
    } else {
      renderDMMessages();
    }
  } catch {
    renderDMMessages();
  }

  // Уншсан тэмдэглэх
  window.api.markDMRead(userId).catch(() => {});
}

function renderDMMessages() {
  const box  = document.getElementById('dm-messages');
  const conv = dmConversations[activeDmUserId];
  if (!conv || !box) return;
  box.innerHTML = '';
  if (conv.messages.length === 0) {
    box.innerHTML = `<p class="sys-msg" style="margin-top:20px">${escHtml(conv.username)}-д анхны мессеж илгээгээрэй</p>`;
    return;
  }
  conv.messages.forEach(msg => {
    const isMe = msg.fromUsername === currentUser?.username;
    const t    = new Date(msg.time).toLocaleTimeString('mn-MN', { hour: '2-digit', minute: '2-digit' });
    const div  = document.createElement('div');
    div.className = `msg ${isMe ? 'me' : 'other'}`;
    div.innerHTML = `
      <div class="msg-name">${isMe ? 'Та' : escHtml(msg.fromUsername)}</div>
      <div class="msg-bubble">${escHtml(msg.text)}</div>
      <div class="msg-time">${t}</div>
    `;
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function sendDM() {
  const input = document.getElementById('dm-input');
  const text  = input.value.trim();
  if (!text || !activeDmUserId || !socket) return;
  socket.emit('private:message', { toUserId: activeDmUserId, text });
  input.value = '';
}

function handleIncomingDM({ fromUsername, fromUserId, text, time }) {
  const uid = String(fromUserId);
  if (!dmConversations[uid]) {
    dmConversations[uid] = { username: fromUsername, messages: [], unread: 0 };
  }
  dmConversations[uid].messages.push({ fromUsername, text, time });

  if (activeDmUserId === uid && document.getElementById('dm-modal').style.display !== 'none') {
    renderDMMessages();
  } else {
    dmConversations[uid].unread = (dmConversations[uid].unread || 0) + 1;
    renderDMUsersBadges();
    showDMNotification(`${fromUsername}-аас мессеж ирлээ`);
  }
}

function handleSentDM({ fromUsername, toUserId, text, time }) {
  const uid = String(toUserId);
  if (!dmConversations[uid]) return;
  dmConversations[uid].messages.push({ fromUsername, text, time });
  if (activeDmUserId === uid) renderDMMessages();
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
  } catch (err) { alert(err.message); }
}

async function declineFriend(fromId) {
  try {
    await window.api.declineFriendRequest(fromId);
    pendingRequests = pendingRequests.filter(p => String(p.id) !== String(fromId));
    updatePendingBadge();
    renderFriendsTab();
  } catch (err) { alert(err.message); }
}

async function removeFriendClick(friendId, friendName) {
  if (!confirm(`${friendName}-г найзуудаас хасах уу?`)) return;
  try {
    await window.api.removeFriend(friendId);
    myFriends = myFriends.filter(f => String(f.id) !== String(friendId));
    renderFriendsTab();
    renderOnlineUsersFromCache();
  } catch (err) { alert(err.message); }
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
  if (!confirm(`${targetName}-г хаах уу? Найзлалт устгагдана.`)) return;
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
  } catch (err) { alert(err.message); }
}

async function unblockUserClick(targetId, targetName) {
  if (!confirm(`${targetName}-г хаалтаас гаргах уу?`)) return;
  try {
    await window.api.unblockUser(targetId);
    blockedUsers = blockedUsers.filter(b => String(b.id) !== String(targetId));
    renderBlockedTab();
    renderOnlineUsersFromCache();
  } catch (err) { alert(err.message); }
}

async function addFriendClick(targetId, targetName) {
  try {
    await window.api.sendFriendRequest(targetId);
    showDMNotification(`${targetName}-д найз хүсэлт илгээлээ`);
    renderOnlineUsersFromCache();
  } catch (err) { alert(err.message || 'Найз хүсэлт илгээхэд алдаа гарлаа'); }
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

document.getElementById('btn-dm-send').onclick = sendDM;

// Typing indicator — DM input дээр бичих үед
let _typingTimer = null;
let _isTyping = false;
document.getElementById('dm-input').addEventListener('input', () => {
  if (!activeDmUserId || !socket) return;
  if (!_isTyping) {
    _isTyping = true;
    socket.emit('typing:start', { toUserId: activeDmUserId });
  }
  clearTimeout(_typingTimer);
  _typingTimer = setTimeout(() => {
    _isTyping = false;
    socket.emit('typing:stop', { toUserId: activeDmUserId });
  }, 2000);
});

document.getElementById('dm-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendDM();
});
document.getElementById('btn-close-dm').onclick = () => {
  document.getElementById('dm-modal').style.display = 'none';
  activeDmUserId = null;
  if (_isTyping && socket) {
    socket.emit('typing:stop', { toUserId: activeDmUserId });
    _isTyping = false;
  }
};

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
  tbody.innerHTML = '<tr><td colspan="5" class="empty-text">Ачааллаж байна...</td></tr>';
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

    // Friend button (don't show for self)
    if (currentUser && String(userId) !== String(currentUser.id)) {
      const wrap = document.getElementById('popup-friend-btn-wrap');
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

async function loadProfile() {
  try {
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
    if (!confirm('Discord холболтыг салгахдаа итгэлтэй байна уу? Нэвтрэхэд нууц үг шаардлагатай болно.')) return;
    try {
      await window.api.unlinkDiscord();
      // Reload profile
      loadProfile();
    } catch (err) {
      alert(err.message || 'Алдаа гарлаа');
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
    if (err.message) alert(`Зураг оруулахад алдаа: ${err.message}`);
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
}

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
    const msg = err?.message || String(err);
    alert('Тоглоом нэмэхэд алдаа гарлаа:\n' + msg);
    console.error('addGame error:', err);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg class="btn-icon-svg"><use href="#ico-plus"/></svg> Тоглоом нэмэх';
  }
};

async function removeGameClick(id) {
  if (!confirm('Энэ тоглоомыг жагсаалтаас устгах уу?')) return;
  try {
    configuredGames = await window.api.removeGame(id);
    renderGamesList();
    populateRoomTypeSelect();
  } catch (err) { alert(err.message); }
}

// ── Тоглоом дуусах ───────────────────────────────────────
function showGameResult(data) {
  document.getElementById('result-text').textContent =
    `Баг ${data.winner_team} хожлоо! Үргэлжлэлт: ${data.duration_minutes} мин`;
  document.getElementById('result-modal').style.display = 'flex';
}
document.getElementById('btn-close-result').onclick = () => {
  document.getElementById('result-modal').style.display = 'none';
};

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

// ── Эхлүүлэх ─────────────────────────────────────────────
init();
