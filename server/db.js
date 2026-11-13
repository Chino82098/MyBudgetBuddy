'use strict';
// Local SQLite storage using Node's built-in node:sqlite (Node 22.5+).
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { BUILTIN, DEFAULTS } = require('./categories');

function open(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'budgetbuddy.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,           -- Plaid item_id
      provider TEXT DEFAULT 'plaid', -- plaid | teller (retired) | demo
      access_token TEXT NOT NULL,
      cursor TEXT,                   -- Plaid /transactions/sync cursor
      institution TEXT,
      user_id TEXT,
      status TEXT DEFAULT 'ok',
      last_error TEXT,
      last_synced_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      enrollment_id TEXT REFERENCES enrollments(id) ON DELETE CASCADE,
      name TEXT,
      institution TEXT,
      type TEXT,
      subtype TEXT,
      last_four TEXT,
      currency TEXT,
      status TEXT,
      balance_available TEXT,
      balance_ledger TEXT,
      invert_sign INTEGER DEFAULT 0,
      hidden INTEGER DEFAULT 0,
      in_projections INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      date TEXT,
      amount REAL,
      description TEXT,
      counterparty TEXT,
      bank_category TEXT,
      type TEXT,
      status TEXT,
      running_balance TEXT,
      -- user-editable fields (never overwritten by sync)
      category TEXT,
      tags TEXT DEFAULT '',
      note TEXT DEFAULT '',
      exclude INTEGER DEFAULT 0,
      category_manual INTEGER DEFAULT 0, -- 1 = you picked the category (sync and merchant rules leave it alone)
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

    CREATE TABLE IF NOT EXISTS budgets (
      category TEXT PRIMARY KEY,
      monthly_limit REAL NOT NULL
    );

    -- Paychecks for Projections: your changes to a detected paycheck (NULL = use what was detected),
    -- or one you added yourself (manual=1).
    CREATE TABLE IF NOT EXISTS income_streams (
      key TEXT PRIMARY KEY,          -- payer (merchant key) or manual:<id>
      name TEXT,
      amount REAL,
      frequency TEXT,                -- weekly | biweekly | semimonthly | monthly
      next_date TEXT,
      enabled INTEGER,
      manual INTEGER DEFAULT 0,
      estimate TEXT,                 -- how to estimate a paycheck that varies (NULL = default)
      updated_at TEXT
    );

    -- Remembered merchants: new transactions from this merchant get this category on sync.
    CREATE TABLE IF NOT EXISTS category_rules (
      merchant TEXT PRIMARY KEY,
      category TEXT NOT NULL,
      updated_at TEXT
    );
  `);
  migrate(db);
  return db;
}

// Upgrades databases created by the Teller version of the app.
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  const enr = cols('enrollments');
  if (!enr.includes('provider')) {
    // Every enrollment that existed before Plaid support came from Teller.
    db.exec("ALTER TABLE enrollments ADD COLUMN provider TEXT DEFAULT 'teller'");
    db.exec("UPDATE enrollments SET provider='demo' WHERE id='demo'");
  }
  if (!enr.includes('cursor')) db.exec('ALTER TABLE enrollments ADD COLUMN cursor TEXT');
  if (!cols('transactions').includes('category_manual')) {
    db.exec('ALTER TABLE transactions ADD COLUMN category_manual INTEGER DEFAULT 0');
    // Older rows: treat anything you edited as a category you chose, so nothing you set gets changed.
    db.exec('UPDATE transactions SET category_manual=1 WHERE updated_at IS NOT NULL');
  }
  // Your category list. Created once with the defaults plus every category already in use;
  // after that, categories you delete stay deleted.
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='categories'").get()) {
    db.exec("CREATE TABLE categories (name TEXT PRIMARY KEY COLLATE NOCASE, created_at TEXT DEFAULT (datetime('now')))");
    const add = db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)');
    const inUse = db.prepare('SELECT DISTINCT category AS c FROM transactions WHERE category IS NOT NULL UNION SELECT category FROM budgets').all();
    for (const n of [...BUILTIN, ...DEFAULTS, ...inUse.map((r) => r.c)]) add.run(n);
  }
  // 1 = leave this category out of income/spending totals, charts and budgets (set in Categories).
  if (!cols('categories').includes('exclude')) db.exec('ALTER TABLE categories ADD COLUMN exclude INTEGER DEFAULT 0');
  // 0 = leave this account out of Projections (its balance, paychecks and spending).
  if (!cols('accounts').includes('in_projections')) db.exec('ALTER TABLE accounts ADD COLUMN in_projections INTEGER DEFAULT 1');
  if (!cols('income_streams').includes('estimate')) db.exec('ALTER TABLE income_streams ADD COLUMN estimate TEXT');
  if (cols('transactions').includes('teller_category')) {
    db.exec('ALTER TABLE transactions RENAME COLUMN teller_category TO bank_category');
  }
  db.prepare(
    `UPDATE enrollments SET status='retired',
       last_error='Teller shut down. Connect this bank again with Plaid; your categories, tags and notes carry over.'
     WHERE provider='teller'`
  ).run();
}

module.exports = { open };
