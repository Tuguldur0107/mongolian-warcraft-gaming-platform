const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const TOKEN_PATH = path.join(app.getPath('userData'), 'token.json');

function saveToken(token) {
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
  fs.writeFileSync(TOKEN_PATH, JSON.stringify({ token, user: payload }), 'utf-8');
}

function getToken() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    // Token хэт том бол (avatar_url хадгалагдсан хуучин token) устга
    if (data.token.length > 8000) {
      clearToken();
      return null;
    }
    // Token хугацаа шалгах
    const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
    if (payload.exp * 1000 < Date.now()) {
      clearToken();
      return null;
    }
    return data.token;
  } catch {
    return null;
  }
}

function getUser() {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'));
    return data.user || null;
  } catch {
    return null;
  }
}

function clearToken() {
  try {
    fs.unlinkSync(TOKEN_PATH);
  } catch {}
}

module.exports = { saveToken, getToken, getUser, clearToken };
