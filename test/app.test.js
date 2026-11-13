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

test('sync prefers real-time balances, falls back, and fills credit-card available', async () => {
  const db = plaidDb();
  const empty = async () => ({ added: [], modified: [], removed: [], next_cursor: 'c', has_more: false });
  const cached = { accounts: [
    { account_id: 'chk', name: 'Checking', mask: '7013', type: 'depository', subtype: 'checking', balances: { available: null, current: 444.92 } },
    { account_id: 'cc', name: 'Card', mask: '4368', type: 'credit', subtype: 'credit card', balances: { available: null, current: 3, limit: 1000 } },
  ] };
  const live = { accounts: [{ ...cached.accounts[0], balances: { available: 440, current: 444.92 } }, cached.accounts[1]] };
  let opts;
  await syncAll(db, { getBalances: async (t, d) => { opts = d; return live; }, getAccounts: async () => cached, transactionsSync: empty });
  const bal = (id) => db.prepare('SELECT balance_available FROM accounts WHERE id=?').get(id).balance_available;
  assert.equal(Number(bal('chk')), 440);
  assert.equal(Number(bal('cc')), 997);

  await syncAll(db, { getBalances: async () => { throw new PlaidError('nope', 400, 'LAST_UPDATED_DATETIME_OUT_OF_RANGE'); },
    getAccounts: async () => cached, transactionsSync: empty });
  assert.equal(bal('chk'), null, 'falls back to cached data');
  assert.equal(db.prepare('SELECT status FROM enrollments').get().status, 'ok');
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
  {
    // Income counts only the Income category; refunds in other categories lower spending.
    const rows = (await call(`/api/transactions?month=${month}`)).body.filter((t) => !t.exclude && t.category !== 'Transfer');
    const inc = rows.filter((t) => t.category === 'Income').reduce((a, t) => a + t.amount, 0);
    const spend = rows.filter((t) => t.category !== 'Income').reduce((a, t) => a - t.amount, 0);
    assert.ok(Math.abs(s.income - inc) < 0.01, 'income = Income category only');
    assert.ok(Math.abs(s.spending - spend) < 0.01, 'spending is net of refunds');
  }
  assert.ok(!s.byCategory.some((c) => c.category === 'Transfer'), 'transfers excluded from spending');
  assert.ok(s.byCategory.find((c) => c.category === 'Groceries').budget === 500);

  // Year / YTD / custom ranges: budgets scale with the number of months, long ranges chart by month.
  const year = month.slice(0, 4);
  const ys = (await call(`/api/summary?from=${year}-01-01&to=${year}-12-31`)).body;
  assert.equal(ys.months, 12);
  assert.equal(ys.granularity, 'month');
  assert.equal(ys.byCategory.find((c) => c.category === 'Groceries').budget, 6000);
  assert.ok(ys.spending >= s.spending - 0.001, 'a year includes this month');
  const half = (await call('/api/summary?from=2026-04-16&to=2026-05-31')).body;
  assert.equal(half.months, 1.5, 'half of April + all of May');
  assert.equal(half.granularity, 'day');
  const swapped = (await call(`/api/summary?from=${month}-28&to=${month}-01`)).body;
  assert.equal(swapped.from, `${month}-01`, 'from/to are put in order');
  assert.equal((await call('/api/summary?from=2026-13-01&to=2026-12-31')).status, 400);
  const rangeTx = (await call(`/api/transactions?from=${month}-01&to=${month}-31`)).body;
  assert.ok(rangeTx.length > 0 && rangeTx.every((t) => t.date.startsWith(month)));

  const list = (await call(`/api/transactions?month=${month}`)).body;
  const id = list[0].id;
  const patched = (await call(`/api/transactions/${id}`, { method: 'PATCH', body: JSON.stringify({ tags: 'Vacation, Big Trip ,vacation', note: 'test' }) })).body;
  assert.equal(patched.tags, 'vacation,big-trip');

  // Amount search: exact with cents, whole-dollar band without, sign ignored, combines with text search.
  const sample = list.find((x) => x.amount < 0 && Math.abs(x.amount) % 1 > 0.01);
  const abs = Math.abs(sample.amount);
  const exact = (await call(`/api/transactions?amount=${abs.toFixed(2)}`)).body;
  assert.ok(exact.some((x) => x.id === sample.id) && exact.every((x) => Math.abs(Math.abs(x.amount) - abs) < 0.005));
  const dollars = (await call(`/api/transactions?amount=${encodeURIComponent('$' + Math.floor(abs))}`)).body;
  assert.ok(dollars.some((x) => x.id === sample.id) && dollars.every((x) => Math.floor(Math.abs(x.amount)) === Math.floor(abs)));
  const both = (await call(`/api/transactions?q=${encodeURIComponent(sample.counterparty)}&amount=${abs.toFixed(2)}`)).body;
  assert.ok(both.length >= 1 && both.every((x) => x.counterparty === sample.counterparty || x.description.includes(sample.counterparty)));
  assert.equal((await call(`/api/transactions?amount=abc`)).status, 200, 'bad amount is ignored');

  // Word search: all words must match, in any order, across description/merchant.
  const words = sample.description.split(/\s+/).filter((w) => w.length > 1);
  if (words.length > 1) {
    const reversed = (await call(`/api/transactions?q=${encodeURIComponent(words.slice().reverse().join(' ').toLowerCase())}`)).body;
    assert.ok(reversed.some((x) => x.id === sample.id), 'words match in any order');
  }
  assert.equal((await call(`/api/transactions?q=${encodeURIComponent(words[0] + ' zzqqxx')}`)).body.length, 0, 'every word must match');
  assert.equal((await call(`/api/transactions?q=${encodeURIComponent('%')}`)).body.length, 0, '% is literal');

  const byTag = (await call(`/api/transactions?tag=big-trip`)).body;
  assert.equal(byTag.length, 1);

  await call('/api/transactions/bulk', { method: 'POST', body: JSON.stringify({ ids: list.slice(0, 3).map((x) => x.id), addTags: 'reviewed' }) });
  assert.equal((await call('/api/transactions?tag=reviewed')).body.length, 3);
  // Bulk tag removal, on transactions that start untagged so other assertions aren't disturbed.
  const three = (await call('/api/transactions?untagged=1')).body.slice(0, 3).map((x) => x.id);
  assert.equal(three.length, 3);
  await call('/api/transactions/bulk', { method: 'POST', body: JSON.stringify({ ids: three, addTags: 'zz-gone, zz-temp, keep-me' }) });
  await call('/api/transactions/bulk', { method: 'POST', body: JSON.stringify({ ids: three, removeTags: 'zz-gone, zz-temp' }) });
  assert.equal((await call('/api/transactions?tag=zz-gone')).body.length, 0, 'bulk removeTags drops the listed tags');
  assert.equal((await call('/api/transactions?tag=zz-temp')).body.length, 0);
  assert.equal((await call('/api/transactions?tag=keep-me')).body.length, 3, 'other tags are kept');
  await call('/api/transactions/bulk', { method: 'POST', body: JSON.stringify({ ids: three, clearTags: true }) });
  assert.equal((await call('/api/transactions?tag=keep-me')).body.length, 0, 'clearTags removes every tag');

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

test('categories you set survive syncs; merchants are remembered for new transactions', async () => {
  const db = plaidDb();
  const mta = (id, date, extra = {}) => ptx(id, date, 2.9, { name: 'MTA*NYCT PAYGO', merchant_name: 'MTA',
    personal_finance_category: { primary: 'GENERAL_SERVICES', detailed: 'GENERAL_SERVICES_OTHER' }, ...extra });
  await syncAll(db, fakePlaid([{ added: [mta('m1', '2026-11-01'), mta('m2', '2026-11-02')], modified: [], removed: [], next_cursor: 'a', has_more: false }]));
  const get = (id) => db.prepare('SELECT * FROM transactions WHERE id=?').get(id);
  assert.equal(get('m1').category, 'Services');

  // You change m1 through the API path's helpers.
  const categories = require('../server/categories');
  const cat = categories.ensure(db, 'commute');
  assert.equal(cat, 'commute');
  assert.equal(categories.ensure(db, 'COMMUTE'), 'commute', 'case-insensitive reuse');
  db.prepare("UPDATE transactions SET category=?, category_manual=1, updated_at=datetime('now') WHERE id='m1'").run(cat);
  categories.learn(db, get('m1'), cat);
  assert.deepEqual(categories.similar(db, get('m1'), cat), ['m2']);

  // Plaid modifies m1 and sends a new MTA charge: m1 keeps your pick, the new one follows it, m2 is untouched.
  await syncAll(db, fakePlaid([{ added: [mta('m3', '2026-11-05')], modified: [mta('m1', '2026-11-01', { amount: 3.1 })], removed: [], next_cursor: 'b', has_more: false }]));
  assert.deepEqual([get('m1').category, get('m1').amount], ['commute', -3.1]);
  assert.equal(get('m3').category, 'commute');
  assert.equal(get('m2').category, 'Services');

  // A pending charge you edited is removed and re-posted under a new id with no link: edits move over.
  await syncAll(db, fakePlaid([{ added: [ptx('p1', '2026-11-06', 12, { pending: true, merchant_name: 'Deli' })], modified: [], removed: [], next_cursor: 'c', has_more: false }]));
  db.prepare("UPDATE transactions SET category='Lunch', category_manual=1, note='team', updated_at=datetime('now') WHERE id='p1'").run();
  await syncAll(db, fakePlaid([{ added: [ptx('p1-posted', '2026-11-07', 14.5, { merchant_name: 'Deli' })], modified: [], removed: [{ transaction_id: 'p1' }], next_cursor: 'd', has_more: false }]));
  assert.equal(get('p1'), undefined);
  assert.deepEqual([get('p1-posted').category, get('p1-posted').note, get('p1-posted').category_manual], ['Lunch', 'team', 1]);

  // Setting a merchant back to Uncategorized forgets it.
  categories.learn(db, get('m1'), 'Uncategorized');
  assert.equal(categories.ruleFor(db, get('m1')), null);
});

test('API: create, rename/merge, delete categories and apply to similar', async (t) => {
  const { server, port } = await start(0, { plaidClient: fakePlaid([]) });
  t.after(() => server.close());
  const call = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Budget-Buddy': '1' } });
    return { status: res.status, body: await res.json() };
  };
  await call('/api/demo', { method: 'POST' });
  const cats = (await call('/api/categories')).body.categories;
  assert.ok(cats.includes('Groceries') && cats.includes('Transfer') && cats.includes('Uncategorized'));

  assert.equal((await call('/api/categories', { method: 'POST', body: JSON.stringify({ name: '  Pet   Care ' }) })).body.name, 'Pet Care');
  assert.ok((await call('/api/categories')).body.categories.includes('Pet Care'), 'unused custom category still listed');
  assert.equal((await call('/api/categories', { method: 'POST', body: '{"name":"  "}' })).status, 400);

  const list = (await call('/api/transactions')).body;
  const tx = list.find((x) => x.counterparty && list.filter((y) => y.counterparty === x.counterparty).length > 1);
  const p = (await call(`/api/transactions/${tx.id}`, { method: 'PATCH', body: JSON.stringify({ category: 'pet care' }) })).body;
  assert.equal(p.category, 'Pet Care');
  assert.ok(p.similar >= 1);
  const applied = (await call(`/api/transactions/${tx.id}/apply-to-similar`, { method: 'POST' })).body;
  assert.equal(applied.updated, p.similar);
  const mgr = (await call('/api/categories/manage')).body;
  assert.equal(mgr.categories.find((c) => c.name === 'Pet Care').count, 1 + p.similar);
  assert.equal(mgr.rules.length, 1);

  await call('/api/budgets', { method: 'PUT', body: JSON.stringify({ category: 'Pet Care', monthly_limit: 50 }) });
  assert.equal((await call('/api/categories', { method: 'PATCH', body: JSON.stringify({ from: 'Pet Care', to: 'Pets' }) })).body.name, 'Pets');
  let m = (await call('/api/categories/manage')).body;
  assert.ok(!m.categories.some((c) => c.name === 'Pet Care'));
  assert.deepEqual([m.categories.find((c) => c.name === 'Pets').budget, m.rules[0].category], [50, 'Pets']);

  // Renaming onto an existing name merges.
  assert.equal((await call('/api/categories', { method: 'PATCH', body: JSON.stringify({ from: 'Pets', to: 'shopping' }) })).body.name, 'Shopping');
  assert.equal((await call('/api/categories', { method: 'PATCH', body: JSON.stringify({ from: 'Transfer', to: 'X' }) })).status, 400);

  const del = (await call('/api/categories?name=Shopping', { method: 'DELETE' })).body;
  assert.ok(del.moved >= 1);
  m = (await call('/api/categories/manage')).body;
  assert.ok(!m.categories.some((c) => c.name === 'Shopping'));
  assert.equal(m.rules.length, 0);
  assert.equal((await call('/api/categories?name=Uncategorized', { method: 'DELETE' })).status, 400);
});

test('API: exclude categories from totals', async (t) => {
  const { server, port } = await start(0, { plaidClient: fakePlaid([]) });
  t.after(() => server.close());
  const call = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Budget-Buddy': '1' } });
    return { status: res.status, body: await res.json() };
  };
  await call('/api/demo', { method: 'POST' });
  const month = new Date().toISOString().slice(0, 7);
  const before = (await call(`/api/summary?month=${month}`)).body;
  assert.deepEqual(before.excludedCategories, ['Transfer']);
  const cat = before.byCategory.find((c) => c.spent > 0 && c.count > 0);
  assert.ok(cat, 'demo month has spending');
  await call('/api/budgets', { method: 'PUT', body: JSON.stringify({ category: cat.category, monthly_limit: 999 }) });

  const r = (await call('/api/categories/exclude', { method: 'PUT', body: JSON.stringify({ name: cat.category.toLowerCase(), excluded: true }) })).body;
  assert.equal(r.name, cat.category, 'matches stored spelling');
  const after = (await call(`/api/summary?month=${month}`)).body;
  assert.ok(!after.byCategory.some((c) => c.category === cat.category), 'gone from by-category, budget row too');
  assert.ok(Math.abs(before.spending - cat.spent - after.spending) < 0.01, 'spending drops by that category');
  assert.equal(after.count, before.count - cat.count);
  assert.ok(after.excludedCategories.includes(cat.category));
  const mgr = (await call('/api/categories/manage')).body.categories;
  assert.equal(mgr.find((c) => c.name === cat.category).excluded, true);
  assert.deepEqual([mgr.find((c) => c.name === 'Transfer').excluded, mgr.find((c) => c.name === 'Transfer').excludeLocked], [true, true]);
  assert.ok((await call('/api/categories')).body.excluded.includes(cat.category));
  assert.ok((await call(`/api/transactions?category=${encodeURIComponent(cat.category)}`)).body.length > 0, 'transactions still listed');

  // Renaming keeps the setting.
  await call('/api/categories', { method: 'PATCH', body: JSON.stringify({ from: cat.category, to: 'Skipped Stuff' }) });
  assert.ok((await call(`/api/summary?month=${month}`)).body.excludedCategories.includes('Skipped Stuff'));

  await call('/api/categories/exclude', { method: 'PUT', body: JSON.stringify({ name: 'Skipped Stuff', excluded: false }) });
  assert.ok(Math.abs((await call(`/api/summary?month=${month}`)).body.spending - before.spending) < 0.01, 'counted again');
  assert.equal((await call('/api/categories/exclude', { method: 'PUT', body: JSON.stringify({ name: 'Transfer', excluded: false }) })).status, 400);
});

