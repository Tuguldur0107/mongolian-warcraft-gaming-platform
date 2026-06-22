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
  `);
}

module.exports = { runMigrations };
