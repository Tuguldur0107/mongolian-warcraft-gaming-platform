const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ZeroTier суулгалтын боломжит замууд (32-bit болон 64-bit)
const ZT_PATHS = [
  'C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe',
  'C:\\Program Files\\ZeroTier\\One\\zerotier-one_x64.exe',
];

let _ztCmd = null;
let currentNetworkId = null;

function getZtCmd() {
  if (_ztCmd) return _ztCmd;
  for (const p of ZT_PATHS) {
    if (fs.existsSync(p)) {
      _ztCmd = `"${p}" -q`;
      return _ztCmd;
    }
  }
  return null;
}

function isInstalled() {
  return ZT_PATHS.some(p => fs.existsSync(p));
}

function isRunning() {
  const cmd = getZtCmd();
  if (!cmd) return false;
  try {
    execSync(`${cmd} info`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════
// Автомат суулгалт & тохиргоо
// ═══════════════════════════════════════════════════════════

function findMsiPath() {
  // Production: extraResources-д байгаа
  const prodPath = path.join(process.resourcesPath, 'ZeroTierOne.msi');
  if (fs.existsSync(prodPath)) return prodPath;
  // Dev mode: client/resources/ хавтаст байгаа
  const devPath = path.join(__dirname, '..', '..', 'resources', 'ZeroTierOne.msi');
  if (fs.existsSync(devPath)) return devPath;
  return null;
}

async function ensureInstalled() {
  if (isInstalled()) return true;

  const msiPath = findMsiPath();
  if (!msiPath) {
    console.error('[ZeroTier] MSI файл олдсонгүй');
    return false;
  }

  // C:\ProgramData руу хуулах — elevated процесс хандах боломжтой газар
  const installDir = 'C:\\ProgramData\\zt-install';
  if (!fs.existsSync(installDir)) fs.mkdirSync(installDir, { recursive: true });
  const targetMsi = path.join(installDir, 'ZeroTierOne.msi');
  fs.copyFileSync(msiPath, targetMsi);

  console.log('[ZeroTier] Суулгаж байна... MSI:', targetMsi);
  const logFile = path.join(installDir, 'install.log');
  try {
    // .cmd batch файл — /passive горимд progress bar харуулна
    const cmdScript = path.join(installDir, 'install.cmd');
    fs.writeFileSync(cmdScript, [
      `msiexec /i "${targetMsi}" /passive /norestart /L*V "${logFile}"`,
      `if %ERRORLEVEL% NEQ 0 (`,
      `  echo INSTALL FAILED: %ERRORLEVEL% >> "${logFile}"`,
      `)`,
      '',
    ].join('\r\n'), 'utf8');
    // Batch файлыг admin эрхээр ажиллуулах
    execSync(
      `powershell -Command "Start-Process cmd.exe -ArgumentList '/c','${cmdScript.replace(/'/g, "''")}' -Verb RunAs -Wait"`,
      { stdio: 'pipe', timeout: 180000 }
    );
  } catch (e) {
    console.error('[ZeroTier] Суулгалт алдаа:', e.message);
    // Log файл уншиж дебаг мэдээлэл авах
    try {
      const log = fs.readFileSync(logFile, 'utf16le');
      const last = log.split('\n').slice(-20).join('\n');
      console.error('[ZeroTier] Install log (tail):', last);
    } catch {}
    return false;
  }

  // Суулгалтын дараа service эхлэхийг хүлээх
  await new Promise(r => setTimeout(r, 8000));
  _ztCmd = null; // cache цэвэрлэх

  // Log файл шалгах (debug зориулалтаар хэвлэх)
  try {
    const log = fs.readFileSync(logFile, 'utf16le');
    const last = log.split('\n').slice(-10).join('\n');
    console.log('[ZeroTier] Install log (tail):', last);
  } catch {}

  // Staging файлууд цэвэрлэх
  try { fs.rmSync(installDir, { recursive: true, force: true }); } catch { /* ignore */ }

  const ok = isInstalled();
  console.log('[ZeroTier] Суулгалт:', ok ? 'амжилттай' : 'амжилтгүй');
  return ok;
}

async function ensureRunning() {
  if (isRunning()) return true;

  console.log('[ZeroTier] Сервис эхлүүлж байна...');
  try {
    // Эхлээд admin-гүйгээр оролдох
    execSync('net start ZeroTierOneService', { stdio: 'pipe', timeout: 15000 });
  } catch {
    try {
      // Admin шаардлагатай бол elevation ашиглах
      execSync(
        `powershell -Command "Start-Process net -ArgumentList 'start','ZeroTierOneService' -Verb RunAs -Wait"`,
        { stdio: 'pipe', timeout: 30000 }
      );
    } catch (e) {
      console.error('[ZeroTier] Сервис эхлүүлж чадсангүй:', e.message);
      return false;
    }
  }

  await new Promise(r => setTimeout(r, 3000));
  const ok = isRunning();
  console.log('[ZeroTier] Сервис:', ok ? 'ажиллаж байна' : 'эхлүүлж чадсангүй');
  return ok;
}

async function autoSetup(networkId) {
  if (!networkId) return { ok: false, error: 'no-network-id' };

  // 1. Суулгалт шалгах
  const installed = await ensureInstalled();
  if (!installed) return { ok: false, error: 'install-failed' };

  // 2. Сервис шалгах
  const running = await ensureRunning();
  if (!running) return { ok: false, error: 'service-failed' };

  // 3. Network-д нэгдэх
  try {
    await joinNetwork(networkId);
  } catch (e) {
    console.error('[ZeroTier] join алдаа:', e.message);
    return { ok: false, error: 'join-failed' };
  }

  // 4. IP хаяг хүлээх (15 сек хүртэл)
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const ip = getMyIp(networkId);
    if (ip) {
      console.log(`[ZeroTier] Бэлэн! IP: ${ip}`);
      return { ok: true, ip };
    }
  }

  console.log('[ZeroTier] IP хаяг олдсонгүй, гэхдээ холбогдсон');
  return { ok: true, ip: null };
}

// ═══════════════════════════════════════════════════════════

async function joinNetwork(networkId) {
  if (!networkId) return false;

  const cmd = getZtCmd();
  if (!cmd) {
    console.warn('[ZeroTier] Суулгаагүй байна');
    return false;
  }
  if (!isRunning()) {
    console.warn('[ZeroTier] Сервис ажиллаагүй байна');
    return false;
  }

  return new Promise((resolve, reject) => {
    exec(`${cmd} join ${networkId}`, (err) => {
      if (err) {
        console.error('[ZeroTier] join алдаа:', err.message);
        return reject(err);
      }
      currentNetworkId = networkId;
      console.log(`[ZeroTier] ${networkId}-д нэгдлээ`);
      resolve(true);
    });
  });
}

// ZeroTier IP хаяг олох (listnetworks output-аас парсдах)
// Output формат: <nwid> <name> <mac> <status> <type> <dev> <ips>
function getMyIp(networkId) {
  const nid = networkId || currentNetworkId;
  if (!nid) return null;
  const cmd = getZtCmd();
  if (!cmd) return null;
  try {
    const out = execSync(`${cmd} listnetworks`, { stdio: 'pipe', encoding: 'utf8' });
    const lines = out.trim().split('\n');
    for (const line of lines) {
      if (!line.includes(nid)) continue;
      // IP хаяг нь мөрний сүүлд байна: "10.147.20.x/24" гэсэн формат
      const ipMatch = line.match(/(\d+\.\d+\.\d+\.\d+)\/\d+/);
      if (ipMatch) return ipMatch[1];
    }
  } catch (e) {
    console.error('[ZeroTier] listnetworks алдаа:', e.message);
  }
  return null;
}

// ZeroTier-ийн бүрэн статус буцаах
function getStatus(networkId) {
  const installed = isInstalled();
  const running   = installed && isRunning();
  const nid       = networkId || currentNetworkId;
  const ip        = running && nid ? getMyIp(nid) : null;
  return { installed, running, connected: !!ip, networkId: nid || null, ip };
}

function disconnect() {
  if (!currentNetworkId) return;
  const cmd = getZtCmd();
  if (!cmd) return;
  try {
    if (isRunning()) {
      execSync(`${cmd} leave ${currentNetworkId}`, { stdio: 'pipe' });
      console.log(`[ZeroTier] ${currentNetworkId}-аас гарлаа`);
    }
  } catch (err) {
    console.error('[ZeroTier] leave алдаа:', err.message);
  } finally {
    currentNetworkId = null;
  }
}

module.exports = {
  joinNetwork, disconnect,
  isInstalled, isRunning, getMyIp, getStatus,
  ensureInstalled, ensureRunning, autoSetup,
};