test('projections: pay schedules', () => {
  const { payDates } = require('../server/projections');
  assert.deepEqual(payDates({ frequency: 'biweekly', anchor: '2026-10-30' }, '2026-11-01', '2026-11-30'), ['2026-11-13', '2026-11-27']);
  assert.deepEqual(payDates({ frequency: 'weekly', anchor: '2026-11-06' }, '2026-11-12', '2026-11-30'), ['2026-11-13', '2026-11-20', '2026-11-27']);
  assert.deepEqual(payDates({ frequency: 'semimonthly', anchor: '2026-11-15', days: [15, 31] }, '2026-11-01', '2027-02-28'),
    ['2026-11-15', '2026-11-30', '2026-12-15', '2026-12-31', '2027-01-15', '2027-01-31', '2027-02-15', '2027-02-28']);
  assert.deepEqual(payDates({ frequency: 'monthly', anchor: '2026-10-31' }, '2026-11-01', '2027-02-28'), ['2026-11-30', '2026-12-31', '2027-01-31', '2027-02-28']);
});

test('projections: detects paychecks, adjusts them, projects month and year', async (t) => {
  const db = open(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-proj-')));
  db.prepare("INSERT INTO enrollments (id, provider, access_token) VALUES ('e', 'plaid', 'tok')").run();
  db.prepare("INSERT INTO accounts (id, enrollment_id, name, type, balance_available) VALUES ('chk', 'e', 'Checking', 'depository', '1000')").run();
  db.prepare("INSERT INTO accounts (id, enrollment_id, name, type, balance_available) VALUES ('card', 'e', 'Card', 'credit', '5000')").run();
  const add = db.prepare('INSERT INTO transactions (id, account_id, date, amount, description, counterparty, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
  let n = 0;
  // Biweekly $1,500 paychecks on Fridays, last one Oct 30; a one-off $50 refund-ish income from someone else.
  for (let d = Date.parse('2026-05-29T00:00:00Z'); d <= Date.parse('2026-11-12T00:00:00Z'); d += 14 * 86400000) {
    add.run(`p${n++}`, 'chk', new Date(d).toISOString().slice(0, 10), 1500, 'ACME PAYROLL', 'Acme', 'Income');
  }
  add.run('gift', 'chk', '2026-11-03', 50, 'ZELLE FROM MOM', 'Mom', 'Income');
  // Rent $1,000 on the 1st every month; groceries $300/month; this month: rent paid, $100 groceries.
  for (const m of ['07', '08', '09', '10', '11']) add.run(`r${m}`, 'chk', `2026-${m}-01`, -1000, 'RENT', 'Landlord', 'Home');
  for (const m of ['08', '09', '10']) add.run(`g${m}`, 'card', `2026-${m}-10`, -300, 'GROCER', 'Grocer', 'Groceries');
  add.run('g11', 'card', '2026-11-05', -100, 'GROCER', 'Grocer', 'Groceries');
  add.run('xfer', 'chk', '2026-11-06', -400, 'CARD PAYMENT', 'Bank', 'Transfer');

  const { project, saveStream, addStream } = require('../server/projections');
  const { summaryFor } = require('../server').__test;
  const run = (period) => project(db, { period, today: '2026-11-12' }, summaryFor);

  let p = run('month');
  const [pay] = p.income.streams;
  assert.equal(p.income.streams.length, 1, 'one-off income is not a paycheck');
  assert.deepEqual([pay.name, pay.frequency, pay.amount, pay.nextDate], ['Acme', 'biweekly', 1500, '2026-11-13']);
  assert.deepEqual(pay.expectedDates, ['2026-11-13', '2026-11-27']);
  assert.equal(p.income.soFar, 50, 'no paycheck yet this month, just the $50');
  assert.equal(p.income.expected, 3000);
  assert.equal(p.spending.soFar, 1100, 'transfers left out');
  assert.equal(p.leftToSpend, 50 + 3000 - 1100);
  const home = p.byCategory.find((c) => c.category === 'Home');
  const groc = p.byCategory.find((c) => c.category === 'Groceries');
  assert.deepEqual([home.typical, home.remaining], [1000, 0], 'rent already paid this month is not projected again');
  assert.deepEqual([groc.typical, groc.remaining], [300, 200]);
  assert.equal(p.balance.end, 1000 + 3000 - 200);
  assert.equal(p.weekEnd, '2026-11-15');
  assert.equal(p.balance.week, round(1000 + 1500 - 200 * 4 / 19));

  // Budgets replace "usual" spending; a budget below your usual pace isn't flagged.
  db.prepare("INSERT INTO budgets VALUES ('Groceries', 250)").run();
  p = run('month');
  const g2 = p.byCategory.find((c) => c.category === 'Groceries');
  assert.deepEqual([g2.budget, g2.remaining, g2.status], [250, 150, 'ok']);

  // Your changes: amount and frequency; null goes back to detected.
  saveStream(db, { key: pay.key, amount: 1800, frequency: 'weekly' });
  p = run('month');
  assert.deepEqual(p.income.streams[0].expectedDates, ['2026-11-13', '2026-11-20', '2026-11-27']);
  assert.equal(p.income.expected, 5400);
  saveStream(db, { key: pay.key, amount: null, frequency: null, enabled: false });
  p = run('month');
  assert.deepEqual([p.income.streams[0].amount, p.income.expected], [1500, 0]);
  saveStream(db, { key: pay.key, enabled: true });
  addStream(db, { name: 'Side gig', amount: 200, frequency: 'monthly', next_date: '2026-11-20' });

  p = run('year');
  assert.equal(p.income.streams.length, 2);
  assert.deepEqual(p.income.streams[0].expectedDates, ['2026-11-13', '2026-11-27', '2026-12-11', '2026-12-25']);
  assert.deepEqual(p.income.streams[1].expectedDates, ['2026-11-20', '2026-12-20']);
  assert.equal(p.income.expected, 6400);
  const homeY = p.byCategory.find((c) => c.category === 'Home');
  assert.deepEqual([homeY.spent, homeY.remaining], [5000, 1000], 'December rent still to come');
  const gY = p.byCategory.find((c) => c.category === 'Groceries');
  assert.deepEqual([gY.budget, gY.remaining], [3000, 400]);
  assert.equal(p.to, '2026-12-31');
  assert.throws(() => saveStream(db, { key: pay.key, frequency: 'daily' }), /frequency/);

  function round(x) { return Math.round(x * 100) / 100; }
});

test('projections: paychecks that change size (hours, overtime, holiday pay)', () => {
  const { payStats } = require('../server/projections');
  const steady = payStats([1500, 1500, 1500, 1500]);
  assert.equal(steady.variable, false);
  const v = payStats([1000, 1200, 1100, 1900, 1000, 1200]); // one holiday/overtime week
  assert.equal(v.variable, true);
  assert.deepEqual(v.estimates, { average: 1233.33, recent: 1300, median: 1150, low: 1025, last: 1200 });
  assert.deepEqual([v.low, v.high, v.min, v.max], [1025, 1200, 1000, 1900]);

  const db = open(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-var-')));
  db.prepare("INSERT INTO enrollments (id, provider, access_token) VALUES ('e', 'plaid', 'tok')").run();
  db.prepare("INSERT INTO accounts (id, enrollment_id, name, type, balance_available) VALUES ('chk', 'e', 'Checking', 'depository', '500')").run();
  const add = db.prepare('INSERT INTO transactions (id, account_id, date, amount, description, counterparty, category) VALUES (?, ?, ?, ?, ?, ?, ?)');
  // Weekly hourly paychecks on Fridays: mostly $800–$900, a holiday week of $1,300.
  const amounts = [800, 850, 900, 820, 880, 1300, 840, 860];
  let d = Date.parse('2026-09-18T00:00:00Z');
  amounts.forEach((a, i) => { add.run(`w${i}`, 'chk', new Date(d).toISOString().slice(0, 10), a, 'SHOP PAYROLL', 'Shop', 'Income'); d += 7 * 86400000; });
  const { project, saveStream } = require('../server/projections');
  const { summaryFor } = require('../server').__test;
  const run = () => project(db, { period: 'month', today: '2026-11-12' }, summaryFor);

  let p = run();
  let [s] = p.income.streams;
  assert.deepEqual([s.frequency, s.variable, s.estimate, s.nextDate], ['weekly', true, 'average', '2026-11-13']);
  assert.equal(s.amount, 906.25, '6-month average by default');
  assert.deepEqual(s.expectedDates, ['2026-11-13', '2026-11-20', '2026-11-27']);
  assert.equal(p.income.expected, round(906.25 * 3));
  assert.deepEqual(s.range, { low: 835, high: 885 });
  assert.deepEqual(p.income.range && [p.income.range.low, p.income.range.high], [2505, 2655]);
  assert.deepEqual(p.balance.endRange, { low: 500 + 2505, high: 500 + 2655 });

  saveStream(db, { key: s.key, estimate: 'median' });
  s = run().income.streams[0];
  assert.deepEqual([s.estimate, s.amount, s.changed.estimate], ['median', 855, true]);
  saveStream(db, { key: s.key, estimate: 'low' });
  assert.equal(run().income.streams[0].amount, 835);
  // Typing an amount wins, and there's no range around a number you chose.
  saveStream(db, { key: s.key, amount: 1000 });
  p = run();
  s = p.income.streams[0];
  assert.deepEqual([s.estimate, s.amount, s.range, p.income.range], ['custom', 1000, null, null]);
  saveStream(db, { key: s.key, amount: null, estimate: 'last' });
  assert.equal(run().income.streams[0].amount, 860);
  saveStream(db, { key: s.key, estimate: null });
  assert.equal(run().income.streams[0].estimate, 'average', 'null goes back to the default');
  assert.throws(() => saveStream(db, { key: s.key, estimate: 'guess' }), /estimate/);

  function round(x) { return Math.round(x * 100) / 100; }
});

test('API: projections and income streams', async (t) => {
  const { server, port } = await start(0, { plaidClient: fakePlaid([]) });
  t.after(() => server.close());
  const call = async (p, opts = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, { ...opts, headers: { 'Content-Type': 'application/json', 'X-Budget-Buddy': '1' } });
    return { status: res.status, body: await res.json() };
  };
  await call('/api/demo', { method: 'POST' });
  const today = new Date().toISOString().slice(0, 10);
  const m = (await call(`/api/projections?period=month&today=${today}`)).body;
  assert.equal(m.period, 'month');
  const acme = m.income.streams.find((s) => s.name === 'Acme Corp');
  assert.equal(acme.frequency, 'semimonthly');
  assert.equal(acme.amount, 2650);
  assert.ok(Math.abs(m.leftToSpend - (m.income.projected - m.spending.soFar)) < 0.01);
  assert.equal(m.cash.total, 3245.18, 'checking only, not the credit card');
  const y = (await call(`/api/projections?period=year&today=${today}`)).body;
  assert.equal(y.to.slice(5), '12-31');
  assert.ok(y.income.expected >= m.income.expected);

  assert.equal((await call('/api/income-streams', { method: 'PUT', body: JSON.stringify({ key: acme.key, amount: 3000 }) })).status, 200);
  assert.equal((await call(`/api/projections?today=${today}`)).body.income.streams.find((s) => s.key === acme.key).amount, 3000);
  assert.equal((await call(`/api/income-streams?key=${encodeURIComponent(acme.key)}`, { method: 'DELETE' })).status, 200);
  assert.equal((await call(`/api/projections?today=${today}`)).body.income.streams.find((s) => s.key === acme.key).amount, 2650, 'reset');
  const added = (await call('/api/income-streams', { method: 'POST', body: JSON.stringify({ name: 'Bonus', amount: 500, frequency: 'monthly' }) })).body;
  assert.ok(added.key.startsWith('manual:'));
  assert.equal((await call('/api/income-streams', { method: 'PUT', body: JSON.stringify({ key: added.key, amount: -5 }) })).status, 400);

  // Leaving an account out of Projections drops its balance, paychecks and spending there only.
  const chk = m.accounts.find((a) => a.type === 'depository');
  assert.ok(m.accounts.every((a) => a.included), 'every account counts by default');
  assert.equal((await call(`/api/accounts/${chk.id}`, { method: 'PATCH', body: JSON.stringify({ in_projections: false }) })).status, 200);
  const off = (await call(`/api/projections?today=${today}`)).body;
  assert.equal(off.accounts.find((a) => a.id === chk.id).included, false);
  assert.ok(!off.cash.accounts.some((a) => a.name === chk.name), 'its balance is left out');
  assert.ok(!off.income.streams.some((s) => s.name === 'Acme Corp'), 'its paychecks are left out');
  assert.ok(off.spending.soFar <= m.spending.soFar);
  const from = today.slice(0, 8) + '01';
  const dash = (await call(`/api/summary?from=${from}&to=${today}`)).body;
  assert.ok(Math.abs(dash.spending - m.spending.soFar) < 0.01, 'the Dashboard still counts every account');
  await call(`/api/accounts/${chk.id}`, { method: 'PATCH', body: JSON.stringify({ in_projections: true }) });
  assert.ok(Math.abs((await call(`/api/projections?today=${today}`)).body.cash.total - 3245.18) < 0.01, 'back in');
});
