const chokidar = require('chokidar');
const path = require('path');
const os = require('os');
const W3GReplay = require('w3gjs');
const apiService = require('./api');

let watcher = null;
let currentRoomId = null;
let resultCallback = null;

// WC3 replays хавтас автоматаар олох
function getReplayPath() {
  if (process.env.WC3_REPLAYS_PATH) return process.env.WC3_REPLAYS_PATH;

  const username = os.userInfo().username;
  return path.join(
    'C:\\Users',
    username,
    'Documents',
    'Warcraft III',
    'Replays'
  );
}

// Replay watcher эхлүүлэх
function startWatcher(roomId) {
  stopWatcher();
  currentRoomId = roomId;

  const replayDir = getReplayPath();
  console.log(`Replay хавтас хянаж байна: ${replayDir}`);

  watcher = chokidar.watch(`${replayDir}/**/*.w3g`, {
    ignoreInitial: true,  // Байгаа файлуудыг үл хамрах
    awaitWriteFinish: {
      stabilityThreshold: 2000, // Файл бичигдэж дуусахыг хүлээх
      pollInterval: 500,
    },
  });

  watcher.on('add', async (filePath) => {
    console.log(`Шинэ replay олдлоо: ${filePath}`);
    await parseReplay(filePath);
  });

  watcher.on('error', (err) => {
    console.error('Replay watcher алдаа:', err);
  });
}

// Replay файл parse хийх
async function parseReplay(filePath) {
  try {
    const parser = new W3GReplay();
    const replay = await parser.parse(filePath);

    const duration = Math.round(replay.duration / 60000); // ms -> минут
    const players = replay.players.map((p) => ({
      name: p.name,
      team: p.teamid,
      discord_id: null, // Тоглогчдын discord_id-г lobby-аас match хийнэ (хожим)
    }));

    // Хожсон багийг тодорхойлох
    const winnerTeam = getWinnerTeam(replay);

    const result = {
      room_id: currentRoomId,
      winner_team: winnerTeam,
      duration_minutes: duration,
      replay_path: filePath,
      players,
    };

    console.log('Тоглоомын үр дүн:', result);

    // Серверт илгээх
    await apiService.postGameResult(result);

    // Renderer-т мэдэгдэх
    if (resultCallback) resultCallback(result);
  } catch (err) {
    console.error('Replay parse алдаа:', err.message);
  }
}

// Хожсон багийг тодорхойлох
function getWinnerTeam(replay) {
  // w3gjs-ийн leaveevents дотроос disconnect reason-ийг шалгах
  const leavers = replay.players.filter(
    (p) => p.leaving?.reason === 'disconnected'
  );

  if (leavers.length > 0) {
    const losingTeam = leavers[0].teamid;
    return losingTeam === 1 ? 2 : 1;
  }

  return 1; // Default
}

// Replay watcher зогсоох
function stopWatcher() {
  if (watcher) {
    watcher.close();
    watcher = null;
    currentRoomId = null;
    console.log('Replay watcher зогслоо');
  }
}

// Үр дүн гарахад дуудагдах callback тохируулах
function onResult(cb) {
  resultCallback = cb;
}

module.exports = { startWatcher, stopWatcher, onResult };
