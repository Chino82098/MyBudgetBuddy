'use strict';
// Pulls accounts, balances and transactions from Teller into SQLite.
// User-edited fields (category, tags, note, exclude) are never overwritten.

const PAGE_SIZE = 250;
const OVERLAP_DAYS = 14; // re-fetch this many days before the newest stored txn to catch pending -> posted

function titleCase(s) {
  return s ? s.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : null;
}

function defaultCategory(tx) {
  if (tx.type === 'transfer') return 'Transfer';
  const c = tx.details && tx.details.category;
  return titleCase(c) || 'Uncategorized';
}

function isoDaysBefore(date, days) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchAllTransactions(client, token, accountId, startDate) {
  const all = [];
  let fromId;
  for (let page = 0; page < 200; page++) {
    const batch = await client.listTransactions(token, accountId, {
      count: PAGE_SIZE,
      from_id: fromId,
      start_date: startDate,
    });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    fromId = batch[batch.length - 1].id;
  }
  return all;
}

function makeStatements(db) {
  return {
    upsertAccount: db.prepare(`
      INSERT INTO accounts (id, enrollment_id, name, institution, type, subtype, last_four, currency, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET enrollment_id=excluded.enrollment_id, name=excluded.name,
        institution=excluded.institution, type=excluded.type, subtype=excluded.subtype,
        last_four=excluded.last_four, currency=excluded.currency, status=excluded.status`),
    setBalances: db.prepare('UPDATE accounts SET balance_available=?, balance_ledger=? WHERE id=?'),
    newestDate: db.prepare('SELECT MAX(date) AS d FROM transactions WHERE account_id=?'),
    upsertTx: db.prepare(`
      INSERT INTO transactions (id, account_id, date, amount, description, counterparty, teller_category,
        type, status, running_balance, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET account_id=excluded.account_id, date=excluded.date, amount=excluded.amount,
        description=excluded.description, counterparty=excluded.counterparty,
        teller_category=excluded.teller_category, type=excluded.type, status=excluded.status,
        running_balance=excluded.running_balance`),
    stalePending: db.prepare(
      `SELECT id FROM transactions WHERE account_id=? AND status='pending' AND date>=?`
    ),
    deleteTx: db.prepare(`DELETE FROM transactions WHERE id=? AND tags='' AND note=''`),
    setEnrollment: db.prepare(
      `UPDATE enrollments SET status=?, last_error=?, last_synced_at=COALESCE(?, last_synced_at) WHERE id=?`
    ),
  };
}

async function syncEnrollment(db, client, enrollment) {
  const st = makeStatements(db);
  const summary = { enrollment: enrollment.id, institution: enrollment.institution, accounts: 0, transactions: 0 };
  try {
    const accounts = await client.listAccounts(enrollment.access_token);
    for (const acc of accounts) {
      st.upsertAccount.run(
        acc.id, enrollment.id, acc.name, acc.institution && acc.institution.name,
        acc.type, acc.subtype, acc.last_four, acc.currency, acc.status
      );
      summary.accounts++;
      if (acc.status && acc.status !== 'open') continue;
      const links = acc.links || {};

      if (links.balances) {
        try {
          const bal = await client.getBalances(enrollment.access_token, acc.id);
          st.setBalances.run(bal.available ?? null, bal.ledger ?? null, acc.id);
        } catch (e) {
          // Some institutions don't support balances; keep going.
        }
      }

      if (links.transactions) {
        const newest = st.newestDate.get(acc.id).d;
        const startDate = newest ? isoDaysBefore(newest, OVERLAP_DAYS) : undefined;
        const txs = await fetchAllTransactions(client, enrollment.access_token, acc.id, startDate);
        const seen = new Set();
        db.exec('BEGIN');
        try {
          for (const tx of txs) {
            seen.add(tx.id);
            st.upsertTx.run(
              tx.id, acc.id, tx.date, Number(tx.amount), tx.description,
              (tx.details && tx.details.counterparty && tx.details.counterparty.name) || null,
              (tx.details && tx.details.category) || null,
              tx.type, tx.status, tx.running_balance ?? null, defaultCategory(tx)
            );
          }
          // Pending transactions that disappeared were replaced by their posted version.
          if (startDate) {
            for (const row of st.stalePending.all(acc.id, startDate)) {
              if (!seen.has(row.id)) st.deleteTx.run(row.id);
            }
          }
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        summary.transactions += txs.length;
      }
    }
    st.setEnrollment.run('ok', null, new Date().toISOString(), enrollment.id);
  } catch (e) {
    const disconnected = e.code && String(e.code).startsWith('enrollment.disconnected');
    st.setEnrollment.run(disconnected ? 'disconnected' : 'error', e.message, null, enrollment.id);
    summary.error = e.message;
    summary.code = e.code;
  }
  return summary;
}

async function syncAll(db, client) {
  const enrollments = db.prepare("SELECT * FROM enrollments WHERE id<>'demo'").all();
  const results = [];
  for (const en of enrollments) results.push(await syncEnrollment(db, client, en));
  return results;
}

module.exports = { syncAll, syncEnrollment, defaultCategory };
