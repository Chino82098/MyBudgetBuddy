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
const { start } = require('../server');

function tx(id, date, amount, extra = {}) {
  return { id, account_id: 'acc_1', date, amount: String(amount), description: `DESC ${id}`, status: 'posted', type: 'card_payment',
    details: { category: 'dining', counterparty: { name: 'Cafe', type: 'organization' } }, running_balance: null, ...extra };
}

function fakeClient(pages) {
  const calls = [];
  return {
    calls,
    listAccounts: async () => [{ id: 'acc_1', name: 'Checking', institution: { name: 'Bank' }, type: 'depository', subtype: 'checking',
      last_four: '1111', currency: 'USD', status: 'open', links: { balances: 'x', transactions: 'y' } }],
    getBalances: async () => ({ available: '100.00', ledger: '120.00' }),
    listTransactions: async (token, acc, q) => { calls.push(q); return pages.shift() || []; },
  };
}

test('sync paginates, preserves user edits, and drops replaced pending txns', async () => {
  const db = open(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-db-')));
  db.prepare("INSERT INTO enrollments (id, access_token) VALUES ('enr_1', 'tok')").run();

  const page1 = Array.from({ length: 250 }, (_, i) => tx(`t${i}`, '2026-10-15', -5));
  const page2 = [tx('pend', '2026-10-01', -9, { status: 'pending' }), tx('xfer', '2026-10-01', -100, { type: 'transfer' })];
  let client = fakeClient([page1, page2]);
  let [r] = await syncAll(db, client);
  assert.equal(r.error, undefined);
  assert.equal(r.transactions, 252);
  assert.equal(client.calls[1].from_id, 't249');
  assert.equal(db.prepare("SELECT category FROM transactions WHERE id='xfer'").get().category, 'Transfer');
  assert.equal(db.prepare("SELECT category FROM transactions WHERE id='t1'").get().category, 'Dining');
  assert.equal(db.prepare("SELECT balance_available FROM accounts WHERE id='acc_1'").get().balance_available, '100.00');

  db.prepare("UPDATE transactions SET tags='coffee', note='hi', category='Treats' WHERE id='t1'").run();

  // Second sync: incremental, pending txn gone (posted under new id), t1 amount changed.
  client = fakeClient([[tx('t1', '2026-10-15', -6), tx('posted', '2026-10-02', -9)]]);
  [r] = await syncAll(db, client);
  assert.equal(client.calls[0].start_date, '2026-10-01'); // newest 10-15 minus 14 days
  const t1 = db.prepare("SELECT * FROM transactions WHERE id='t1'").get();
  assert.deepEqual([t1.tags, t1.note, t1.category, t1.amount], ['coffee', 'hi', 'Treats', -6]);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM transactions WHERE id='pend'").get().c, 0);
});

test('sync records disconnected enrollments', async () => {
  const db = open(fs.mkdtempSync(path.join(os.tmpdir(), 'bb-db-')));
  db.prepare("INSERT INTO enrollments (id, access_token) VALUES ('enr_1', 'tok')").run();
  const client = { listAccounts: async () => { throw Object.assign(new Error('Reconnect needed'), { code: 'enrollment.disconnected.credentials_invalid' }); } };
  const [r] = await syncAll(db, client);
  assert.match(r.error, /Reconnect/);
  assert.equal(db.prepare('SELECT status FROM enrollments').get().status, 'disconnected');
});

test('API: demo data, summary, edits, bulk, csv, security', async (t) => {
  const { server, port } = await start(0);
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
  const cfg = await call('/api/config', { method: 'PUT', body: JSON.stringify({ tellerApplicationId: 'app_123', sheetsSecret: 'shh' }) });
  assert.equal(cfg.body.sheetsSecret, '••••••');
  const sync = await call('/api/sync', { method: 'POST' });
  assert.deepEqual(sync.body.results, [], 'demo enrollment is not synced');
});
