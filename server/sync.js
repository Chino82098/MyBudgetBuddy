'use strict';
// Pulls accounts, balances and transactions from Plaid into SQLite using /transactions/sync.
// User-edited fields (category, tags, note, exclude) are never overwritten.
const { RECONNECT_CODES } = require('./plaid');

const MAX_PAGES = 400;
const MAX_RESTARTS = 3;

// Plaid "personal finance category" -> Budget Buddy category. Detailed codes win over primary ones.
const DETAILED = {
  FOOD_AND_DRINK_GROCERIES: 'Groceries',
  TRANSPORTATION_GAS: 'Fuel',
  RENT_AND_UTILITIES_RENT: 'Home',
  LOAN_PAYMENTS_CREDIT_CARD_PAYMENT: 'Transfer',
  GENERAL_SERVICES_INSURANCE: 'Insurance',
  ENTERTAINMENT_TV_AND_MOVIES: 'Entertainment',
};
const PRIMARY = {
  INCOME: 'Income',
  TRANSFER_IN: 'Transfer',
  TRANSFER_OUT: 'Transfer',
  LOAN_PAYMENTS: 'Loan Payments',
  BANK_FEES: 'Fees',
  ENTERTAINMENT: 'Entertainment',
  FOOD_AND_DRINK: 'Dining',
  GENERAL_MERCHANDISE: 'Shopping',
  HOME_IMPROVEMENT: 'Home',
  MEDICAL: 'Health',
  PERSONAL_CARE: 'Personal Care',
  GENERAL_SERVICES: 'Services',
  GOVERNMENT_AND_NON_PROFIT: 'Taxes & Donations',
  TRANSPORTATION: 'Transport',
  TRAVEL: 'Travel',
  RENT_AND_UTILITIES: 'Utilities',
};

function defaultCategory(tx) {
  const pfc = tx.personal_finance_category || {};
  return DETAILED[pfc.detailed] || PRIMARY[pfc.primary] || 'Uncategorized';
}

// Plaid: positive = money out. Budget Buddy: negative = money out.
function toRow(tx) {
  const pfc = tx.personal_finance_category || {};
  return {
    id: tx.transaction_id,
    account_id: tx.account_id,
    date: tx.date,
    amount: -Number(tx.amount),
    description: tx.name || tx.original_description || tx.merchant_name || '',
    counterparty: tx.merchant_name || (tx.counterparties && tx.counterparties[0] && tx.counterparties[0].name) || null,
    bank_category: pfc.detailed || null,
    type: tx.payment_channel || null,
    status: tx.pending ? 'pending' : 'posted',
  };
}

function makeStatements(db) {
  return {
    upsertAccount: db.prepare(`
      INSERT INTO accounts (id, enrollment_id, name, institution, type, subtype, last_four, currency, status,
        balance_available, balance_ledger)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
      ON CONFLICT(id) DO UPDATE SET enrollment_id=excluded.enrollment_id, name=excluded.name,
        institution=excluded.institution, type=excluded.type, subtype=excluded.subtype,
        last_four=excluded.last_four, currency=excluded.currency, status=excluded.status,
        balance_available=excluded.balance_available, balance_ledger=excluded.balance_ledger`),
    upsertTx: db.prepare(`
      INSERT INTO transactions (id, account_id, date, amount, description, counterparty, bank_category,
        type, status, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, date=excluded.date, amount=excluded.amount,
        description=excluded.description, counterparty=excluded.counterparty,
        bank_category=excluded.bank_category, type=excluded.type, status=excluded.status`),
    getEdits: db.prepare('SELECT category, tags, note, exclude, updated_at FROM transactions WHERE id=?'),
    copyEdits: db.prepare(
      `UPDATE transactions SET category=?, tags=?, note=?, exclude=?, updated_at=? WHERE id=?`
    ),
    deleteTx: db.prepare('DELETE FROM transactions WHERE id=?'),
    setCursor: db.prepare('UPDATE enrollments SET cursor=? WHERE id=?'),
    setEnrollment: db.prepare(
      `UPDATE enrollments SET status=?, last_error=?, last_synced_at=COALESCE(?, last_synced_at) WHERE id=?`
    ),
  };
}

function hasEdits(row) {
  return row && (row.updated_at || row.tags || row.note || row.exclude);
}

// Reads every page from the stored cursor. If Plaid says the data changed mid-way, start over.
async function fetchChanges(client, token, startCursor) {
  for (let attempt = 0; ; attempt++) {
    const out = { added: [], modified: [], removed: [], cursor: startCursor, status: null };
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const r = await client.transactionsSync(token, out.cursor);
        out.added.push(...(r.added || []));
        out.modified.push(...(r.modified || []));
        out.removed.push(...(r.removed || []));
        out.cursor = r.next_cursor || out.cursor;
        out.status = r.transactions_update_status || out.status;
        if (!r.has_more) break;
      }
      return out;
    } catch (e) {
      if (e.code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' && attempt < MAX_RESTARTS) continue;
      throw e;
    }
  }
}

