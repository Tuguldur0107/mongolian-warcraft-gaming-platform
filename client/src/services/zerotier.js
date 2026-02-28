const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ZeroTier суулгалтын боломжит замууд (шинэ 1.16+ болон хуучин хувилбар)
const ZT_PATHS = [
  'C:\\ProgramData\\ZeroTier\\One\\zerotier-one_x64.exe',
  'C:\\Program Files (x86)\\ZeroTier\\One\\zerotier-one_x64.exe',
  'C:\\Program Files\\ZeroTier\\One\\zerotier-one_x64.exe',
];

let _ztCmd = null;
let currentNetworkId = null;

function getZtCmd() {
  if (_ztCmd) return _ztCmd;
  for (const p of ZT_PATHS) {
    if (fs.existsSync(p)) {
      // ZeroTier 1.16+ нь authtoken.secret-д admin шаарддаг
      // User-level token ашиглах (AppData\Local\ZeroTier)
      const userToken = path.join(os.homedir(), 'AppData', 'Local', 'ZeroTier', 'authtoken.secret');
      if (fs.existsSync(userToken)) {
        const token = fs.readFileSync(userToken, 'utf8').trim();
        _ztCmd = `"${p}" -q -T${token}`;
      } else {
        _ztCmd = `"${p}" -q`;
      }
      return _ztCmd;
    }
  }
  return null;
}

function isInstalled() {
  return ZT_PATHS.some(p => fs.existsSync(p));
}

