const { app, BrowserWindow, ipcMain, shell, protocol, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const QRCode = require('qrcode');
const { autoUpdater } = require('electron-updater');

const authService = require('./src/services/auth');
const replayService = require('./src/services/replay');
const zerotierService = require('./src/services/zerotier');
const apiService = require('./src/services/api');

// ── Auto-updater тохиргоо ─────────────────────────────────
autoUpdater.autoDownload    = true;   // суллагдмагц дэвсгэрт татна
autoUpdater.autoInstallOnAppQuit = false; // гараар restart хийнэ

autoUpdater.on('update-available',  (info) => {
  mainWindow?.webContents.send('update:available', { version: info.version });
});
autoUpdater.on('download-progress', (p) => {
  mainWindow?.webContents.send('update:progress', Math.round(p.percent));
});
autoUpdater.on('update-downloaded', (info) => {
  mainWindow?.webContents.send('update:downloaded', { version: info.version });
});
autoUpdater.on('error', (err) => {
  console.error('[AutoUpdater]', err.message);
});

let mainWindow;
let roomWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    title: 'Mongolian Warcraft Gaming Platform',
    icon: path.join(__dirname, 'src/renderer/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    frame: true,
    backgroundColor: '#1a1a2e',
  });

  mainWindow.loadFile('src/renderer/index.html');
}

// Discord OAuth2 deep link: wc3platform://auth?token=...
// Windows dev mode: execPath + argv[1] шаардлагатай
if (process.platform === 'win32') {
  app.setAsDefaultProtocolClient('wc3platform', process.execPath, [
    path.resolve(process.argv[1] || '.'),
  ]);
} else {
  app.setAsDefaultProtocolClient('wc3platform');
}

// Single instance — хоёр дахь instance нь deep link дамжуулна
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

