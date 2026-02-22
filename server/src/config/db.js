const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

pool.on('connect', () => {
  console.log('PostgreSQL-д холбогдлоо');
});

pool.on('error', (err) => {
  console.error('PostgreSQL алдаа:', err);
});

module.exports = pool;
