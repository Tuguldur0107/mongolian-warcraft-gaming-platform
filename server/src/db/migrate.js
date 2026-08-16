const fs = require('fs/promises');
const path = require('path');

async function runMigrations(db) {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = await fs.readFile(schemaPath, 'utf8');

  await db.query(schemaSql);
  await db.query(`
    ALTER TABLE room_players
      ADD COLUMN IF NOT EXISTS team INTEGER DEFAULT NULL;

    ALTER TABLE rooms
      ADD COLUMN IF NOT EXISTS description TEXT DEFAULT '',
      ADD COLUMN IF NOT EXISTS game_mode VARCHAR(100) DEFAULT '';

    ALTER TABLE users
      ADD COLUMN IF NOT EXISTS discord_username VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tierbot_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS tierbot_rating INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS tierbot_tier VARCHAR(100),
      ADD COLUMN IF NOT EXISTS tierbot_rank INTEGER,
      ADD COLUMN IF NOT EXISTS tierbot_synced_at TIMESTAMP;

    CREATE INDEX IF NOT EXISTS idx_users_tierbot_id ON users(tierbot_id);
    CREATE INDEX IF NOT EXISTS idx_users_tierbot_rating ON users(tierbot_rating DESC);
  `);
}

module.exports = { runMigrations };