async function syncEnrollment(db, client, enrollment) {
  const st = makeStatements(db);
  const summary = { enrollment: enrollment.id, institution: enrollment.institution, accounts: 0, transactions: 0 };
  try {
    const { accounts } = await client.getAccounts(enrollment.access_token);
    for (const acc of accounts || []) {
      const b = acc.balances || {};
      st.upsertAccount.run(
        acc.account_id, enrollment.id, acc.name || acc.official_name, enrollment.institution,
        acc.type, acc.subtype, acc.mask, b.iso_currency_code || b.unofficial_currency_code || 'USD',
        b.available ?? null, b.current ?? null
      );
      summary.accounts++;
    }
    const known = new Set((accounts || []).map((a) => a.account_id));

    const ch = await fetchChanges(client, enrollment.access_token, enrollment.cursor);
    db.exec('BEGIN');
    try {
      for (const tx of [...ch.added, ...ch.modified]) {
        if (!known.has(tx.account_id)) continue;
        const row = toRow(tx);
        st.upsertTx.run(row.id, row.account_id, row.date, row.amount, row.description, row.counterparty,
          row.bank_category, row.type, row.status, defaultCategory(tx));
        // A posted transaction replaces its pending version: keep the user's edits from the pending row.
        if (tx.pending_transaction_id && tx.pending_transaction_id !== row.id) {
          const prev = st.getEdits.get(tx.pending_transaction_id);
          if (hasEdits(prev) && !hasEdits(st.getEdits.get(row.id))) {
            st.copyEdits.run(prev.category, prev.tags, prev.note, prev.exclude, prev.updated_at, row.id);
          }
          if (prev) st.deleteTx.run(tx.pending_transaction_id);
        }
      }
      for (const r of ch.removed) st.deleteTx.run(r.transaction_id);
      st.setCursor.run(ch.cursor || null, enrollment.id);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    summary.transactions = ch.added.length + ch.modified.length;
    if (ch.status === 'NOT_READY' || ch.status === 'INITIAL_UPDATE_COMPLETE') {
      summary.note = 'Plaid is still pulling older history. Sync again in a few minutes.';
    }
    summary.carriedOver = carryOverFromTeller(db, enrollment.id);
    st.setEnrollment.run('ok', null, new Date().toISOString(), enrollment.id);
  } catch (e) {
    st.setEnrollment.run(RECONNECT_CODES.has(e.code) ? 'disconnected' : 'error', e.message, null, enrollment.id);
    summary.error = e.message;
    summary.code = e.code;
  }
  return summary;
}

// ---------- Teller -> Plaid hand-over ----------
// For each Plaid account, find the old Teller account at the same bank with the same last 4 digits.
// Matching transactions (same amount, date within 3 days) get the user's edits copied onto the Plaid
// row and the Teller duplicate is deleted. Older Teller history Plaid doesn't have is kept.
const DAY = 86400000;

function carryOverFromTeller(db, enrollmentId) {
  const plaidAccounts = db.prepare('SELECT * FROM accounts WHERE enrollment_id=?').all(enrollmentId);
  const tellerAccounts = db
    .prepare(`SELECT a.* FROM accounts a JOIN enrollments e ON e.id=a.enrollment_id WHERE e.provider='teller'`)
    .all();
  if (!tellerAccounts.length) return 0;

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const txOf = db.prepare(
    `SELECT id, date, amount, category, tags, note, exclude, updated_at FROM transactions WHERE account_id=?`
  );
  const copy = db.prepare(`UPDATE transactions SET category=?, tags=?, note=?, exclude=?, updated_at=? WHERE id=?`);
  const del = db.prepare('DELETE FROM transactions WHERE id=?');
  const cents = (amt, invert) => Math.round((invert ? -amt : amt) * 100);
  let moved = 0;

  db.exec('BEGIN');
  try {
    for (const p of plaidAccounts) {
      if (!p.last_four) continue;
      const sameMask = tellerAccounts.filter((t) => t.last_four === p.last_four);
      const t = sameMask.find((x) => norm(x.institution) && norm(x.institution) === norm(p.institution))
        || (sameMask.length === 1 ? sameMask[0] : null);
      if (!t) continue;
      if (t.hidden) db.prepare('UPDATE accounts SET hidden=1 WHERE id=?').run(p.id);

      const byAmount = new Map();
      for (const row of txOf.all(p.id)) {
        const k = cents(row.amount, p.invert_sign);
        if (!byAmount.has(k)) byAmount.set(k, []);
        byAmount.get(k).push(row);
      }
      for (const old of txOf.all(t.id)) {
        const list = byAmount.get(cents(old.amount, t.invert_sign));
        if (!list || !list.length) continue;
        const when = Date.parse(old.date);
        let best = -1;
        let bestGap = 3 * DAY + 1;
        list.forEach((row, i) => {
          const gap = Math.abs(Date.parse(row.date) - when);
          if (gap < bestGap) [best, bestGap] = [i, gap];
        });
        if (best < 0) continue;
        const [match] = list.splice(best, 1);
        if (hasEdits(old) && !hasEdits(match)) {
          copy.run(old.category, old.tags, old.note, old.exclude, old.updated_at || new Date().toISOString(), match.id);
        }
        del.run(old.id);
        moved++;
      }
    }
    // Drop Teller enrollments that have nothing left.
    db.prepare(
      `DELETE FROM enrollments WHERE provider='teller' AND NOT EXISTS (
         SELECT 1 FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.enrollment_id=enrollments.id)`
    ).run();
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return moved;
}

async function syncAll(db, client) {
  const enrollments = db.prepare("SELECT * FROM enrollments WHERE provider='plaid'").all();
  const results = [];
  for (const en of enrollments) results.push(await syncEnrollment(db, client, en));
  return results;
}

module.exports = { syncAll, syncEnrollment, defaultCategory, carryOverFromTeller };
