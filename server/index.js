'use strict';
// Budget Buddy local server: serves the UI and a small JSON API on 127.0.0.1 only.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const config = require('./config');
const { open } = require('./db');
const plaid = require('./plaid');
const { syncAll } = require('./sync');
const { postToSheet } = require('./sheets');
const demo = require('./demo');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

// ---------- helpers ----------
const AMT = 'CASE WHEN a.invert_sign=1 THEN -t.amount ELSE t.amount END';

function normTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  return [...new Set(list.map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')).filter(Boolean))].join(',');
}

function monthRange(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) return null;
  const [y, m] = month.split('-').map(Number);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return [`${month}-01`, end];
}

function send(res, status, body, headers = {}) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  res.writeHead(status, { 'Content-Type': isStr ? 'text/plain' : 'application/json', ...headers });
  res.end(isStr ? body : JSON.stringify(body));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 5e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// ---------- queries ----------
function queryTransactions(db, q) {
  const where = ['a.hidden=0'];
  const params = [];
  const range = monthRange(q.month);
  if (range) {
    where.push('t.date BETWEEN ? AND ?');
    params.push(...range);
  }
  if (q.account) {
    where.push('t.account_id=?');
    params.push(q.account);
  }
  if (q.category) {
    where.push('t.category=?');
    params.push(q.category);
  }
  if (q.tag) {
    where.push("(',' || t.tags || ',') LIKE ?");
    params.push(`%,${normTags(q.tag)},%`);
  }
  if (q.q) {
    where.push('(t.description LIKE ? OR t.counterparty LIKE ? OR t.note LIKE ? OR t.tags LIKE ?)');
    const like = `%${q.q}%`;
    params.push(like, like, like, like);
  }
  if (q.untagged === '1') where.push("t.tags=''");
  return db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, a.institution, t.date, ${AMT} AS amount,
              t.description, t.counterparty, t.bank_category, t.type, t.status, t.category,
              t.tags, t.note, t.exclude
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC
       LIMIT 5000`
    )
    .all(...params);
}

function summary(db, month) {
  const range = monthRange(month);
  if (!range) throw Object.assign(new Error('month must be YYYY-MM'), { status: 400 });
  const base = `FROM transactions t JOIN accounts a ON a.id=t.account_id
    WHERE a.hidden=0 AND t.exclude=0 AND t.category<>'Transfer' AND t.date BETWEEN ? AND ?`;
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN ${AMT}>0 THEN ${AMT} END),0) AS income,
              COALESCE(SUM(CASE WHEN ${AMT}<0 THEN -${AMT} END),0) AS spending,
              COUNT(*) AS count ${base}`
    )
    .get(...range);
  const byCategory = db
    .prepare(
      `SELECT t.category, SUM(-${AMT}) AS spent, COUNT(*) AS count ${base} AND ${AMT}<0
       GROUP BY t.category ORDER BY spent DESC`
    )
    .all(...range);
  const budgets = Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map((b) => [b.category, b.monthly_limit]));
  const seen = new Set(byCategory.map((c) => c.category));
  for (const cat of Object.keys(budgets)) if (!seen.has(cat)) byCategory.push({ category: cat, spent: 0, count: 0 });
  for (const c of byCategory) c.budget = budgets[c.category] ?? null;

  const byTag = {};
  for (const row of db.prepare(`SELECT t.tags, ${AMT} AS amt ${base} AND t.tags<>''`).all(...range)) {
    for (const tag of row.tags.split(',')) {
      byTag[tag] = byTag[tag] || { tag, spent: 0, count: 0 };
      byTag[tag].spent += row.amt < 0 ? -row.amt : 0;
      byTag[tag].count++;
    }
  }
  const daily = db
    .prepare(`SELECT t.date, SUM(-${AMT}) AS spent ${base} AND ${AMT}<0 GROUP BY t.date ORDER BY t.date`)
    .all(...range);
  return {
    month,
    income: totals.income,
    spending: totals.spending,
    net: totals.income - totals.spending,
    count: totals.count,
    byCategory,
    byTag: Object.values(byTag).sort((a, b) => b.spent - a.spent),
    daily,
  };
}

