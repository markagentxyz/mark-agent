import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'mark.db');

export function getDb() {
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

export function initDatabase() {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT DEFAULT '',
      message TEXT NOT NULL,
      response TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS clients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact TEXT,
      channel TEXT NOT NULL,
      project_brief TEXT,
      status TEXT DEFAULT 'inquiry',
      price REAL DEFAULT 0,
      currency TEXT DEFAULT 'EUR',
      paid INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id INTEGER REFERENCES clients(id),
      type TEXT NOT NULL,
      narrative TEXT,
      strategy TEXT,
      content_calendar TEXT,
      status TEXT DEFAULT 'pending',
      permission_to_post INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS treasury (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      amount REAL NOT NULL,
      currency TEXT NOT NULL,
      description TEXT,
      investment_target TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL UNIQUE,
      price REAL NOT NULL,
      currency TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      service TEXT NOT NULL,
      old_price REAL NOT NULL,
      new_price REAL NOT NULL,
      currency TEXT NOT NULL,
      action TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      metrics_snapshot TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS outreach (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_name TEXT,
      token_address TEXT,
      contact TEXT,
      message_sent TEXT,
      response TEXT,
      score INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS twitter_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      tweet_id TEXT,
      posted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      likes INTEGER DEFAULT 0,
      retweets INTEGER DEFAULT 0,
      replies INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE NOT NULL,
      mrr REAL DEFAULT 0,
      active_clients INTEGER DEFAULT 0,
      twitter_followers INTEGER DEFAULT 0,
      treasury_balance REAL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- MARK's humble starting prices — zero reputation, earn the right to charge more
    INSERT OR IGNORE INTO prices (service, price, currency) VALUES
      ('basic_audit', 39, 'EUR'),
      ('monthly_retainer', 129, 'EUR'),
      ('full_launch', 0.4, 'SOL'),
      ('pre_launch', 0.2, 'SOL'),
      ('content_package', 49, 'EUR'),
      ('community_setup', 39, 'EUR');
  `);

  console.log('[DB] Database initialized with all tables');
  db.close();
}

// Run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  initDatabase();
}
