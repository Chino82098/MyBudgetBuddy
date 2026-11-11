'use strict';
// Loads / saves user settings (Plaid keys, Sheets webhook) in the data dir.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DATA_DIR = process.env.BUDGETBUDDY_DATA || path.join(os.homedir(), '.budgetbuddy');
const CONFIG_PATH = path.join(DATA_DIR, 'config.json');

const DEFAULTS = {
  plaidClientId: '',
  plaidSecret: '',
  plaidEnvironment: 'sandbox', // sandbox | production
  sheetsWebhookUrl: '',
  sheetsSecret: '',
};

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
}

function load() {
  ensureDataDir();
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) if (saved[key] !== undefined) out[key] = saved[key];
    return out;
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = { ...load() };
  for (const key of Object.keys(DEFAULTS)) {
    if (patch[key] !== undefined) next[key] = String(patch[key]).trim();
  }
  if (!['sandbox', 'production'].includes(next.plaidEnvironment)) next.plaidEnvironment = 'sandbox';
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

module.exports = { DATA_DIR, load, save, ensureDataDir };