// ZeroTier node ID авах (authorize-д хэрэгтэй)
function getNodeId() {
  const cmd = getZtCmd();
  if (!cmd) return null;
  try {
    const out = execSync(`${cmd} info`, { stdio: 'pipe', encoding: 'utf8' });
    // Output: "200 info <nodeId> <version> <status>"
    const match = out.match(/200\s+info\s+([0-9a-f]+)/);
    return match ? match[1] : null;
  } catch { return null; }
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

  // MSI файл бодитоор хуулагдсан эсэх шалгах
  if (!fs.existsSync(targetMsi)) {
    console.error('[ZeroTier] MSI хуулагдсангүй:', targetMsi);
    return false;
  }
  const msiSize = fs.statSync(targetMsi).size;
  console.log(`[ZeroTier] MSI хуулагдлаа: ${targetMsi} (${msiSize} bytes)`);

  const logFile = path.join(installDir, 'install.log');
  try {
    // PS1 скрипт файл — msiexec-г шууд elevate хийнэ (CMD завсаргүй)
    const psScript = path.join(installDir, 'install.ps1');
    fs.writeFileSync(psScript, [
      `$msi = '${targetMsi}'`,
      `$log = '${logFile}'`,
      `$p = Start-Process msiexec.exe -ArgumentList "/i $msi /passive /norestart /L*V $log" -Verb RunAs -Wait -PassThru`,
      `exit $p.ExitCode`,
    ].join('\r\n'), 'utf8');

    console.log('[ZeroTier] Суулгаж байна...');
    execSync(
      `powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "${psScript}"`,
      { stdio: 'pipe', timeout: 180000 }
    );
  } catch (e) {
    console.error('[ZeroTier] Суулгалт алдаа:', e.message);
  }

  // Log файл уншиж дебаг мэдээлэл авах
  try {
    const log = fs.readFileSync(logFile, 'utf16le');
    const last = log.split('\n').slice(-15).join('\n');
    console.log('[ZeroTier] Install log (tail):', last);
  } catch (e) {
    console.log('[ZeroTier] Log файл олдсонгүй:', e.message);
  }

  // Суулгалтын дараа service эхлэхийг хүлээх
  await new Promise(r => setTimeout(r, 8000));
  _ztCmd = null; // cache цэвэрлэх

  const ok = isInstalled();
  console.log('[ZeroTier] Суулгалт:', ok ? 'амжилттай' : 'амжилтгүй');

  // Амжилттай бол staging цэвэрлэх, амжилтгүй бол log хадгалах
  if (ok) {
    try { fs.rmSync(installDir, { recursive: true, force: true }); } catch {}
  } else {
    console.log('[ZeroTier] Log файл хадгалагдлаа:', logFile);
  }
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
        `powershell -NoProfile -WindowStyle Hidden -Command "Start-Process net -ArgumentList 'start','ZeroTierOneService' -Verb RunAs -Wait -WindowStyle Hidden"`,
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

async function autoSetup(networkId, gamePaths) {
  if (!networkId) return { ok: false, error: 'no-network-id' };

  // 1. Суулгалт шалгах / суулгах
  const alreadyInstalled = isInstalled();
  if (alreadyInstalled) {
    console.log('[ZeroTier] Аль хэдийн суулгасан байна, тохиргоо хийж байна...');
  } else {
    console.log('[ZeroTier] Суулгаагүй, суулгаж байна...');
    const installed = await ensureInstalled();
    if (!installed) return { ok: false, error: 'install-failed' };
  }

  // 2. Сервис шалгах / эхлүүлэх
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
  let myIp = null;
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    myIp = getMyIp(networkId);
    if (myIp) break;
  }

  // 5. ZeroTier adapter priority + Firewall rules (НЭГ UAC промпт)
  const netSetup = elevatedNetworkSetup(gamePaths);

  if (myIp) {
    console.log(`[ZeroTier] Бэлэн! IP: ${myIp}`);
    return { ok: true, ip: myIp, metricSet: netSetup.metric, firewallSet: netSetup.firewall };
  }

  console.log('[ZeroTier] IP хаяг олдсонгүй, гэхдээ холбогдсон');
  return { ok: true, ip: null, metricSet: netSetup.metric, firewallSet: netSetup.firewall };
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

// Firewall rule аль хэдийн байгаа эсэх шалгах (admin шаардлагагүй)
function isFirewallReady() {
  try {
    const out = execSync('netsh advfirewall firewall show rule name="WC3 LAN UDP In"',
      { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
    return out.includes('WC3 LAN UDP In');
  } catch { return false; }
}

// ZeroTier adapter metric шалгах (admin шаардлагагүй)
function isMetricReady() {
  try {
    const out = execSync(
      'powershell -NoProfile -WindowStyle Hidden -Command "Get-NetAdapter | Where-Object { $_.InterfaceDescription -like \'*ZeroTier*\' } | Get-NetIPInterface -AddressFamily IPv4 | Select-Object -ExpandProperty InterfaceMetric"',
      { stdio: 'pipe', encoding: 'utf8', timeout: 5000 });
    const metric = parseInt(out.trim(), 10);
    return metric <= 5; // metric 1-5 бол OK
  } catch { return false; }
}

// ZeroTier adapter priority + Windows Firewall + Game/ZT exe rules
// gamePaths: тоглоомын exe файлуудын path-ын массив (optional)
// force: true бол шалгалтгүйгээр шууд тохируулна
function elevatedNetworkSetup(gamePaths, force) {
  const firewallOk = !force && isFirewallReady();
  const metricOk = !force && isMetricReady();

  if (firewallOk && metricOk && (!gamePaths || gamePaths.length === 0)) {
    console.log('[ZeroTier] Network setup аль хэдийн хийгдсэн (UAC шаардлагагүй)');
    return { metric: true, firewall: true };
  }

  console.log(`[ZeroTier] Setup шаардлагатай: metric=${metricOk ? 'OK' : 'NEED'}, firewall=${firewallOk ? 'OK' : 'NEED'}, games=${(gamePaths || []).length}`);

  try {
    const scriptDir = path.join(os.tmpdir(), 'wc3-zt-setup');
    if (!fs.existsSync(scriptDir)) fs.mkdirSync(scriptDir, { recursive: true });
    const scriptPath = path.join(scriptDir, 'network-setup.ps1');

    const lines = ['# MongolWC3 — ZeroTier + Firewall бүрэн тохиргоо', ''];

    if (!metricOk) {
      lines.push(
        '# ZeroTier adapter metric=1 (хамгийн өндөр priority)',
        '$zt = Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*ZeroTier*" }',
        'if ($zt) {',
        '  Set-NetIPInterface -InterfaceIndex $zt.ifIndex -InterfaceMetric 1 -ErrorAction SilentlyContinue',
        '}',
        '',
      );
    }

    // ZeroTier network profile → Private (Public бол firewall хатуу)
    lines.push(
      '# ZeroTier network profile → Private',
      '$ztProfile = Get-NetConnectionProfile | Where-Object { $_.InterfaceAlias -like "*ZeroTier*" }',
      'if ($ztProfile -and $ztProfile.NetworkCategory -ne "Private") {',
      '  Set-NetConnectionProfile -InterfaceIndex $ztProfile.InterfaceIndex -NetworkCategory Private -ErrorAction SilentlyContinue',
      '}',
      '',
    );

    if (!firewallOk || force) {
      // Port 6112 rules
      lines.push(
        '# Firewall: Port 6112 (WC3 LAN)',
        'netsh advfirewall firewall delete rule name="WC3 LAN UDP In" >$null 2>&1',
        'netsh advfirewall firewall delete rule name="WC3 LAN UDP Out" >$null 2>&1',
        'netsh advfirewall firewall delete rule name="WC3 LAN TCP In" >$null 2>&1',
        'netsh advfirewall firewall delete rule name="WC3 LAN TCP Out" >$null 2>&1',
        'netsh advfirewall firewall add rule name="WC3 LAN UDP In" dir=in action=allow protocol=UDP localport=6112 profile=any | Out-Null',
        'netsh advfirewall firewall add rule name="WC3 LAN UDP Out" dir=out action=allow protocol=UDP localport=6112 profile=any | Out-Null',
        'netsh advfirewall firewall add rule name="WC3 LAN TCP In" dir=in action=allow protocol=TCP localport=6112 profile=any | Out-Null',
        'netsh advfirewall firewall add rule name="WC3 LAN TCP Out" dir=out action=allow protocol=TCP localport=6112 profile=any | Out-Null',
        '',
      );

      // ZeroTier exe firewall rules
      lines.push('# Firewall: ZeroTier exe');
      for (const ztPath of ZT_PATHS) {
        if (fs.existsSync(ztPath)) {
          const safePath = ztPath.replace(/'/g, "''");
          lines.push(
            `netsh advfirewall firewall delete rule name="ZeroTier One" program="${safePath}" >$null 2>&1`,
            `netsh advfirewall firewall add rule name="ZeroTier One" dir=in action=allow program="${safePath}" profile=any | Out-Null`,
            `netsh advfirewall firewall add rule name="ZeroTier One" dir=out action=allow program="${safePath}" profile=any | Out-Null`,
          );
        }
      }
      lines.push('');
    }

    // Game exe firewall rules
    if (gamePaths && gamePaths.length > 0) {
      lines.push('# Firewall: Тоглоомын exe файлууд');
      for (const gamePath of gamePaths) {
        if (fs.existsSync(gamePath)) {
          const safePath = gamePath.replace(/'/g, "''");
          const gameName = path.basename(gamePath, path.extname(gamePath));
          lines.push(
            `netsh advfirewall firewall delete rule name="MongolWC3 Game - ${gameName}" >$null 2>&1`,
            `netsh advfirewall firewall add rule name="MongolWC3 Game - ${gameName}" dir=in action=allow program="${safePath}" profile=any | Out-Null`,
            `netsh advfirewall firewall add rule name="MongolWC3 Game - ${gameName}" dir=out action=allow program="${safePath}" profile=any | Out-Null`,
          );
        }
      }
    }

    fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');

    execSync(
      `powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-File','${scriptPath}' -Verb RunAs -Wait -WindowStyle Hidden"`,
      { stdio: 'pipe', timeout: 20000 }
    );

    console.log('[ZeroTier] Network setup хийгдлээ (metric + firewall + games)');
    try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch {}
    return { metric: true, firewall: true };
  } catch (e) {
    console.warn('[ZeroTier] Elevated network setup алдаа:', e.message);
    return { metric: false, firewall: false };
  }
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
  isInstalled, isRunning, getMyIp, getNodeId, getStatus,
  ensureInstalled, ensureRunning, autoSetup, elevatedNetworkSetup,
};
