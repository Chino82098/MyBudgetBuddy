'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-test-'));
process.env.BUDGETBUDDY_DATA = tmp;

const { open } = require('../server/db');
const { syncAll } = require('../server/sync');
const { createClient, PlaidError } = require('../server/plaid');
const { start } = require('../server');

function ptx(id, date, amount, extra = {}) {
  return { transaction_id: id, account_id: 'acc_1', date, amount, name: `DESC ${id}`, merchant_name: 'Cafe',
    pending: false, payment_channel: 'in store',
    personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE' }, ...extra };
}

function fakePlaid(pages) {
  const calls = [];
  return {
    calls,
    getAccounts: async () => ({ accounts: [{ account_id: 'acc_1', name: 'Checking', mask: '1111', type: 'depository',
      subtype: 'checking', balances: { available: 100, current: 120, iso_currency_code: 'USD' } }] }),
    transactionsSync: async (token, cursor) => {
      calls.push(cursor);
      const p = pages.shift();
      if (p instanceof Error) throw p;
      return p || { added: [], modified: [], removed: [], next_cursor: cursor, has_more: false };
    },
  };
}

function plaidDb() {
  const db = open(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-db-')));
  db.prepare("INSERT INTO enrollments (id, provider, access_token, institution) VALUES ('item_1', 'plaid', 'tok', 'Bank')").run();
  return db;
}

test('sync pages with cursors, flips signs, maps categories, keeps edits', async () => {
  const db = plaidDb();
  const page1 = { added: Array.from({ length: 3 }, (_, i) => ptx(`t${i}`, '2026-10-15', 5)), modified: [], removed: [], next_cursor: 'c1', has_more: true };
  const page2 = {
    added: [
      ptx('pend', '2026-10-01', 9, { pending: true }),
      ptx('xfer', '2026-10-01', 100, { personal_finance_category: { primary: 'LOAN_PAYMENTS', detailed: 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' } }),
      ptx('pay', '2026-10-01', -2000, { personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_WAGES' } }),
    ],
    modified: [], removed: [], next_cursor: 'c2', has_more: false, transactions_update_status: 'HISTORICAL_UPDATE_COMPLETE',
  };
  let client = fakePlaid([page1, page2]);
  let [r] = await syncAll(db, client);
  assert.equal(r.error, undefined);
  assert.equal(r.transactions, 6);
  assert.deepEqual(client.calls, [null, 'c1']);
  assert.equal(db.prepare("SELECT cursor FROM enrollments").get().cursor, 'c2');
  const get = (id) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  assert.equal(get('t1').amount, -5, 'Plaid positive (money out) becomes negative');
  assert.equal(get('pay').amount, 2000);
  assert.equal(get('t1').category, 'Dining');
  assert.equal(get('xfer').category, 'Transfer');
  assert.equal(get('pay').category, 'Income');
  const acc = db.prepare("SELECT * FROM accounts WHERE id='acc_1'").get();
  assert.deepEqual([acc.balance_available, acc.institution, acc.last_four], ['100.0', 'Bank', '1111']);

  db.prepare("UPDATE transactions SET tags='coffee', note='hi', category='Treats', updated_at=datetime('now') WHERE id IN ('t1','pend')").run();

  // Second sync: from saved cursor; t1 modified, pending posted under a new id, t2 removed.
  client = fakePlaid([{
    added: [ptx('posted', '2026-10-02', 9, { pending_transaction_id: 'pend' })],
    modified: [ptx('t1', '2026-10-15', 6)], removed: [{ transaction_id: 't2' }], next_cursor: 'c3', has_more: false,
  }]);
  [r] = await syncAll(db, client);
  assert.deepEqual(client.calls, ['c2']);
  const t1 = get('t1');
  assert.deepEqual([t1.tags, t1.note, t1.category, t1.amount], ['coffee', 'hi', 'Treats', -6]);
  assert.equal(get('pend'), undefined);
  assert.deepEqual([get('posted').tags, get('posted').category, get('posted').status], ['coffee', 'Treats', 'posted']);
  assert.equal(get('t2'), undefined);
});

test('sync restarts when Plaid data changes mid-pagination', async () => {
  const db = plaidDb();
  const mutation = Object.assign(new Error('mutated'), { code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' });
  const client = fakePlaid([
    { added: [ptx('a', '2026-10-01', 1)], modified: [], removed: [], next_cursor: 'x', has_more: true },
    mutation,
    { added: [ptx('a', '2026-10-01', 1), ptx('b', '2026-10-02', 2)], modified: [], removed: [], next_cursor: 'y', has_more: false },
  ]);
  const [r] = await syncAll(db, client);
  assert.equal(r.error, undefined);
  assert.deepEqual(client.calls, [null, 'x', null]);
  assert.equal(r.transactions, 2);
});

test('sync records disconnected items', async () => {
  const db = plaidDb();
  const client = { getAccounts: async () => { throw new PlaidError('Log in again', 400, 'ITEM_LOGIN_REQUIRED'); } };
  const [r] = await syncAll(db, client);
  assert.match(r.error, /Log in/);
  assert.equal(db.prepare('SELECT status FROM enrollments').get().status, 'disconnected');
});

test('old Teller data: retired on open, edits carried over to matching Plaid transactions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bb-db-'));
  // Simulate a database from the Teller version of the app.
  const { DatabaseSync } = require('node:sqlite');
  const old = new DatabaseSync(path.join(dir, 'budgetbuddy.db'));
  old.exec(`CREATE TABLE enrollments (id TEXT PRIMARY KEY, access_token TEXT NOT NULL, institution TEXT, user_id TEXT,
      status TEXT DEFAULT 'ok', last_error TEXT, last_synced_at TEXT, created_at TEXT);
    CREATE TABLE accounts (id TEXT PRIMARY KEY, enrollment_id TEXT REFERENCES enrollments(id) ON DELETE CASCADE, name TEXT,
      institution TEXT, type TEXT, subtype TEXT, last_four TEXT, currency TEXT, status TEXT, balance_available TEXT,
      balance_ledger TEXT, invert_sign INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0);
    CREATE TABLE transactions (id TEXT PRIMARY KEY, account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE, date TEXT,
      amount REAL, description TEXT, counterparty TEXT, teller_category TEXT, type TEXT, status TEXT, running_balance TEXT,
      category TEXT, tags TEXT DEFAULT '', note TEXT DEFAULT '', exclude INTEGER DEFAULT 0, updated_at TEXT);
    INSERT INTO enrollments (id, access_token, institution) VALUES ('enr_old', 'tok', 'Bank'), ('demo', 'demo', 'Demo Bank');
    INSERT INTO accounts (id, enrollment_id, name, institution, last_four) VALUES ('t_acc', 'enr_old', 'Checking', 'Bank', '1111');
    INSERT INTO transactions (id, account_id, date, amount, category, tags, note, updated_at) VALUES
      ('old1', 't_acc', '2026-06-10', -5, 'Treats', 'coffee', 'note', '2026-06-11'),
      ('old2', 't_acc', '2026-06-12', -40, 'Dining', '', '', NULL),
      ('ancient', 't_acc', '2023-01-01', -7, 'Dining', 'keep', '', '2023-01-02');`);
  old.close();

  const db = open(dir);
  const enr = (id) => db.prepare('SELECT * FROM enrollments WHERE id=?').get(id);
  assert.deepEqual([enr('enr_old').provider, enr('enr_old').status], ['teller', 'retired']);
  assert.equal(enr('demo').provider, 'demo');
  assert.ok(db.prepare('PRAGMA table_info(transactions)').all().some((c) => c.name === 'bank_category'));

  db.prepare("INSERT INTO enrollments (id, provider, access_token, institution) VALUES ('item_1', 'plaid', 'tok', 'Bank')").run();
  const client = fakePlaid([{
    added: [ptx('p1', '2026-06-11', 5), ptx('p2', '2026-06-12', 40), ptx('p3', '2026-06-20', 5)],
    modified: [], removed: [], next_cursor: 'c', has_more: false,
  }]);
  const [r] = await syncAll(db, client);
  assert.equal(r.carriedOver, 2);
  const p1 = db.prepare("SELECT * FROM transactions WHERE id='p1'").get();
  assert.deepEqual([p1.category, p1.tags, p1.note], ['Treats', 'coffee', 'note']);
  assert.equal(db.prepare("SELECT tags FROM transactions WHERE id='p3'").get().tags, '', 'only one match per old txn');
  const left = db.prepare("SELECT id FROM transactions WHERE account_id='t_acc'").all().map((x) => x.id);
  assert.deepEqual(left, ['ancient'], 'history Plaid lacks is kept');
  assert.ok(enr('enr_old'), 'Teller enrollment kept while it still has history');
});

test('Plaid client sends keys and surfaces Plaid errors', async () => {
  const sent = [];
  const fetchImpl = async (url, opts) => {
    sent.push({ url, body: JSON.parse(opts.body) });
    if (url.endsWith('/accounts/get')) {
      return { ok: false, status: 400, json: async () => ({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'login required' }) };
    }
    return { ok: true, status: 200, json: async () => ({ link_token: 'link-sandbox-1' }) };
  };
  assert.throws(() => createClient({}), /client ID and secret/);
  const c = createClient({ plaidClientId: 'cid', plaidSecret: 'sec', plaidEnvironment: 'production' }, fetchImpl);
  assert.equal((await c.createLinkToken()).link_token, 'link-sandbox-1');
  assert.equal(sent[0].url, 'https://production.plaid.com/link/token/create');
  assert.deepEqual([sent[0].body.client_id, sent[0].body.secret, sent[0].body.products], ['cid', 'sec', ['transactions']]);
  await c.createLinkToken('access-1');
  assert.equal(sent[1].body.access_token, 'access-1');
  assert.equal(sent[1].body.products, undefined, 'update mode sends no products');
  await assert.rejects(c.getAccounts('access-1'), (e) => e.code === 'ITEM_LOGIN_REQUIRED' && e.status === 400);
});

test('API: demo data, summary, edits, bulk, csv, security', async (t) => {
  const fake = {
    ...fakePlaid([]),
    createLinkToken: async (token) => ({ link_token: token ? 'link-update' : 'link-new' }),
    exchangePublicToken: async () => ({ access_token: 'access-sandbox-1', item_id: 'item_api' }),
    removeItem: async () => { fake.removed = true; },
  };
  const { server, port } = await start(0, { plaidClient: fake });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${port}`;
  const call = async (p, opts = {}) => {
    const res = await fetch(base + p, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Budget-Buddy': '1', ...(opts.headers || {}) } });
    return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() };
  };

  assert.equal((await fetch(base + '/api/demo', { method: 'POST' })).status, 403, 'writes need app header');
  const rebinding = await new Promise((resolve) =>
    require('node:http').get({ port, host: '127.0.0.1', path: '/', headers: { Host: 'evil.com' } }, (res) => resolve(res.statusCode))
  );
  assert.equal(rebinding, 403, 'foreign Host rejected');
  assert.equal((await call('/../package.json')).status, 404);

  const demo = await call('/api/demo', { method: 'POST' });
  assert.ok(demo.body.transactions > 50);

  const month = new Date().toISOString().slice(0, 7);
  const s = (await call(`/api/summary?month=${month}`)).body;
  assert.ok(s.income > 0 && s.spending > 0);
  assert.ok(!s.byCategory.some((c) => c.category === 'Transfer'), 'transfers excluded from spending');
  assert.ok(s.byCategory.find((c) => c.category === 'Groceries').budget === 500);

  const list = (await call(`/api/transactions?month=${month}`)).body;
  const id = list[0].id;
  const patched = (await call(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: 'Vacation, Big Trip ,vacation', note: 'test' }) })).body;
  assert.equal(patched.tags, 'vacation,big-trip');

  const byTag = (await call(`/api/transactions?tag=big-trip`)).body;
  assert.equal(byTag.length, 1);

  await call('/api/transactions/bulk', { method: 'POST', body: JSON.stringify({ ids: list.slice(0, 3).map((x) => x.id), addTags: 'reviewed' }) });
  assert.equal((await call('/api/transactions?tag=reviewed')).body.length, 3);

  const before = (await call(`/api/summary?month=${month}`)).body.spending;
  const spend = list.find((x) => x.amount < 0 && x.category !== 'Transfer');
  await call(`/api/transactions/${spend.id}`, { method: 'PATCH', body: JSON.stringify({ exclude: true }) });
  const after = (await call(`/api/summary?month=${month}`)).body.spending;
  assert.ok(Math.abs(before - after - -spend.amount) < 0.001, 'excluded txn drops out of spending');

  const csv = await call(`/api/export.csv?month=${month}`);
  assert.match(csv.body.split('\n')[0], /^Date,Description/);
  assert.match(csv.body, /vacation big-trip/);

  const flip = await call('/api/accounts/demo_credit', { method: 'PATCH', body: JSON.stringify({ invert_sign: true }) });
  assert.equal(flip.status, 200);
  const cfg = await call('/api/config', { method: 'PUT', body: JSON.stringify({ plaidClientId: 'cid', plaidSecret: 'sec', sheetsSecret: 'shh', plaidEnvironment: 'development' }) });
  assert.deepEqual([cfg.body.sheetsSecret, cfg.body.plaidSecret, cfg.body.plaidEnvironment], ['••••••', '••••••', 'sandbox']);
  await call('/api/config', { method: 'PUT', body: JSON.stringify({ plaidSecret: '••••••' }) });
  assert.equal(require('../server/config').load().plaidSecret, 'sec', 'masked value does not overwrite secret');
  const sync = await call('/api/sync', { method: 'POST' });
  assert.deepEqual(sync.body.results, [], 'demo enrollment is not synced');

  assert.equal((await call('/api/plaid/link-token', { method: 'POST', body: '{}' })).body.link_token, 'link-new');
  const enr = await call('/api/enrollments', { method: 'POST', body: JSON.stringify({ public_token: 'public-1', institution: { name: 'Bank' } }) });
  assert.equal(enr.body.id, 'item_api');
  assert.equal((await call('/api/plaid/link-token', { method: 'POST', body: JSON.stringify({ enrollmentId: 'item_api' }) })).body.link_token, 'link-update');
  const synced = (await call('/api/sync', { method: 'POST' })).body.results;
  assert.equal(synced.length, 1);
  assert.equal(synced[0].accounts, 1);
  await call('/api/enrollments/item_api', { method: 'DELETE' });
  assert.ok(fake.removed, 'item removed at Plaid too');
});
