-- WC3/DotA Platform - Database Schema

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Тоглогчийн хүснэгт
CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  discord_id    VARCHAR(255) UNIQUE,
  username      VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE,
  password_hash TEXT,
  avatar_url    TEXT,
  wins          INTEGER DEFAULT 0,
  losses        INTEGER DEFAULT 0,
  created_at    TIMESTAMP DEFAULT NOW()
);

-- Тоглоомын өрөөний хүснэгт
CREATE TABLE IF NOT EXISTS rooms (
  id                  SERIAL PRIMARY KEY,
  name                VARCHAR(255) NOT NULL,
  host_id             INTEGER REFERENCES users(id) ON DELETE CASCADE,
  zerotier_network_id VARCHAR(255),
  max_players         INTEGER DEFAULT 10,
  status              VARCHAR(50) DEFAULT 'waiting', -- waiting, playing, done
  game_type           VARCHAR(50) DEFAULT 'DotA',
  has_password        BOOLEAN DEFAULT FALSE,
  password_hash       TEXT,
  created_at          TIMESTAMP DEFAULT NOW()
);

-- Өрөөний тоглогчид
CREATE TABLE IF NOT EXISTS room_players (
  room_id   INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
  user_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team      INTEGER DEFAULT NULL,
  joined_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

-- Тоглоомын үр дүн
CREATE TABLE IF NOT EXISTS game_results (
  id               SERIAL PRIMARY KEY,
  room_id          INTEGER REFERENCES rooms(id) ON DELETE SET NULL,
  winner_team      INTEGER NOT NULL,
  duration_minutes INTEGER,
  replay_path      TEXT,
  discord_posted   BOOLEAN DEFAULT FALSE,
  played_at        TIMESTAMP DEFAULT NOW()
);

-- Тоглоомын тоглогчид (game history)
CREATE TABLE IF NOT EXISTS game_players (
  id             SERIAL PRIMARY KEY,
  game_result_id INTEGER REFERENCES game_results(id) ON DELETE CASCADE,
  user_id        INTEGER REFERENCES users(id) ON DELETE CASCADE,
  team           INTEGER NOT NULL,
  is_winner      BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_players_user ON game_players(user_id);

-- Хувийн мессеж (DM)
CREATE TABLE IF NOT EXISTS messages (
  id          SERIAL PRIMARY KEY,
  sender_id   INTEGER REFERENCES users(id) ON DELETE CASCADE,
  receiver_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  is_read     BOOLEAN DEFAULT FALSE,
  created_at  TIMESTAMP DEFAULT NOW()
);

-- Indexes (query performance сайжруулах)
CREATE INDEX IF NOT EXISTS idx_rooms_status         ON rooms(status);
CREATE INDEX IF NOT EXISTS idx_room_players_user    ON room_players(user_id);
CREATE INDEX IF NOT EXISTS idx_room_players_room    ON room_players(room_id);
CREATE INDEX IF NOT EXISTS idx_users_discord_id     ON users(discord_id);
CREATE INDEX IF NOT EXISTS idx_users_wins           ON users(wins DESC);
CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(LEAST(sender_id, receiver_id), GREATEST(sender_id, receiver_id), created_at DESC);
CREATE INDEX IF NOT EXISTS idx_messages_unread
  ON messages(receiver_id, is_read) WHERE is_read = FALSE;
