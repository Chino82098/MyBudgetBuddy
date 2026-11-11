'use strict';
// Local SQLite storage using Node's built-in node:sqlite (Node 22.5+).
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function open(dataDir) {
  const db = new DatabaseSync(path.join(dataDir, 'budgetbuddy.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS enrollments (
      id TEXT PRIMARY KEY,
      access_token TEXT NOT NULL,
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
      hidden INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id TEXT PRIMARY KEY,
      account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
      date TEXT,
      amount REAL,
      description TEXT,
      counterparty TEXT,
      teller_category TEXT,
      type TEXT,
      status TEXT,
      running_balance TEXT,
      -- user-editable fields (never overwritten by sync)
      category TEXT,
      tags TEXT DEFAULT '',
      note TEXT DEFAULT '',
      exclude INTEGER DEFAULT 0,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(date);
    CREATE INDEX IF NOT EXISTS idx_tx_account ON transactions(account_id);

    CREATE TABLE IF NOT EXISTS budgets (
      category TEXT PRIMARY KEY,
      monthly_limit REAL NOT NULL
    );
  `);
  return db;
}

module.exports = { open };
