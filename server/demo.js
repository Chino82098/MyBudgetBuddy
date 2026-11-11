'use strict';
// Fake data so you can try the app before connecting a bank. Remove it from the Accounts tab.
const { defaultCategory } = require('./sync');

const MERCHANTS = [
  ['Whole Foods', 'groceries', [-45, -160]],
  ['Trader Joes', 'groceries', [-25, -90]],
  ['Chipotle', 'dining', [-11, -28]],
  ['Starbucks', 'dining', [-4, -12]],
  ['Shell', 'fuel', [-30, -65]],
  ['Netflix', 'entertainment', [-15.49, -15.49]],
  ['Spotify', 'software', [-11.99, -11.99]],
  ['Amazon', 'shopping', [-12, -140]],
  ['Con Edison', 'utilities', [-70, -130]],
  ['Uber', 'transport', [-9, -35]],
  ['CVS Pharmacy', 'health', [-8, -45]],
];

function rand(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

function load(db) {
  const r = rand(42);
  db.exec('BEGIN');
  try {
    db.prepare(`INSERT OR REPLACE INTO enrollments (id, access_token, institution, status, last_synced_at)
                VALUES ('demo', 'demo', 'Demo Bank', 'ok', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))`).run();
    const acc = db.prepare(`INSERT OR REPLACE INTO accounts (id, enrollment_id, name, institution, type, subtype, last_four, currency, status, balance_available, balance_ledger)
                            VALUES (?, 'demo', ?, 'Demo Bank', ?, ?, ?, 'USD', 'open', ?, ?)`);
    acc.run('demo_checking', 'Everyday Checking', 'depository', 'checking', '1234', '3245.18', '3301.02');
    acc.run('demo_credit', 'Rewards Card', 'credit', 'credit_card', '9876', '4120.00', '880.00');
    const tx = db.prepare(`INSERT OR REPLACE INTO transactions (id, account_id, date, amount, description, counterparty, teller_category, type, status, category, tags, note)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const today = new Date();
    let n = 0;
    for (let d = 0; d < 95; d++) {
      const day = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - d));
      const date = day.toISOString().slice(0, 10);
      const status = d < 2 ? 'pending' : 'posted';
      if (day.getUTCDate() === 1 || day.getUTCDate() === 15) {
        tx.run(`demo_tx_${n++}`, 'demo_checking', date, 2650, 'ACME CORP PAYROLL', 'Acme Corp', 'income', 'ach', status, 'Income', '', '');
      }
      if (day.getUTCDate() === 3) {
        tx.run(`demo_tx_${n++}`, 'demo_checking', date, -1850, 'RENT PAYMENT', 'Parkview Apartments', 'home', 'ach', status, 'Home', 'rent', '');
      }
      if (day.getUTCDate() === 20) {
        const t = { type: 'transfer', details: {} };
        tx.run(`demo_tx_${n++}`, 'demo_checking', date, -600, 'PAYMENT TO REWARDS CARD', 'Demo Bank', null, 'transfer', status, defaultCategory(t), '', '');
      }
      const count = Math.floor(r() * 3);
      for (let i = 0; i < count; i++) {
        const [name, cat, [lo, hi]] = MERCHANTS[Math.floor(r() * MERCHANTS.length)];
        const amount = Math.round((lo + (hi - lo) * r()) * 100) / 100;
        const account = r() < 0.6 ? 'demo_credit' : 'demo_checking';
        const tags = name === 'Uber' && r() < 0.5 ? 'work-trip' : name === 'Amazon' && r() < 0.3 ? 'gift' : '';
        const note = tags === 'work-trip' ? 'Expense this' : '';
        tx.run(`demo_tx_${n++}`, account, date, amount, `${name.toUpperCase()} #${1000 + Math.floor(r() * 9000)}`, name, cat, 'card_payment', status, defaultCategory({ details: { category: cat } }), tags, note);
      }
    }
    for (const [cat, limit] of [['Groceries', 500], ['Dining', 200], ['Shopping', 250], ['Entertainment', 50]]) {
      db.prepare('INSERT OR IGNORE INTO budgets VALUES (?, ?)').run(cat, limit);
    }
    db.exec('COMMIT');
    return { transactions: n };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

module.exports = { load };
