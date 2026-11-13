'use strict';
// Categories the user can pick from, plus "remembered merchants": when you set a category on a
// transaction, new transactions from the same merchant get that category on future syncs.

const BUILTIN = ['Transfer', 'Uncategorized']; // Transfer is always left out of spending totals; neither can be deleted.
const ALWAYS_EXCLUDED = ['Transfer'];
const DEFAULTS = [
  'Dining', 'Entertainment', 'Fees', 'Fuel', 'Groceries', 'Health', 'Home', 'Income', 'Insurance',
  'Loan Payments', 'Personal Care', 'Services', 'Shopping', 'Taxes & Donations', 'Transport', 'Travel', 'Utilities',
];

// "MTA*NYCT PAYGO #1234" and "Mta" both become "mta" when a merchant name is present; otherwise the
// description with store numbers and punctuation stripped.
function merchantKey(row) {
  const raw = String(row.counterparty || row.description || '').toLowerCase();
  return raw.replace(/[#*].*$/, '').replace(/\d+/g, ' ').replace(/[^a-z&' ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
}

// Returns the stored spelling of a category, creating it if it's new ("dining" -> "Dining").
function ensure(db, name) {
  const n = cleanName(name) || 'Uncategorized';
  const hit = db.prepare('SELECT name FROM categories WHERE name=? COLLATE NOCASE').get(n);
  if (hit) return hit.name;
  db.prepare('INSERT INTO categories (name) VALUES (?)').run(n);
  return n;
}

function list(db) {
  const names = db.prepare('SELECT name FROM categories').all().map((r) => r.name);
  const used = db.prepare('SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL').all().map((r) => r.category);
  return [...new Set([...names, ...used, ...BUILTIN])].sort((a, b) => a.localeCompare(b));
}

function learn(db, row, category) {
  const key = merchantKey(row);
  if (!key) return null;
  // Setting a merchant back to Uncategorized forgets it, so the bank's guess is used again.
  if (category === 'Uncategorized') {
    db.prepare('DELETE FROM category_rules WHERE merchant=?').run(key);
    return null;
  }
  db.prepare(`INSERT INTO category_rules (merchant, category, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(merchant) DO UPDATE SET category=excluded.category, updated_at=excluded.updated_at`).run(key, category);
  return key;
}

function ruleFor(db, row) {
  const key = merchantKey(row);
  const r = key && db.prepare('SELECT category FROM category_rules WHERE merchant=?').get(key);
  return r ? r.category : null;
}

// Other transactions from the same merchant whose category was picked automatically, not by you.
function similar(db, row, category) {
  const key = merchantKey(row);
  if (!key) return [];
  return db
    .prepare('SELECT id, counterparty, description FROM transactions WHERE id<>? AND category_manual=0 AND category IS NOT ?')
    .all(row.id, category)
    .filter((t) => merchantKey(t) === key)
    .map((t) => t.id);
}

function rename(db, from, to) {
  const target = cleanName(to);
  if (!target) throw Object.assign(new Error('Category name required'), { status: 400 });
  if (BUILTIN.includes(from)) throw Object.assign(new Error(`“${from}” is built in and can't be renamed`), { status: 400 });
  db.exec('BEGIN');
  try {
    const existing = db.prepare('SELECT name FROM categories WHERE name=? COLLATE NOCASE AND name<>?').get(target, from);
    const finalName = existing ? existing.name : target; // renaming onto an existing category merges them
    if (existing) db.prepare('DELETE FROM categories WHERE name=?').run(from);
    else if (db.prepare('SELECT 1 FROM categories WHERE name=?').get(from)) db.prepare('UPDATE categories SET name=? WHERE name=?').run(finalName, from);
    else db.prepare('INSERT OR IGNORE INTO categories (name) VALUES (?)').run(finalName);
    db.prepare('UPDATE transactions SET category=? WHERE category=?').run(finalName, from);
    db.prepare('UPDATE category_rules SET category=? WHERE category=?').run(finalName, from);
    const budget = db.prepare('SELECT monthly_limit FROM budgets WHERE category=?').get(from);
    if (budget) {
      db.prepare('DELETE FROM budgets WHERE category=?').run(from);
      db.prepare('INSERT OR IGNORE INTO budgets VALUES (?, ?)').run(finalName, budget.monthly_limit);
    }
    db.exec('COMMIT');
    return finalName;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

// Categories left out of totals: Transfer, plus any you've switched off in Categories.
function excluded(db) {
  const names = db.prepare('SELECT name FROM categories WHERE exclude=1').all().map((r) => r.name);
  return [...new Set([...ALWAYS_EXCLUDED, ...names])].sort((a, b) => a.localeCompare(b));
}

function setExcluded(db, name, on) {
  const n = cleanName(name);
  if (!n) throw Object.assign(new Error('Category name required'), { status: 400 });
  if (ALWAYS_EXCLUDED.includes(n)) throw Object.assign(new Error(`“${n}” is always left out of totals`), { status: 400 });
  const stored = ensure(db, n);
  db.prepare('UPDATE categories SET exclude=? WHERE name=?').run(on ? 1 : 0, stored);
  return stored;
}

// Deleting moves its transactions to Uncategorized and drops its budget and remembered merchants.
function remove(db, name) {
  if (BUILTIN.includes(name)) throw Object.assign(new Error(`“${name}” is built in and can't be deleted`), { status: 400 });
  db.exec('BEGIN');
  const moved = db.prepare("UPDATE transactions SET category='Uncategorized' WHERE category=?").run(name).changes;
  db.prepare('DELETE FROM category_rules WHERE category=?').run(name);
  db.prepare('DELETE FROM budgets WHERE category=?').run(name);
  db.prepare('DELETE FROM categories WHERE name=?').run(name);
  db.exec('COMMIT');
  return moved;
}

module.exports = {
  BUILTIN, DEFAULTS, ALWAYS_EXCLUDED, merchantKey, cleanName, ensure, list, learn, ruleFor, similar, rename, remove,
  excluded, setExcluded,
};
