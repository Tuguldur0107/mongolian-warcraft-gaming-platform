const { contextBridge, ipcRenderer } = require('electron');

// Renderer процесс руу аюулгүйгээр API-г нээх
contextBridge.exposeInMainWorld('api', {
  // Auth
  register:     (data) => ipcRenderer.invoke('auth:register', data),
  emailLogin:   (data) => ipcRenderer.invoke('auth:emailLogin', data),
  login:        () => ipcRenderer.invoke('auth:login'),
  linkDiscord:  () => ipcRenderer.invoke('auth:linkDiscord'),
  getQR:        () => ipcRenderer.invoke('auth:qr'),
  logout:       () => ipcRenderer.invoke('auth:logout'),
  getUser:      () => ipcRenderer.invoke('auth:getUser'),
  getToken:     () => ipcRenderer.invoke('auth:getToken'),
  onAuthSuccess:(cb) => ipcRenderer.on('auth:success', (_, user) => cb(user)),

  // Rooms
  getRooms:   ()               => ipcRenderer.invoke('rooms:list'),
  getMyRoom:  ()               => ipcRenderer.invoke('rooms:mine'),
  createRoom: (data)           => ipcRenderer.invoke('rooms:create', data),
  joinRoom:   (id, pass)       => ipcRenderer.invoke('rooms:join', id, pass),
  leaveRoom:  (id)             => ipcRenderer.invoke('rooms:leave', id),
  closeRoom:  (id)             => ipcRenderer.invoke('rooms:close', id),
  startRoom:  (id)             => ipcRenderer.invoke('rooms:start', id),
  kickPlayer: (roomId, userId) => ipcRenderer.invoke('rooms:kick', roomId, userId),

  // Stats
  getPlayerStats: (discordId) => ipcRenderer.invoke('stats:player', discordId),
  getRanking: () => ipcRenderer.invoke('stats:ranking'),

  // Тоглоом дуусах event
  onGameResult: (cb) => ipcRenderer.on('game:result', (_, data) => cb(data)),

  // Socket events (main → renderer)
  onRoomClosed: (cb) => ipcRenderer.on('room:closed', (_, d) => cb(d)),
  onRoomKicked: (cb) => ipcRenderer.on('room:kicked', (_, d) => cb(d)),

  // Тохируулга
  getSettings:    () => ipcRenderer.invoke('settings:get'),
  selectGameExe:  () => ipcRenderer.invoke('settings:selectGameExe'),
  addGame:        (data) => ipcRenderer.invoke('settings:addGame', data),
  removeGame:     (id)   => ipcRenderer.invoke('settings:removeGame', id),

  // Тоглоом эхлүүлэх
  launchGame: (gameType) => ipcRenderer.invoke('game:launch', gameType),

  // Өрөөний шинэ цонх
  openRoomWindow:    (data) => ipcRenderer.invoke('room:openWindow', data),
  onRoomWindowClosed:(cb)   => ipcRenderer.on('room:window-closed', cb),

  // Профайл зураг
  uploadAvatar: () => ipcRenderer.invoke('auth:uploadAvatar'),

  // Нууц үг солих
  changePassword: (oldPassword, newPassword) => ipcRenderer.invoke('auth:changePassword', { oldPassword, newPassword }),

  // Нийгмийн функцүүд (friends / block)
  getFriends:          ()             => ipcRenderer.invoke('social:friends'),
  getPendingRequests:  ()             => ipcRenderer.invoke('social:pending'),
  sendFriendRequest:   (toUserId)     => ipcRenderer.invoke('social:friendRequest', toUserId),
  acceptFriendRequest: (fromUserId)   => ipcRenderer.invoke('social:friendAccept', fromUserId),
  declineFriendRequest:(fromUserId)   => ipcRenderer.invoke('social:friendDecline', fromUserId),
  removeFriend:        (friendId)     => ipcRenderer.invoke('social:friendRemove', friendId),
  blockUser:           (targetUserId) => ipcRenderer.invoke('social:block', targetUserId),
  unblockUser:         (targetUserId) => ipcRenderer.invoke('social:unblock', targetUserId),
  getBlockedUsers:     ()             => ipcRenderer.invoke('social:blocked'),

  // DM түүх
  getDMHistory:  (userId)              => ipcRenderer.invoke('social:dmHistory', userId),
  getDMHistoryBefore: (userId, before) => ipcRenderer.invoke('social:dmHistory:before', userId, before),
  getUnreadCount: ()                   => ipcRenderer.invoke('social:unread'),
  markDMRead:    (fromUserId)          => ipcRenderer.invoke('social:markRead', fromUserId),
});
