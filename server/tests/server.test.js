const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const serverDir = path.resolve(__dirname, '..');
const serverIndexPath = path.join(serverDir, 'src', 'index.js');
const dbModulePath = path.join(serverDir, 'src', 'config', 'db.js');

async function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForServer(url, timeoutMs = 10000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await wait(250);
  }
  throw new Error(`Server did not start in time: ${url}`);
}

function clearServerModules() {
  const srcPrefix = path.join(serverDir, 'src');
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(srcPrefix)) delete require.cache[key];
  }
}

function installMockDb(mockDb) {
  require.cache[dbModulePath] = {
    id: dbModulePath,
    filename: dbModulePath,
    loaded: true,
    exports: mockDb,
  };
}

function makeAuthToken(user, secret = 'test-secret') {
  return jwt.sign(user, secret, { expiresIn: '1h' });
}

async function startServer(envOverrides = {}, options = {}) {
  const port = 4100 + Math.floor(Math.random() * 500);
  const previousEnv = {};
  const mergedEnv = {
    PORT: String(port),
    JWT_SECRET: 'test-secret',
    NODE_ENV: 'test',
    SKIP_DB_MIGRATIONS: 'true',
    DISCORD_CLIENT_ID: 'dummy-client',
    DISCORD_CLIENT_SECRET: 'dummy-secret',
    DISCORD_REDIRECT_URI: 'http://localhost/callback',
    ...envOverrides,
  };

  for (const [key, value] of Object.entries(mergedEnv)) {
    previousEnv[key] = process.env[key];
    process.env[key] = value;
  }

  clearServerModules();
  if (options.mockDb) installMockDb(options.mockDb);
  const serverModule = require(serverIndexPath);
  await serverModule.start(port);
  await waitForServer(`http://127.0.0.1:${port}/`);

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      await new Promise((resolve) => serverModule.io.close(resolve));
      await new Promise((resolve) => serverModule.server.close(resolve));
      clearServerModules();
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}

async function testSmokeFlow() {
  const server = await startServer();
  try {
    const rootRes = await fetch(`${server.baseUrl}/`);
    assert.equal(rootRes.status, 200);
    const rootJson = await rootRes.json();
    assert.equal(rootJson.status, 'ok');

    const email = `user${Date.now()}@example.com`;
    const registerRes = await fetch(`${server.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Tester', email, password: 'secret123' }),
    });
    assert.equal(registerRes.status, 201);
    const registerJson = await registerRes.json();
    assert.ok(registerJson.token);

    const loginRes = await fetch(`${server.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'secret123' }),
    });
    assert.equal(loginRes.status, 200);
    const loginJson = await loginRes.json();
    assert.ok(loginJson.token);

    const meRes = await fetch(`${server.baseUrl}/auth/me`, {
      headers: { Authorization: `Bearer ${loginJson.token}` },
    });
    assert.equal(meRes.status, 200);
    const meJson = await meRes.json();
    assert.equal(meJson.username, 'Tester');
    assert.equal(meJson.email, email);

    const forgotRes = await fetch(`${server.baseUrl}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    assert.equal(forgotRes.status, 503);

    const resultRes = await fetch(`${server.baseUrl}/stats/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${loginJson.token}`,
      },
      body: JSON.stringify({
        room_id: 1,
        winner_team: 1,
        duration_minutes: 45,
        replay_path: 'C:\\fake\\game.w3g',
        players: [{ name: 'Tester', team: 1 }],
      }),
    });
    assert.equal(resultRes.status, 503);

    const discordLinkRes = await fetch(`${server.baseUrl}/auth/discord?link=1`, {
      redirect: 'manual',
    });
    assert.equal(discordLinkRes.status, 401);
  } finally {
    await server.stop();
  }
}

async function testProductionRoomGuard() {
  const server = await startServer({ NODE_ENV: 'production' });
  try {
    const roomsRes = await fetch(`${server.baseUrl}/rooms`);
    assert.equal(roomsRes.status, 503);
    const roomsJson = await roomsRes.json();
    assert.equal(roomsJson.error, 'Service temporarily unavailable');
  } finally {
    await server.stop();
  }
}

async function testRoomStartRequiresHost() {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT host_id, status FROM rooms WHERE id = $1')) {
        return { rows: [{ host_id: 99, status: 'waiting' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({}, { mockDb });
  try {
    const token = makeAuthToken({ id: 5, username: 'NotHost' });
    const res = await fetch(`${server.baseUrl}/rooms/123/start`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'Only the host can start the game');
  } finally {
    await server.stop();
  }
}

async function testRoomTeamRequiresMembership() {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT max_players FROM rooms WHERE id = $1')) {
        return { rows: [{ max_players: 10 }] };
      }
      if (sql.includes('SELECT COUNT(*) FROM room_players WHERE room_id = $1 AND team = $2')) {
        return { rows: [{ count: '0' }] };
      }
      if (sql.includes('UPDATE room_players SET team = $1 WHERE room_id = $2 AND user_id = $3 RETURNING user_id')) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({}, { mockDb });
  try {
    const token = makeAuthToken({ id: 5, username: 'Player' });
    const res = await fetch(`${server.baseUrl}/rooms/222/team`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ team: 1 }),
    });

    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'You are not a member of this room');
  } finally {
    await server.stop();
  }
}

async function testStatsResultRequiresHost() {
  const mockDb = {
    query: async (sql) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2')) {
        return { rows: [{}] };
      }
      if (sql.includes('SELECT host_id, status FROM rooms WHERE id=$1')) {
        return { rows: [{ host_id: 99, status: 'playing' }] };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({}, { mockDb });
  try {
    const token = makeAuthToken({ id: 5, username: 'Member' });
    const res = await fetch(`${server.baseUrl}/stats/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        room_id: 7,
        winner_team: 1,
        duration_minutes: 30,
        replay_path: 'C:\\fake\\game.w3g',
        players: [{ user_id: 5, team: 1 }],
      }),
    });

    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, 'Зөвхөн host үр дүн бүртгэнэ');
  } finally {
    await server.stop();
  }
}