app.whenReady().then(() => {
  createWindow();

  // Апп эхлэхдээ argv-д deep link байгаа эсэх шалгах (Windows)
  const deepLinkUrl = process.argv.find(a => a.startsWith('wc3platform://'));
  if (deepLinkUrl) handleDeepLink(deepLinkUrl);

  // Апп бэлэн болсноос 5 секундийн дараа update шалгах
  // (dev горимд алгасах)
  if (app.isPackaged) {
    setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  zerotierService.disconnect();
  replayService.stopWatcher();
  if (process.platform !== 'darwin') app.quit();
});

// Discord callback deep link Windows дээр
app.on('second-instance', (event, argv) => {
  const url = argv.find((arg) => arg.startsWith('wc3platform://'));
  if (url) handleDeepLink(url);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

// macOS deep link
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function handleDeepLink(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'auth') {
    const token = parsed.searchParams.get('token');
    if (token) {
      authService.saveToken(token);
      mainWindow?.webContents.send('auth:success', authService.getUser());
    }
  }
}

// ── IPC handlers ──────────────────────────────────────────

// Нэвтрэх — Electron popup цонхонд нээж redirect барина
ipcMain.handle('auth:login', () => {
  const authWin = new BrowserWindow({
    width: 520,
    height: 700,
    title: 'Discord-ээр нэвтрэх',
    parent: mainWindow,
    modal: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  authWin.loadURL(`${apiService.SERVER_URL}/auth/discord`);

  // Redirect-ийг барих (wc3platform:// эсвэл callback html-ийн token)
  const handleRedirect = (url) => {
    if (url.startsWith('wc3platform://')) {
      authWin.close();
      handleDeepLink(url);
      return true;
    }
    // Callback html хуудаснаас token авах
    if (url.includes('/auth/complete?token=')) {
      const token = new URL(url).searchParams.get('token');
      if (token) {
        authWin.close();
        authService.saveToken(token);
        mainWindow?.webContents.send('auth:success', authService.getUser());
      }
      return true;
    }
    return false;
  };

  authWin.webContents.on('will-redirect', (event, url) => {
    if (handleRedirect(url)) event.preventDefault();
  });

  authWin.webContents.on('will-navigate', (event, url) => {
    if (handleRedirect(url)) event.preventDefault();
  });

  // Callback html дотрх script-ийн redirect-ийг барих
  authWin.webContents.on('did-navigate', (_, url) => {
    if (url.includes('auth/discord/callback') || url.includes('token=')) {
      authWin.webContents.executeJavaScript(`
        (function() {
          const m = document.body?.innerText?.match(/token=([\\w.-]+)/);
          if (m) window.location.href = 'wc3platform://auth?token=' + m[1];
        })();
      `).catch(() => {});
    }
  });
});

// QR кодны data URL үүсгэх + polling эхлүүлэх
ipcMain.handle('auth:qr', async () => {
  try {
    const sessionId = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const url = `${apiService.SERVER_URL}/auth/discord?state=${sessionId}`;

    console.log('[QR] Үүсгэж байна:', url);

    const dataUrl = await QRCode.toDataURL(url, {
      width: 240,
      margin: 2,
      color: { dark: '#ffffff', light: '#16213e' },
    });

    console.log('[QR] Амжилттай үүсгэлээ');

    // QR скан хийгдэх хүртэл polling хийнэ (3 минут)
    const axios = require('axios');
    let attempts = 0;
    const poll = setInterval(async () => {
      attempts++;
      if (attempts > 60) { clearInterval(poll); return; }
      try {
        const { data } = await axios.get(
          `${apiService.SERVER_URL}/auth/poll/${sessionId}`,
          { timeout: 2000 }
        );
        if (data.token) {
          clearInterval(poll);
          authService.saveToken(data.token);
          mainWindow?.webContents.send('auth:success', authService.getUser());
          console.log('[QR] Нэвтэрлээ!');
        }
      } catch {}
    }, 3000);

    return { dataUrl, sessionId };
  } catch (err) {
    console.error('[QR] Алдаа:', err.message, err.stack);
    throw err;
  }
});

// Axios алдааны мессежийг ойлгомжтой болгох helper
function apiError(err) {
  const msg = err.response?.data?.error || err.response?.data?.message || err.message;
  return new Error(msg);
}

// Имэйл бүртгэл
ipcMain.handle('auth:register', async (_, { username, email, password }) => {
  const axios = require('axios');
  try {
    const { data } = await axios.post(`${apiService.SERVER_URL}/auth/register`, { username, email, password });
    if (data.token) authService.saveToken(data.token);
    return data;
  } catch (err) { throw apiError(err); }
});

// Имэйл нэвтрэх
ipcMain.handle('auth:emailLogin', async (_, { email, password }) => {
  const axios = require('axios');
  try {
    const { data } = await axios.post(`${apiService.SERVER_URL}/auth/login`, { email, password });
    if (data.token) authService.saveToken(data.token);
    return data;
  } catch (err) { throw apiError(err); }
});

// Discord холбох (одоо байгаа хэрэглэгчтэй)
ipcMain.handle('auth:linkDiscord', () => {
  const user = authService.getUser();
  if (!user) return;
  const authWin = new BrowserWindow({
    width: 520, height: 700, title: 'Discord холбох',
    parent: mainWindow, modal: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  authWin.loadURL(`${apiService.SERVER_URL}/auth/discord?link=${user.id}`);
  const handleRedirect = (url) => {
    if (url.startsWith('wc3platform://')) {
      authWin.close();
      handleDeepLink(url);
      return true;
    }
    return false;
  };
  authWin.webContents.on('will-redirect', (e, url) => { if (handleRedirect(url)) e.preventDefault(); });
  authWin.webContents.on('will-navigate',  (e, url) => { if (handleRedirect(url)) e.preventDefault(); });
});

ipcMain.handle('auth:changePassword', async (_, { oldPassword, newPassword }) => {
  const axios = require('axios');
  const token = authService.getToken();
  if (!token) throw new Error('Нэвтрэх хугацаа дууссан');
  try {
    const { data } = await axios.put(
      `${apiService.SERVER_URL}/auth/password`,
      { oldPassword, newPassword },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    return data;
  } catch (err) { throw apiError(err); }
});

// Update суулгаж restart хийх
ipcMain.handle('update:install', () => {
  // isSilent=true: NSIS installer далдуур ажиллана
  // isForceRunAfter=true: суулгасны дараа апп дахин нээнэ
  autoUpdater.quitAndInstall(true, true);
});

// App хувилбар буцаах
ipcMain.handle('update:version', () => app.getVersion());

// Гараар шинэчлэл шалгах
ipcMain.handle('update:check', async () => {
  if (!app.isPackaged) return { error: 'dev' };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { version: result?.updateInfo?.version || null };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('auth:logout', () => {
  authService.clearToken();
  replayService.stopWatcher();
  zerotierService.disconnect();
  return true;
});

ipcMain.handle('auth:getUser',  () => authService.getUser());
ipcMain.handle('auth:getToken', () => authService.getToken());

// Өрөөнүүд
ipcMain.handle('rooms:list',       async () => apiService.getRooms());
ipcMain.handle('rooms:quickmatch', async (_, game_type) => {
  try { return await apiService.quickMatch(game_type); } catch (err) { throw apiError(err); }
});
ipcMain.handle('rooms:mine', async () => {
  try { return await apiService.getMyRoom(); } catch { return null; }
});

ipcMain.handle('rooms:create', async (event, { name, max_players, game_type, password }) => {
  let room;
  try {
    room = await apiService.createRoom({ name, max_players, game_type, password });
  } catch (err) { throw apiError(err); }
  // ZeroTier — server-аас автоматаар үүссэн network ID ашиглана
  try {
    if (room?.zerotier_network_id) {
      await zerotierService.joinNetwork(room.zerotier_network_id);
    }
  } catch {}
  try { replayService.startWatcher(room.id); } catch {}
  return room;
});

ipcMain.handle('rooms:join', async (event, roomId, password) => {
  try {
    const result = await apiService.joinRoom(roomId, password);
    if (result?.room?.zerotier_network_id) {
      zerotierService.joinNetwork(result.room.zerotier_network_id).catch(() => {});
    }
    try { replayService.startWatcher(roomId); } catch {}
    return result;
  } catch (err) { throw apiError(err); }
});

ipcMain.handle('rooms:start', async (event, roomId) => {
  try { return await apiService.startRoom(roomId); } catch (err) { throw apiError(err); }
});

ipcMain.handle('rooms:close', async (event, roomId) => {
  try { return await apiService.closeRoom(roomId); } catch (err) { throw apiError(err); }
});

ipcMain.handle('rooms:kick', async (event, roomId, targetUserId) => {
  try { return await apiService.kickPlayer(roomId, targetUserId); } catch (err) { throw apiError(err); }
});

ipcMain.handle('rooms:leave', async (event, roomId) => {
  const result = await apiService.leaveRoom(roomId);
  zerotierService.disconnect();
  replayService.stopWatcher();
  return result;
});

// Статистик
ipcMain.handle('stats:player', async (_, discordId) => {
  return apiService.getPlayerStats(discordId);
});
ipcMain.handle('stats:playerById', async (_, userId) => {
  return apiService.getPlayerStatsById(userId);
});
ipcMain.handle('stats:history', async (_, userId, page) => {
  return apiService.getGameHistory(userId, page);
});
ipcMain.handle('stats:ranking', async (_, { sort, page } = {}) => {
  return apiService.getRanking({ sort, page });
});

// Auth utilities
ipcMain.handle('auth:forgotPassword', async (_, email) => {
  try { return await apiService.forgotPassword(email); } catch (err) { throw apiError(err); }
});
ipcMain.handle('auth:resetPassword', async (_, token, newPassword) => {
  try { return await apiService.resetPassword(token, newPassword); } catch (err) { throw apiError(err); }
});
ipcMain.handle('auth:changeUsername', async (_, username) => {
  const axios = require('axios');
  const token = authService.getToken();
  if (!token) throw new Error('Нэвтэрх хугацаа дууссан');
  try {
    const { data } = await axios.put(
      `${apiService.SERVER_URL}/auth/username`,
      { username },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (data.token) authService.saveToken(data.token);
    return data;
  } catch (err) { throw apiError(err); }
});
ipcMain.handle('auth:unlinkDiscord', async () => {
  try { return await apiService.unlinkDiscord(); } catch (err) { throw apiError(err); }
});

// Replay watcher — тоглоом дуусахад renderer руу мэдэгдэх
replayService.onResult((data) => {
  mainWindow?.webContents.send('game:result', data);
});

// ── Тохируулга (settings.json in userData) ────────────────
function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(getSettingsPath(), 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(data) {
  const current = readSettings();
  fs.writeFileSync(getSettingsPath(), JSON.stringify({ ...current, ...data }, null, 2));
}

// Хуучин wc3Path-г games жагсаалт руу шилжүүлэх helper
function migrateSettings(s) {
  if (!s.games && s.wc3Path) {
    s.games = [{ id: 'legacy', name: 'Warcraft 3', path: s.wc3Path }];
  }
  if (!s.games) s.games = [];
  return s;
}

ipcMain.handle('settings:get', () => {
  const s = readSettings();
  return migrateSettings(s);
});

// Тоглоомын exe файл сонгох (нэр + зам буцаана, хадгалдаггүй)
ipcMain.handle('settings:selectGameExe', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Тоглоомын exe файл сонгох',
    filters: [{ name: 'Executable', extensions: ['exe'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const suggestedName = path.basename(filePath, path.extname(filePath));
  return { path: filePath, suggestedName };
});

// ZeroTier Network ID хадгалах
ipcMain.handle('settings:setZerotierNetwork', (_, networkId) => {
  writeSettings({ zerotierNetworkId: networkId || '' });
  return true;
});

// Тоглоом нэмэх
ipcMain.handle('settings:addGame', async (_, { name, path: exePath }) => {
  try {
    const s = migrateSettings(readSettings());
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    s.games.push({ id, name: String(name).trim(), path: String(exePath) });
    writeSettings({ games: s.games });
    return s.games;
  } catch (err) {
    console.error('[settings:addGame]', err);
    throw new Error('Тохируулга хадгалахад алдаа гарлаа: ' + err.message);
  }
});

// Тоглоом устгах
ipcMain.handle('settings:removeGame', async (_, id) => {
  const s = migrateSettings(readSettings());
  const games = s.games.filter(g => g.id !== id);
  writeSettings({ games });
  return games;
});

// Өрөөний шинэ цонх нээх
ipcMain.handle('room:openWindow', (event, roomData) => {
  if (roomWindow && !roomWindow.isDestroyed()) {
    roomWindow.focus();
    return;
  }
  roomWindow = new BrowserWindow({
    width: 920,
    height: 660,
    minWidth: 720,
    minHeight: 520,
    title: `${roomData.name} — Mongolian Warcraft Gaming Platform`,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#0d0d1a',
  });
  roomWindow.loadFile('src/renderer/index.html', {
    query: {
      mode: 'room',
      roomId:   String(roomData.id),
      roomName: roomData.name,
      gameType: roomData.gameType,
      isHost:   roomData.isHost ? '1' : '0',
      hostId:   String(roomData.hostId || ''),
    },
  });
  roomWindow.on('closed', () => {
    roomWindow = null;
    // Үндсэн цонхонд өрөөний жагсаалт шинэчлэх мэдэгдэл
    mainWindow?.webContents.send('room:window-closed');
  });
});

// ── Профайл зураг оруулах ──────────────────────────────────
ipcMain.handle('auth:uploadAvatar', async () => {
  const axios = require('axios');
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Профайл зураг сонгох',
    filters: [{ name: 'Зураг', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
    properties: ['openFile'],
  });
  if (result.canceled || !result.filePaths[0]) return null;

  const filePath = result.filePaths[0];
  const stats = fs.statSync(filePath);
  if (stats.size > 2 * 1024 * 1024) throw new Error('Зургийн хэмжээ 2MB-аас их байж болохгүй');

  const fileData = fs.readFileSync(filePath);
  const ext  = path.extname(filePath).toLowerCase().replace('.', '');
  const mime = (ext === 'jpg' || ext === 'jpeg') ? 'image/jpeg'
             : ext === 'png'  ? 'image/png'
             : ext === 'gif'  ? 'image/gif'
             : ext === 'webp' ? 'image/webp'
             : 'image/jpeg';
  const base64 = `data:${mime};base64,${fileData.toString('base64')}`;

  const token = authService.getToken();
  if (!token) throw new Error('Нэвтрэх хугацаа дууссан. Гарч дахин нэвтэрнэ үү.');
  try {
    const { data } = await axios.put(
      `${apiService.SERVER_URL}/auth/avatar`,
      { avatar_url: base64 },
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (data.token) authService.saveToken(data.token);
    return { avatar_url: base64 };
  } catch (err) { throw apiError(err); }
});

// ── Нийгмийн функцүүд (friends / block) ───────────────────
ipcMain.handle('social:friends',       async () => apiService.getFriends());
ipcMain.handle('social:pending',       async () => apiService.getPendingRequests());
ipcMain.handle('social:friendRequest', async (_, toUserId) => {
  try { return await apiService.sendFriendRequest(toUserId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:friendAccept',  async (_, fromUserId) => {
  try { return await apiService.acceptFriendRequest(fromUserId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:friendDecline', async (_, fromUserId) => {
  try { return await apiService.declineFriendRequest(fromUserId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:friendRemove',  async (_, friendId) => {
  try { return await apiService.removeFriend(friendId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:block',         async (_, targetUserId) => {
  try { return await apiService.blockUser(targetUserId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:unblock',       async (_, targetUserId) => {
  try { return await apiService.unblockUser(targetUserId); } catch (err) { throw apiError(err); }
});
ipcMain.handle('social:blocked',       async () => apiService.getBlockedUsers());
ipcMain.handle('social:search',        async (_, query) => {
  try { return await apiService.searchUsers(query); } catch { return []; }
});

// DM түүх & уншаагүй тоо
ipcMain.handle('social:dmHistory', async (_, userId) => {
  try { return await apiService.getDMHistory(userId); } catch { return []; }
});
ipcMain.handle('social:dmHistory:before', async (_, userId, beforeId) => {
  try { return await apiService.getDMHistory(userId, beforeId); } catch { return []; }
});
ipcMain.handle('social:unread', async () => {
  try { return await apiService.getUnreadCount(); } catch { return {}; }
});
ipcMain.handle('social:markRead', async (_, fromUserId) => {
  try { return await apiService.markDMRead(fromUserId); } catch { return { ok: false }; }
});

// Тоглоом эхлүүлэх (gameType нэрээр тохирох exe хайна)
ipcMain.handle('game:launch', (_, gameType) => {
  const s = migrateSettings(readSettings());
  const games = s.games;
  if (!games.length) throw new Error('Тоглоом тохируулагдаагүй байна (Тохируулга таб)');

  // Тоглоомын нэрийг тохируулах (тохирох нэр, эсвэл эхний тоглоом)
  const game = games.find(g => g.name === gameType) || games[0];
  if (!fs.existsSync(game.path)) {
    throw new Error(`"${game.name}" файл олдсонгүй: ${game.path}`);
  }
  const proc = spawn(game.path, [], { detached: true, stdio: 'ignore' });
  proc.unref();
  return true;
});
