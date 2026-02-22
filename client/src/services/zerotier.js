const { execSync, exec } = require('child_process');
const path = require('path');

// ZeroTier CLI байрлал (Windows)
const ZT_CLI = 'C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe';
const ZT_CLI_CMD = '"C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe" -q';

let currentNetworkId = null;

// ZeroTier ажиллаж байгаа эсэх шалгах
function isRunning() {
  try {
    execSync(`${ZT_CLI_CMD} info`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// Шинэ виртуал сүлжээ үүсгэх (өрөө эзэн)
async function createNetwork(roomId) {
  // Жич: ZeroTier Central API-аар network үүсгэх боломжтой
  // Одоохондоо тоглогчид нийтлэг network ID ашиглана
  // Хожим ZeroTier Central API интеграц нэмнэ
  const networkId = generateNetworkId(roomId);
  await joinNetwork(networkId);
  return networkId;
}

// Виртуал сүлжээнд нэгдэх
async function joinNetwork(networkId) {
  if (!networkId) return;

  return new Promise((resolve, reject) => {
    if (!isRunning()) {
      console.warn('ZeroTier ажиллаагүй байна, суулгаж тохируулна уу');
      return resolve(false);
    }

    exec(`${ZT_CLI_CMD} join ${networkId}`, (err, stdout) => {
      if (err) {
        console.error('ZeroTier join алдаа:', err.message);
        return reject(err);
      }
      currentNetworkId = networkId;
      console.log(`ZeroTier network ${networkId}-д нэгдлээ`);
      resolve(true);
    });
  });
}

// Сүлжээнээс гарах
function disconnect() {
  if (!currentNetworkId) return;

  try {
    if (isRunning()) {
      execSync(`${ZT_CLI_CMD} leave ${currentNetworkId}`, { stdio: 'pipe' });
      console.log(`ZeroTier network ${currentNetworkId}-аас гарлаа`);
    }
  } catch (err) {
    console.error('ZeroTier leave алдаа:', err.message);
  } finally {
    currentNetworkId = null;
  }
}

// Room ID-аас тогтмол network ID үүсгэх (энгийн hash)
function generateNetworkId(roomId) {
  const clean = roomId.replace(/-/g, '').substring(0, 16);
  return clean.padEnd(16, '0');
}

module.exports = { createNetwork, joinNetwork, disconnect, isRunning };