async function testStatsResultRejectsPlayersOutsideRoom() {
  const mockDb = {
    query: async (sql, params) => {
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('SELECT 1 FROM room_players WHERE room_id=$1 AND user_id=$2')) {
        return { rows: [{}] };
      }
      if (sql.includes('SELECT host_id, status FROM rooms WHERE id=$1')) {
        return { rows: [{ host_id: 5, status: 'playing' }] };
      }
      if (sql.includes('SELECT id FROM game_results WHERE room_id=$1')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT u.id, u.username, u.discord_id')) {
        return {
          rows: [
            { id: 5, username: 'Host', discord_id: null },
            { id: 7, username: 'Member', discord_id: null },
          ],
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({}, { mockDb });
  try {
    const token = makeAuthToken({ id: 5, username: 'Host' });
    const res = await fetch(`${server.baseUrl}/stats/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        room_id: 7,
        winner_team: 1,
        duration_minutes: 30,
        replay_path: 'C:\\fake\\game.w3g',
        players: [{ user_id: 999, team: 1 }],
      }),
    });

    assert.equal(res.status, 400);
    const json = await res.json();
    assert.equal(json.error, 'Submitted player does not belong to the room');
  } finally {
    await server.stop();
  }
}

async function testDbBackedBlockCheck() {
  clearServerModules();
  installMockDb({
    query: async (sql, params) => {
      if (sql.includes('FROM blocked_users')) {
        return { rows: params[0] === '2' && params[1] === '1' ? [{}] : [] };
      }
      if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }] };
      return { rows: [], rowCount: 0 };
    },
  });

  try {
    const socialRoutes = require(path.join(serverDir, 'src', 'routes', 'social.js'));
    assert.equal(await socialRoutes.isUserBlocked('2', '1'), true);
    assert.equal(await socialRoutes.isUserBlocked('2', '3'), false);
  } finally {
    clearServerModules();
  }
}

(async () => {
  await runTest('server smoke flow supports register/login/me and guarded auth endpoints', testSmokeFlow);
  await runTest('production mode rejects DB-backed room listing when DB is unavailable', testProductionRoomGuard);
  await runTest('rooms/start rejects non-host users', testRoomStartRequiresHost);
  await runTest('rooms/team rejects users who are not room members', testRoomTeamRequiresMembership);
  await runTest('stats/result rejects non-host submitters', testStatsResultRequiresHost);
  await runTest('stats/result rejects players outside the room roster', testStatsResultRejectsPlayersOutsideRoom);
  await runTest('social block checks use DB-backed blocked_users data', testDbBackedBlockCheck);

  if (process.exitCode) process.exit(process.exitCode);
})();
