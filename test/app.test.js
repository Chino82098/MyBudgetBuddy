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
