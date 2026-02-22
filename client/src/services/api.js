const axios = require('axios');
const authService = require('./auth');

const SERVER_URL = process.env.SERVER_URL || 'https://mongolian-warcraft-gaming-platform-production.up.railway.app';

function getClient() {
  const token = authService.getToken();
  return axios.create({
    baseURL: SERVER_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}

async function getRooms() {
  const { data } = await getClient().get('/rooms');
  return data;
}

async function getMyRoom() {
  const { data } = await getClient().get('/rooms/mine');
  return data;
}

async function createRoom({ name, max_players, game_type, password }) {
  const { data } = await getClient().post('/rooms', { name, max_players, game_type, password });
  return data;
}

async function joinRoom(id, password) {
  const { data } = await getClient().post(`/rooms/${id}/join`, password ? { password } : {});
  return data;
}

async function startRoom(id) {
  const { data } = await getClient().post(`/rooms/${id}/start`);
  return data;
}

async function closeRoom(id) {
  const { data } = await getClient().delete(`/rooms/${id}`);
  return data;
}

async function kickPlayer(roomId, targetUserId) {
  const { data } = await getClient().post(`/rooms/${roomId}/kick/${targetUserId}`);
  return data;
}

async function leaveRoom(id) {
  const { data } = await getClient().post(`/rooms/${id}/leave`);
  return data;
}

async function updateRoomNetwork(roomId, networkId) {
  const { data } = await getClient().patch(`/rooms/${roomId}`, {
    zerotier_network_id: networkId,
  });
  return data;
}

async function getPlayerStats(discordId) {
  const { data } = await getClient().get(`/stats/player/${discordId}`);
  return data;
}

async function getRanking() {
  const { data } = await getClient().get('/stats/ranking');
  return data;
}

async function postGameResult(payload) {
  const { data } = await getClient().post('/stats/result', payload);
  return data;
}

// ── Нийгмийн функцүүд (friends / block) ───────────────────
async function getFriends() {
  const { data } = await getClient().get('/social/friends');
  return data;
}
async function getPendingRequests() {
  const { data } = await getClient().get('/social/pending');
  return data;
}
async function sendFriendRequest(toUserId) {
  const { data } = await getClient().post('/social/friend/request', { toUserId });
  return data;
}
async function acceptFriendRequest(fromUserId) {
  const { data } = await getClient().post('/social/friend/accept', { fromUserId });
  return data;
}
async function declineFriendRequest(fromUserId) {
  const { data } = await getClient().post('/social/friend/decline', { fromUserId });
  return data;
}
async function removeFriend(friendId) {
  const { data } = await getClient().post('/social/friend/remove', { friendId });
  return data;
}
async function blockUser(targetUserId) {
  const { data } = await getClient().post('/social/block', { targetUserId });
  return data;
}
async function unblockUser(targetUserId) {
  const { data } = await getClient().post('/social/unblock', { targetUserId });
  return data;
}
async function getBlockedUsers() {
  const { data } = await getClient().get('/social/blocked');
  return data;
}
async function updateAvatar(avatar_url) {
  const { data } = await getClient().put('/auth/avatar', { avatar_url });
  return data;
}

async function changePassword(oldPassword, newPassword) {
  const { data } = await getClient().put('/auth/password', { oldPassword, newPassword });
  return data;
}

async function searchUsers(query) {
  const { data } = await getClient().get('/social/search', { params: { q: query } });
  return data;
}

async function getDMHistory(userId, beforeId = null) {
  const params = beforeId ? { before: beforeId } : {};
  const { data } = await getClient().get(`/social/messages/${userId}`, { params });
  return data;
}

async function getUnreadCount() {
  const { data } = await getClient().get('/social/unread');
  return data;
}

async function markDMRead(fromUserId) {
  const { data } = await getClient().post('/social/messages/read', { fromUserId });
  return data;
}

module.exports = {
  SERVER_URL,
  changePassword,
  searchUsers,
  getDMHistory,
  getUnreadCount,
  markDMRead,
  getRooms,
  getMyRoom,
  createRoom,
  joinRoom,
  leaveRoom,
  startRoom,
  closeRoom,
  kickPlayer,
  updateRoomNetwork,
  getPlayerStats,
  getRanking,
  postGameResult,
  getFriends,
  getPendingRequests,
  sendFriendRequest,
  acceptFriendRequest,
  declineFriendRequest,
  removeFriend,
  blockUser,
  unblockUser,
  getBlockedUsers,
  updateAvatar,
};
