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

async function testAdminDashboardAccess() {
  const server = await startServer({ ADMIN_DISCORD_IDS: '999,888' });
  try {
    // The dashboard shell is public; the API behind it is gated.
    const pageRes = await fetch(`${server.baseUrl}/admin`);
    assert.equal(pageRes.status, 200);
    const html = await pageRes.text();
    assert.ok(html.includes('Admin'));

    // Login kicks off Discord OAuth in admin mode.
    const loginRes = await fetch(`${server.baseUrl}/admin/login`, { redirect: 'manual' });
    assert.equal(loginRes.status, 302);
    assert.equal(loginRes.headers.get('location'), '/auth/discord?admin=1');

    // No token → 401.
    const noTokenRes = await fetch(`${server.baseUrl}/admin/api/me`);
    assert.equal(noTokenRes.status, 401);

    // Valid token but Discord ID not whitelisted → 403.
    const nonAdmin = makeAuthToken({ id: 5, username: 'Nobody', discord_id: '111' });
    const deniedRes = await fetch(`${server.baseUrl}/admin/api/me`, {
      headers: { Authorization: `Bearer ${nonAdmin}` },
    });
    assert.equal(deniedRes.status, 403);

    // Whitelisted Discord ID → 200.
    const admin = makeAuthToken({ id: 1, username: 'Boss', discord_id: '999' });
    const meRes = await fetch(`${server.baseUrl}/admin/api/me`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(meRes.status, 200);
    const me = await meRes.json();
    assert.equal(me.discord_id, '999');

    // Online list is admin-gated and returns a shape the dashboard expects.
    const onlineRes = await fetch(`${server.baseUrl}/admin/api/online`, {
      headers: { Authorization: `Bearer ${admin}` },
    });
    assert.equal(onlineRes.status, 200);
    const online = await onlineRes.json();
    assert.ok(Array.isArray(online.users));
    assert.equal(typeof online.count, 'number');
  } finally {
    await server.stop();
  }
}

async function testAdminEmptyWhitelistDeniesEveryone() {
  const server = await startServer({ ADMIN_DISCORD_IDS: '' });
  try {
    const anyone = makeAuthToken({ id: 1, username: 'Boss', discord_id: '999' });
    const res = await fetch(`${server.baseUrl}/admin/api/me`, {
      headers: { Authorization: `Bearer ${anyone}` },
    });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
}

async function testAdminManagement() {
  const store = new Set(); // dynamically-added admin Discord IDs
  const mockDb = {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (s.includes('SELECT 1 FROM admin_whitelist')) {
        return { rows: store.has(String(params[0])) ? [{ x: 1 }] : [] };
      }
      if (s.startsWith('SELECT discord_id, note, added_by, created_at FROM admin_whitelist')) {
        return { rows: [...store].map((id) => ({ discord_id: id, note: '', added_by: '999', created_at: new Date() })) };
      }
      if (s.startsWith('INSERT INTO admin_whitelist')) { store.add(String(params[0])); return { rows: [], rowCount: 1 }; }
      if (s.startsWith('DELETE FROM admin_whitelist')) {
        const had = store.delete(String(params[0]));
        return { rows: [], rowCount: had ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({ ADMIN_DISCORD_IDS: '999' }, { mockDb });
  const boss = makeAuthToken({ id: 1, username: 'Boss', discord_id: '999' });
  const hdr = { Authorization: `Bearer ${boss}` };
  try {
    // Env superadmin appears, locked.
    let res = await fetch(`${server.baseUrl}/admin/api/admins`, { headers: hdr });
    assert.equal(res.status, 200);
    let list = (await res.json()).admins;
    assert.equal(list.length, 1);
    assert.equal(list[0].discord_id, '999');
    assert.equal(list[0].locked, true);

    // Add a dynamic admin by Discord ID.
    res = await fetch(`${server.baseUrl}/admin/api/admins`, {
      method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord_id: '123456789012345678', note: 'friend' }),
    });
    assert.equal(res.status, 201);

    // The newly-added Discord ID can now reach the admin API.
    const friend = makeAuthToken({ id: 2, username: 'Friend', discord_id: '123456789012345678' });
    res = await fetch(`${server.baseUrl}/admin/api/me`, { headers: { Authorization: `Bearer ${friend}` } });
    assert.equal(res.status, 200);

    // Invalid Discord ID is rejected.
    res = await fetch(`${server.baseUrl}/admin/api/admins`, {
      method: 'POST', headers: { ...hdr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ discord_id: 'not-a-number' }),
    });
    assert.equal(res.status, 400);

    // The env superadmin cannot be removed via the dashboard.
    res = await fetch(`${server.baseUrl}/admin/api/admins/999`, { method: 'DELETE', headers: hdr });
    assert.equal(res.status, 400);

    // Removing the dynamic admin revokes their access.
    res = await fetch(`${server.baseUrl}/admin/api/admins/123456789012345678`, { method: 'DELETE', headers: hdr });
    assert.equal(res.status, 200);
    res = await fetch(`${server.baseUrl}/admin/api/me`, { headers: { Authorization: `Bearer ${friend}` } });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
}

async function testWarkeyTracking() {
  const wkStore = new Map(); // discord_id -> row
  const mockDb = {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (s.startsWith('INSERT INTO warkey_users')) {
        wkStore.set(String(params[0]), { discord_id: String(params[0]), username: params[1], version: params[2] });
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('FROM warkey_users WHERE last_seen')) return { rows: [{ c: wkStore.size }] };
      if (s.startsWith('SELECT COUNT(*)::int AS c FROM warkey_users')) return { rows: [{ c: wkStore.size }] };
      if (s.startsWith('SELECT w.discord_id')) {
        return { rows: [...wkStore.values()].map((u) => ({
          discord_id: u.discord_id, username: u.username, avatar_url: null, version: u.version,
          first_seen: new Date(), last_seen: new Date(), online: true,
        })) };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({ ADMIN_DISCORD_IDS: '999' }, { mockDb });
  try {
    // A Discord-linked WarKey user's heartbeat registers them.
    const user = makeAuthToken({ id: 7, username: 'Gamer', discord_id: '777' });
    let res = await fetch(`${server.baseUrl}/warkey/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${user}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.1.0' }),
    });
    assert.equal(res.status, 200);
    assert.ok(wkStore.has('777'));
    assert.equal(wkStore.get('777').version, '2.1.0');

    // A non-Discord (local) account is not tracked as a WarKey user.
    const local = makeAuthToken({ id: 8, username: 'Local' });
    res = await fetch(`${server.baseUrl}/warkey/heartbeat`, {
      method: 'POST', headers: { Authorization: `Bearer ${local}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ version: '2.1.0' }),
    });
    assert.equal(res.status, 400);

    // The admin dashboard lists the WarKey user with their version.
    const admin = makeAuthToken({ id: 1, username: 'Boss', discord_id: '999' });
    res = await fetch(`${server.baseUrl}/admin/api/warkey/users`, { headers: { Authorization: `Bearer ${admin}` } });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.total, 1);
    assert.equal(data.users[0].discord_id, '777');
    assert.equal(data.users[0].version, '2.1.0');

    // Non-admins cannot read the WarKey user list.
    res = await fetch(`${server.baseUrl}/admin/api/warkey/users`, { headers: { Authorization: `Bearer ${user}` } });
    assert.equal(res.status, 403);
  } finally {
    await server.stop();
  }
}

async function testAdminUserEditDelete() {
  const users = new Map([[1, { id: 1, username: 'Old', wins: 2, losses: 3 }]]);
  const mockDb = {
    query: async (sql, params = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s === 'SELECT 1') return { rows: [{ '?column?': 1 }] };
      if (s.startsWith('UPDATE users SET')) {
        const id = params[params.length - 1];
        const u = users.get(id);
        if (!u) return { rows: [] };
        const setPart = s.substring('UPDATE users SET '.length, s.indexOf(' WHERE'));
        for (const m of setPart.matchAll(/(\w+) = \$(\d+)/g)) u[m[1]] = params[parseInt(m[2], 10) - 1];
        return { rows: [{ id: u.id, username: u.username, wins: u.wins, losses: u.losses }] };
      }
      if (s.startsWith('DELETE FROM users WHERE id')) {
        const had = users.delete(params[0]);
        return { rows: [], rowCount: had ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const server = await startServer({ ADMIN_DISCORD_IDS: '999' }, { mockDb });
  const admin = makeAuthToken({ id: 1, username: 'Boss', discord_id: '999' });
  const hdr = { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' };
  try {
    // Edit name and stats.
    let res = await fetch(`${server.baseUrl}/admin/api/users/1`, {
      method: 'PATCH', headers: hdr, body: JSON.stringify({ username: 'New', wins: 10, losses: 1 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.user.username, 'New');
    assert.equal(body.user.wins, 10);
    assert.equal(users.get(1).username, 'New');

    // Negative stats are rejected.
    res = await fetch(`${server.baseUrl}/admin/api/users/1`, {
      method: 'PATCH', headers: hdr, body: JSON.stringify({ wins: -5 }),
    });
    assert.equal(res.status, 400);

    // A non-admin cannot edit.
    const nobody = makeAuthToken({ id: 9, username: 'No', discord_id: '111' });
    res = await fetch(`${server.baseUrl}/admin/api/users/1`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${nobody}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'Hacked' }),
    });
    assert.equal(res.status, 403);
    assert.equal(users.get(1).username, 'New');

    // Delete, then deleting again is a 404.
    res = await fetch(`${server.baseUrl}/admin/api/users/1`, { method: 'DELETE', headers: hdr });
    assert.equal(res.status, 200);
    assert.ok(!users.has(1));
    res = await fetch(`${server.baseUrl}/admin/api/users/1`, { method: 'DELETE', headers: hdr });
    assert.equal(res.status, 404);
  } finally {
    await server.stop();
  }
}

(async () => {
  await runTest('server smoke flow supports register/login/me and guarded auth endpoints', testSmokeFlow);
  await runTest('admin can edit and delete platform users', testAdminUserEditDelete);
  await runTest('admin dashboard gates its API behind a Discord ID whitelist', testAdminDashboardAccess);
  await runTest('admin whitelist that is empty denies everyone', testAdminEmptyWhitelistDeniesEveryone);
  await runTest('admins can be added and removed by Discord ID from the dashboard', testAdminManagement);
  await runTest('warkey heartbeats register Discord users and surface in the dashboard', testWarkeyTracking);
  await runTest('production mode rejects DB-backed room listing when DB is unavailable', testProductionRoomGuard);
  await runTest('rooms/start rejects non-host users', testRoomStartRequiresHost);
  await runTest('rooms/team rejects users who are not room members', testRoomTeamRequiresMembership);
  await runTest('stats/result rejects non-host submitters', testStatsResultRequiresHost);
  await runTest('stats/result rejects players outside the room roster', testStatsResultRejectsPlayersOutsideRoom);
  await runTest('social block checks use DB-backed blocked_users data', testDbBackedBlockCheck);

  if (process.exitCode) process.exit(process.exitCode);
})();
