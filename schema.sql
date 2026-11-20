CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,            -- Notion bot_id (one per user + workspace authorisation)
  notion_user_id TEXT,
  name TEXT,
  email TEXT,
  avatar TEXT,
  workspace_name TEXT,
  token_enc TEXT NOT NULL,        -- Notion access token, AES-GCM encrypted with ENC_KEY
  journal_id TEXT,                -- chosen Journal database
  class_colors TEXT,              -- JSON: {"Work":"purple", ...}
  widget_key TEXT UNIQUE,         -- private key for the home-screen widget image
  kustom_token TEXT,              -- KWGT Remote Msg Token, to refresh the widget right after a save
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