// ---------- app ----------
// opts.plaidClient lets tests swap in a fake Plaid client.
function createApp(opts = {}) {
  config.ensureDataDir();
  const db = open(config.DATA_DIR);
  let syncing = null;
  const plaidClient = () => opts.plaidClient || plaid.createClient(config.load());
  const mask = (c) => ({ ...c, sheetsSecret: c.sheetsSecret ? '••••••' : '', plaidSecret: c.plaidSecret ? '••••••' : '' });

  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  route('GET', /^\/api\/config$/, () => mask(config.load()));
  route('PUT', /^\/api\/config$/, async (req) => {
    const body = await readJson(req);
    if (body.sheetsSecret === '••••••') delete body.sheetsSecret;
    if (body.plaidSecret === '••••••') delete body.plaidSecret;
    return mask(config.save(body));
  });

  route('GET', /^\/api\/enrollments$/, () =>
    db.prepare('SELECT id, provider, institution, status, last_error, last_synced_at, created_at FROM enrollments').all()
  );
  // Step 1 of Plaid Link: a short-lived link token. With enrollmentId it opens "update mode" to fix a login.
  route('POST', /^\/api\/plaid\/link-token$/, async (req) => {
    const b = await readJson(req);
    let token;
    if (b.enrollmentId) {
      const en = db.prepare("SELECT access_token FROM enrollments WHERE id=? AND provider='plaid'").get(b.enrollmentId);
      if (!en) throw Object.assign(new Error('Unknown bank connection'), { status: 404 });
      token = en.access_token;
    }
    const r = await plaidClient().createLinkToken(token);
    return { link_token: r.link_token };
  });
  // Step 2: Link's onSuccess hands us a public token, which we swap for a permanent access token.
  route('POST', /^\/api\/enrollments$/, async (req) => {
    const b = await readJson(req);
    if (!b.public_token) throw Object.assign(new Error('public_token missing'), { status: 400 });
    const r = await plaidClient().exchangePublicToken(b.public_token);
    const institution = (b.institution && b.institution.name) || null;
    db.prepare(
      `INSERT INTO enrollments (id, provider, access_token, institution) VALUES (?, 'plaid', ?, ?)
       ON CONFLICT(id) DO UPDATE SET access_token=excluded.access_token, institution=COALESCE(excluded.institution, institution),
         status='ok', last_error=NULL`
    ).run(r.item_id, r.access_token, institution);
    return { id: r.item_id };
  });
  // After update mode succeeds the access token is unchanged; just clear the error.
  route('POST', /^\/api\/enrollments\/([\w-]+)\/reconnected$/, (req, m) => {
    db.prepare("UPDATE enrollments SET status='ok', last_error=NULL WHERE id=?").run(m[1]);
    return { ok: true };
  });
  route('DELETE', /^\/api\/enrollments\/([\w-]+)$/, async (req, m) => {
    const en = db.prepare('SELECT provider, access_token FROM enrollments WHERE id=?').get(m[1]);
    if (en && en.provider === 'plaid') {
      // Tell Plaid to stop syncing (and billing) this bank. Don't block removal if it fails.
      try { await plaidClient().removeItem(en.access_token); } catch {}
    }
    db.prepare('DELETE FROM enrollments WHERE id=?').run(m[1]);
    return { ok: true };
  });

  route('GET', /^\/api\/accounts$/, () =>
    db
      .prepare(
        `SELECT a.*, e.status AS enrollment_status, e.last_synced_at,
                (SELECT COUNT(*) FROM transactions t WHERE t.account_id=a.id) AS tx_count
         FROM accounts a LEFT JOIN enrollments e ON e.id=a.enrollment_id ORDER BY a.institution, a.name`
      )
      .all()
  );
  route('PATCH', /^\/api\/accounts\/([\w-]+)$/, async (req, m) => {
    const b = await readJson(req);
    if (b.invert_sign !== undefined) db.prepare('UPDATE accounts SET invert_sign=? WHERE id=?').run(b.invert_sign ? 1 : 0, m[1]);
    if (b.hidden !== undefined) db.prepare('UPDATE accounts SET hidden=? WHERE id=?').run(b.hidden ? 1 : 0, m[1]);
    return { ok: true };
  });

  route('POST', /^\/api\/sync$/, async () => {
    if (!syncing) {
      const hasPlaid = db.prepare("SELECT 1 FROM enrollments WHERE provider='plaid' LIMIT 1").get();
      if (!hasPlaid) return { results: [] };
      syncing = syncAll(db, plaidClient()).finally(() => (syncing = null));
    }
    return { results: await syncing };
  });

  route('GET', /^\/api\/transactions$/, (req, m, url) => queryTransactions(db, Object.fromEntries(url.searchParams)));
  route('PATCH', /^\/api\/transactions\/([\w-]+)$/, async (req, m) => {
    const b = await readJson(req);
    const sets = [];
    const params = [];
    if (b.category !== undefined) sets.push('category=?') && params.push(String(b.category).trim() || 'Uncategorized');
    if (b.tags !== undefined) sets.push('tags=?') && params.push(normTags(b.tags));
    if (b.note !== undefined) sets.push('note=?') && params.push(String(b.note));
    if (b.exclude !== undefined) sets.push('exclude=?') && params.push(b.exclude ? 1 : 0);
    if (!sets.length) return { ok: true };
    db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...params, m[1]);
    return db.prepare('SELECT id, category, tags, note, exclude FROM transactions WHERE id=?').get(m[1]);
  });
  route('POST', /^\/api\/transactions\/bulk$/, async (req) => {
    const b = await readJson(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const get = db.prepare('SELECT tags FROM transactions WHERE id=?');
    const setTags = db.prepare(`UPDATE transactions SET tags=?, updated_at=datetime('now') WHERE id=?`);
    const setCat = db.prepare(`UPDATE transactions SET category=?, updated_at=datetime('now') WHERE id=?`);
    db.exec('BEGIN');
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      if (b.addTags) setTags.run(normTags(`${row.tags},${b.addTags}`), id);
      if (b.removeTag) setTags.run(normTags(row.tags.split(',').filter((t) => t !== normTags(b.removeTag))), id);
      if (b.category) setCat.run(String(b.category).trim(), id);
    }
    db.exec('COMMIT');
    return { updated: ids.length };
  });

  route('GET', /^\/api\/categories$/, () => {
    const cats = db.prepare("SELECT DISTINCT category FROM transactions WHERE category IS NOT NULL").all().map((r) => r.category);
    const tags = new Set();
    for (const r of db.prepare("SELECT tags FROM transactions WHERE tags<>''").all()) r.tags.split(',').forEach((t) => tags.add(t));
    const budgets = db.prepare('SELECT * FROM budgets ORDER BY category').all();
    const all = new Set([...cats, ...budgets.map((b) => b.category), 'Transfer', 'Uncategorized']);
    return { categories: [...all].sort(), tags: [...tags].sort(), budgets };
  });
  route('PUT', /^\/api\/budgets$/, async (req) => {
    const b = await readJson(req);
    const limit = Number(b.monthly_limit);
    if (!b.category) throw Object.assign(new Error('category required'), { status: 400 });
    if (!limit || limit <= 0) db.prepare('DELETE FROM budgets WHERE category=?').run(b.category);
    else db.prepare('INSERT INTO budgets VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit=excluded.monthly_limit').run(b.category, limit);
    return { ok: true };
  });

  route('GET', /^\/api\/summary$/, (req, m, url) => summary(db, url.searchParams.get('month')));

  route('GET', /^\/api\/export\.csv$/, (req, m, url) => {
    const rows = queryTransactions(db, Object.fromEntries(url.searchParams));
    const head = ['Date', 'Description', 'Counterparty', 'Amount', 'Category', 'Tags', 'Note', 'Account', 'Status', 'Excluded'];
    const lines = [head.join(',')].concat(
      rows.map((r) =>
        [r.date, r.description, r.counterparty, r.amount.toFixed(2), r.category, r.tags.replace(/,/g, ' '), r.note,
          `${r.institution || ''} ${r.account_name || ''}`.trim(), r.status, r.exclude ? 'yes' : '']
          .map(csvCell).join(',')
      )
    );
    const name = `budget-buddy-${url.searchParams.get('month') || 'all'}.csv`;
    return { __raw: lines.join('\n'), headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${name}"` } };
  });
  route('POST', /^\/api\/export\/sheets$/, async (req) => {
    const b = await readJson(req);
    const c = config.load();
    if (!c.sheetsWebhookUrl) throw Object.assign(new Error('Add your Google Sheets web app URL in Settings first.'), { status: 400 });
    const month = b.month;
    const tx = queryTransactions(db, { month });
    const s = month ? summary(db, month) : null;
    const result = await postToSheet(c.sheetsWebhookUrl, {
      secret: c.sheetsSecret,
      month: month || 'all',
      transactions: tx.map((r) => ({
        date: r.date, description: r.description, counterparty: r.counterparty, amount: r.amount,
        category: r.category, tags: r.tags, note: r.note, account: `${r.institution || ''} ${r.account_name || ''}`.trim(),
        status: r.status, excluded: !!r.exclude, id: r.id,
      })),
      summary: s && { income: s.income, spending: s.spending, net: s.net, byCategory: s.byCategory, byTag: s.byTag },
    });
    return { ok: true, rows: tx.length, url: result.url };
  });

  route('POST', /^\/api\/demo$/, () => demo.load(db));

  async function handle(req, res) {
    // Only answer requests addressed to this machine (blocks DNS-rebinding).
    const host = (req.headers.host || '').split(':')[0];
    if (!['127.0.0.1', 'localhost'].includes(host)) return send(res, 403, 'Forbidden');
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.startsWith('/api/')) {
      // Custom header on writes => other websites can't post here without a CORS preflight we never approve.
      if (req.method !== 'GET' && req.headers['x-budget-buddy'] !== '1') return send(res, 403, { error: 'Missing app header' });
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.pattern);
        if (!m) continue;
        try {
          const out = await r.handler(req, m, url);
          if (out && out.__raw !== undefined) return send(res, 200, out.__raw, out.headers);
          return send(res, 200, out);
        } catch (e) {
          return send(res, e.status || (e instanceof plaid.PlaidError ? 502 : 500), { error: e.message, code: e.code });
        }
      }
      return send(res, 404, { error: 'Not found' });
    }

    const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, 'Forbidden');
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found');
      send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    });
  }

  return { handle, db };
}

function start(port = Number(process.env.PORT) || 4757, opts) {
  const app = createApp(opts);
  const server = http.createServer(app.handle);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve({ server, port: server.address().port, app }));
  });
}

module.exports = { start, createApp };

if (require.main === module) {
  start()
    .then(({ port }) => {
      console.log(`\n  Budget Buddy running at http://localhost:${port}`);
      console.log(`  Data folder: ${config.DATA_DIR}\n`);
    })
    .catch((e) => {
      console.error(e.code === 'EADDRINUSE' ? 'Port already in use — is Budget Buddy already running? (set PORT=xxxx to change)' : e);
      process.exit(1);
    });
}
