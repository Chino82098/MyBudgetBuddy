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
const categories = require('./categories');
const projections = require('./projections');

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

// A date range from ?from=YYYY-MM-DD&to=YYYY-MM-DD, falling back to ?month=YYYY-MM.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function dateRange(q) {
  const ok = (d) => DATE_RE.test(d || '') && !Number.isNaN(Date.parse(d + 'T00:00:00Z'));
  if (ok(q.from) && ok(q.to)) return q.from <= q.to ? [q.from, q.to] : [q.to, q.from];
  return monthRange(q.month);
}

const DAY = 86400000;
const utc = (d) => Date.parse(d + 'T00:00:00Z');
const daysBetween = (from, to) => Math.round((utc(to) - utc(from)) / DAY) + 1;

// How many months of budget a range covers: a whole month counts 1, a partial month its share of days.
function budgetMonths([from, to]) {
  let total = 0;
  let [y, m] = from.split('-').map(Number);
  for (;;) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`;
    if (first > to) break;
    const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    const start = from > first ? from : first;
    const end = to < last ? to : last;
    total += daysBetween(start, end) / Number(last.slice(8));
    if (++m > 12) { m = 1; y++; }
  }
  return Math.round(total * 100) / 100;
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

// ---------- spreading a payment over several months ----------
// A transaction with spread_months = N > 1 (e.g. 6 months of car insurance paid up front) counts as N equal
// monthly parts in totals, budgets, charts and Projections: one part in its own month, one in each month after,
// on the same day of the month (or the month's last day). Cents left over from rounding go on the last part.
// Used in place of "transactions t" anywhere amounts are added up. paid_date / paid_amount are the original.
const SPREAD_MAX = 60;
const TX_EFFECTIVE = `(
  WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${SPREAD_MAX - 1})
  SELECT id, account_id, category, tags, exclude, description, counterparty, date, amount,
         date AS paid_date, amount AS paid_amount, 1 AS part, 1 AS spread_months
  FROM transactions WHERE COALESCE(spread_months, 1) <= 1
  UNION ALL
  SELECT t.id, t.account_id, t.category, t.tags, t.exclude, t.description, t.counterparty,
         date(t.date, 'start of month', '+' || n.i || ' months',
              '+' || (MIN(CAST(strftime('%d', t.date) AS INTEGER),
                          CAST(strftime('%d', t.date, 'start of month', '+' || (n.i + 1) || ' months', '-1 day') AS INTEGER)) - 1) || ' days'),
         CASE WHEN n.i < t.spread_months - 1 THEN ROUND(t.amount / t.spread_months, 2)
              ELSE ROUND(t.amount - ROUND(t.amount / t.spread_months, 2) * (t.spread_months - 1), 2) END,
         t.date, t.amount, n.i + 1, t.spread_months
  FROM transactions t JOIN n ON n.i < t.spread_months
  WHERE t.spread_months > 1
)`;

// 1 (count once) .. SPREAD_MAX months; null if not a whole number in range.
function spreadMonths(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= SPREAD_MAX ? n : null;
}

// ---------- queries ----------
function parseAmount(input) {
  const raw = String(input ?? '').replace(/[$,\s]/g, '').replace(/^[-+]/, '');
  if (!/^\d+(\.\d{0,2})?$|^\.\d{1,2}$/.test(raw)) return null;
  const exact = raw.includes('.') && !raw.endsWith('.');
  return { value: exact ? Math.round(Number(raw) * 100) / 100 : Math.floor(Number(raw)), exact };
}

function queryTransactions(db, q) {
  const where = ['a.hidden=0'];
  const params = [];
  const range = dateRange(q);
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
  // Text search: every word must appear somewhere (description, merchant, note or tags), in any order.
  // "zelle spotlight" finds "Zelle payment from SPOTLIGHT ...". Matching is case-insensitive.
  for (const word of String(q.q || '').trim().split(/\s+/).filter(Boolean)) {
    where.push(
      "(t.description LIKE ? ESCAPE '\\' OR t.counterparty LIKE ? ESCAPE '\\' OR t.note LIKE ? ESCAPE '\\' OR t.tags LIKE ? ESCAPE '\\')"
    );
    const like = `%${word.replace(/[\\%_]/g, (c) => '\\' + c)}%`;
    params.push(like, like, like, like);
  }
  // Amount: "45.23" matches that exact amount, "45" matches $45.00–$45.99. Sign is ignored (spend or income).
  const amt = parseAmount(q.amount);
  if (amt) {
    if (amt.exact) {
      where.push('ABS(ABS(t.amount) - ?) < 0.005');
      params.push(amt.value);
    } else {
      where.push('ABS(t.amount) >= ? AND ABS(t.amount) < ?');
      params.push(amt.value, amt.value + 1);
    }
  }
  if (q.untagged === '1') where.push("t.tags=''");
  return db
    .prepare(
      `SELECT t.id, t.account_id, a.name AS account_name, a.institution, t.date, ${AMT} AS amount,
              t.description, t.counterparty, t.bank_category, t.type, t.status, t.category,
              t.tags, t.note, t.exclude, COALESCE(t.spread_months, 1) AS spread_months
       FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE ${where.join(' AND ')}
       ORDER BY t.date DESC, t.id DESC
       LIMIT 5000`
    )
    .all(...params);
}

// q: { month: 'YYYY-MM' } or { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
function summary(db, q) {
  if (typeof q === 'string') q = { month: q };
  const dates = dateRange(q);
  if (!dates) throw Object.assign(new Error('month (YYYY-MM) or from/to (YYYY-MM-DD) required'), { status: 400 });
  const months = budgetMonths(dates);
  // Left out: hidden accounts (and, for Projections, accounts you left out there), rows with Skip ticked, Transfer and any category you've excluded.
  const skipCats = categories.excluded(db);
  // Spread payments count only the parts that fall in this range (see TX_EFFECTIVE).
  const base = `FROM ${TX_EFFECTIVE} t JOIN accounts a ON a.id=t.account_id
    WHERE a.hidden=0${q.projection === true ? ' AND a.in_projections=1' : ''} AND t.exclude=0 AND t.category IS NOT NULL
      AND t.category NOT IN (${skipCats.map(() => '?').join(',')}) AND t.date BETWEEN ? AND ?`;
  const range = [...skipCats, ...dates]; // the base query's parameters, in order
  // Income = only rows categorized Income. Everything else counts toward spending,
  // so refunds/returns (positive amounts in other categories) lower spending.
  const totals = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN t.category='Income' THEN ${AMT} END),0) AS income,
              COALESCE(SUM(CASE WHEN t.category<>'Income' THEN -${AMT} END),0) AS spending,
              COUNT(*) AS count ${base}`
    )
    .get(...range);
  const byCategory = db
    .prepare(
      `SELECT t.category, SUM(-${AMT}) AS spent, COUNT(*) AS count ${base} AND t.category<>'Income'
       GROUP BY t.category HAVING ABS(SUM(-${AMT})) >= 0.005 ORDER BY spent DESC`
    )
    .all(...range);
  const budgets = Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map((b) => [b.category, b.monthly_limit]));
  const seen = new Set(byCategory.map((c) => c.category));
  for (const cat of Object.keys(budgets)) if (!seen.has(cat) && !skipCats.includes(cat)) byCategory.push({ category: cat, spent: 0, count: 0 });
  // Budgets are monthly; scale them to the length of the range (a year = 12x).
  for (const c of byCategory) c.budget = budgets[c.category] != null ? Math.round(budgets[c.category] * months * 100) / 100 : null;

  const byTag = {};
  for (const row of db.prepare(`SELECT t.tags, t.category, ${AMT} AS amt ${base} AND t.tags<>''`).all(...range)) {
    for (const tag of row.tags.split(',')) {
      byTag[tag] = byTag[tag] || { tag, spent: 0, count: 0 };
      if (row.category !== 'Income') byTag[tag].spent -= row.amt;
      byTag[tag].count++;
    }
  }
  // Long ranges are charted by month, short ones by day.
  const granularity = daysBetween(...dates) > 62 ? 'month' : 'day';
  const bucket = granularity === 'month' ? 'substr(t.date, 1, 7)' : 't.date';
  const daily = db
    .prepare(`SELECT ${bucket} AS date, SUM(-${AMT}) AS spent ${base} AND t.category<>'Income' GROUP BY 1 ORDER BY 1`)
    .all(...range);
  // Spread payments with a part in this range, so the UI can explain why a total isn't the full amount paid.
  const spread = db
    .prepare(
      `SELECT t.id, COALESCE(NULLIF(t.counterparty, ''), t.description) AS name, t.category, t.paid_date,
              CASE WHEN a.invert_sign=1 THEN -t.paid_amount ELSE t.paid_amount END AS paid,
              SUM(${AMT}) AS amount, MIN(t.part) AS first_part, MAX(t.part) AS last_part, t.spread_months
       ${base} AND t.spread_months > 1 GROUP BY t.id ORDER BY t.paid_date, t.id`
    )
    .all(...range)
    .map((r) => ({ ...r, amount: Math.round(r.amount * 100) / 100 }));
  return {
    month: q.month && monthRange(q.month) ? q.month : null,
    from: dates[0],
    to: dates[1],
    excludedCategories: skipCats,
    months,
    granularity,
    income: totals.income,
    spending: totals.spending,
    net: totals.income - totals.spending,
    count: totals.count,
    byCategory,
    byTag: Object.values(byTag).sort((a, b) => b.spent - a.spent),
    daily,
    spread,
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
    if (b.in_projections !== undefined) db.prepare('UPDATE accounts SET in_projections=? WHERE id=?').run(b.in_projections ? 1 : 0, m[1]);
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
    const row = db.prepare('SELECT id, counterparty, description FROM transactions WHERE id=?').get(m[1]);
    if (!row) throw Object.assign(new Error('Transaction not found'), { status: 404 });
    let cat;
    if (b.category !== undefined) {
      cat = categories.ensure(db, b.category);
      sets.push('category=?, category_manual=1') && params.push(cat);
    }
    if (b.tags !== undefined) sets.push('tags=?') && params.push(normTags(b.tags));
    if (b.note !== undefined) sets.push('note=?') && params.push(String(b.note));
    if (b.exclude !== undefined) sets.push('exclude=?') && params.push(b.exclude ? 1 : 0);
    if (b.spread_months !== undefined) {
      const n = spreadMonths(b.spread_months);
      if (n === null) throw Object.assign(new Error(`Spread must be a whole number of months from 1 to ${SPREAD_MAX}`), { status: 400 });
      sets.push('spread_months=?') && params.push(n);
    }
    if (!sets.length) return { ok: true };
    db.prepare(`UPDATE transactions SET ${sets.join(', ')}, updated_at=datetime('now') WHERE id=?`).run(...params, m[1]);
    const out = db.prepare('SELECT id, category, tags, note, exclude, spread_months FROM transactions WHERE id=?').get(m[1]);
    if (cat !== undefined) {
      // Remember this merchant for future syncs, and tell the UI how many look-alikes could follow.
      out.merchant = categories.learn(db, row, cat);
      out.similar = out.merchant ? categories.similar(db, row, cat).length : 0;
      out.merchantName = row.counterparty || row.description;
    }
    return out;
  });
  // Apply a transaction's category to other auto-categorized transactions from the same merchant.
  route('POST', /^\/api\/transactions\/([\w-]+)\/apply-to-similar$/, (req, m) => {
    const row = db.prepare('SELECT id, counterparty, description, category FROM transactions WHERE id=?').get(m[1]);
    if (!row) throw Object.assign(new Error('Transaction not found'), { status: 404 });
    const ids = categories.similar(db, row, row.category);
    const set = db.prepare('UPDATE transactions SET category=? WHERE id=?');
    db.exec('BEGIN');
    for (const id of ids) set.run(row.category, id);
    db.exec('COMMIT');
    return { updated: ids.length, category: row.category };
  });
  route('POST', /^\/api\/transactions\/bulk$/, async (req) => {
    const b = await readJson(req);
    const ids = Array.isArray(b.ids) ? b.ids : [];
    const get = db.prepare('SELECT id, tags, counterparty, description FROM transactions WHERE id=?');
    const setTags = db.prepare(`UPDATE transactions SET tags=?, updated_at=datetime('now') WHERE id=?`);
    const setCat = db.prepare(`UPDATE transactions SET category=?, category_manual=1, updated_at=datetime('now') WHERE id=?`);
    const cat = b.category ? categories.ensure(db, b.category) : null;
    // Tags to take off: removeTags (comma list) or the older single removeTag; clearTags removes every tag.
    const rm = normTags(b.removeTags ?? b.removeTag ?? '');
    const drop = b.clearTags || rm ? new Set(rm.split(',')) : null;
    db.exec('BEGIN');
    for (const id of ids) {
      const row = get.get(id);
      if (!row) continue;
      let tags = row.tags;
      if (b.addTags) tags = normTags(`${tags},${b.addTags}`);
      if (drop) tags = b.clearTags ? '' : normTags(tags.split(',').filter((t) => !drop.has(t)));
      if (tags !== row.tags) setTags.run(tags, id);
      if (cat) {
        setCat.run(cat, id);
        categories.learn(db, row, cat);
      }
    }
    db.exec('COMMIT');
    return { updated: ids.length };
  });

  route('GET', /^\/api\/categories$/, () => {
    const tags = new Set();
    for (const r of db.prepare("SELECT tags FROM transactions WHERE tags<>''").all()) r.tags.split(',').forEach((t) => tags.add(t));
    const budgets = db.prepare('SELECT * FROM budgets ORDER BY category').all();
    for (const b of budgets) categories.ensure(db, b.category);
    return { categories: categories.list(db), tags: [...tags].sort(), budgets, excluded: categories.excluded(db) };
  });
  // Category manager (Settings): counts, budgets and remembered merchants.
  route('GET', /^\/api\/categories\/manage$/, () => {
    const counts = Object.fromEntries(
      db.prepare('SELECT category, COUNT(*) AS n FROM transactions GROUP BY category').all().map((r) => [r.category, r.n])
    );
    const budgets = Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map((b) => [b.category, b.monthly_limit]));
    const skip = new Set(categories.excluded(db));
    return {
      categories: categories.list(db).map((name) => ({
        name, count: counts[name] || 0, budget: budgets[name] ?? null, builtin: categories.BUILTIN.includes(name),
        excluded: skip.has(name), excludeLocked: categories.ALWAYS_EXCLUDED.includes(name),
      })),
      rules: db.prepare('SELECT merchant, category FROM category_rules ORDER BY merchant').all(),
    };
  });
  route('POST', /^\/api\/categories$/, async (req) => {
    const b = await readJson(req);
    if (!categories.cleanName(b.name)) throw Object.assign(new Error('Category name required'), { status: 400 });
    return { name: categories.ensure(db, b.name) };
  });
  route('PATCH', /^\/api\/categories$/, async (req) => {
    const b = await readJson(req);
    return { name: categories.rename(db, String(b.from || ''), b.to) };
  });
  // Count a category in totals or leave it out: { name, excluded: true|false }
  route('PUT', /^\/api\/categories\/exclude$/, async (req) => {
    const b = await readJson(req);
    const name = categories.setExcluded(db, b.name, !!b.excluded);
    return { name, excluded: !!b.excluded, excludedCategories: categories.excluded(db) };
  });
  route('DELETE', /^\/api\/categories$/, (req, m, url) => ({ moved: categories.remove(db, url.searchParams.get('name') || '') }));
  route('DELETE', /^\/api\/category-rules$/, (req, m, url) => {
    db.prepare('DELETE FROM category_rules WHERE merchant=?').run(url.searchParams.get('merchant') || '');
    return { ok: true };
  });
  route('PUT', /^\/api\/budgets$/, async (req) => {
    const b = await readJson(req);
    const limit = Number(b.monthly_limit);
    if (!b.category) throw Object.assign(new Error('category required'), { status: 400 });
    if (!limit || limit <= 0) db.prepare('DELETE FROM budgets WHERE category=?').run(b.category);
    else db.prepare('INSERT INTO budgets VALUES (?, ?) ON CONFLICT(category) DO UPDATE SET monthly_limit=excluded.monthly_limit').run(b.category, limit);
    return { ok: true };
  });

  // Projections: ?period=month|year&today=YYYY-MM-DD (your local date)
  route('GET', /^\/api\/projections$/, (req, m, url) => projections.project(db, Object.fromEntries(url.searchParams), summary));
  route('POST', /^\/api\/income-streams$/, async (req) => projections.addStream(db, await readJson(req)));
  route('PUT', /^\/api\/income-streams$/, async (req) => projections.saveStream(db, await readJson(req)));
  // A paycheck you added is deleted; a detected one goes back to what was detected.
  route('DELETE', /^\/api\/income-streams$/, (req, m, url) => {
    db.prepare('DELETE FROM income_streams WHERE key=?').run(url.searchParams.get('key') || '');
    return { ok: true };
  });

  route('GET', /^\/api\/summary$/, (req, m, url) => summary(db, Object.fromEntries(url.searchParams)));

  route('GET', /^\/api\/export\.csv$/, (req, m, url) => {
    const rows = queryTransactions(db, Object.fromEntries(url.searchParams));
    const head = ['Date', 'Description', 'Counterparty', 'Amount', 'Category', 'Tags', 'Note', 'Account', 'Status', 'Excluded', 'Spread (months)'];
    const lines = [head.join(',')].concat(
      rows.map((r) =>
        [r.date, r.description, r.counterparty, r.amount.toFixed(2), r.category, r.tags.replace(/,/g, ' '), r.note,
          `${r.institution || ''} ${r.account_name || ''}`.trim(), r.status, r.exclude ? 'yes' : '', r.spread_months > 1 ? r.spread_months : '']
          .map(csvCell).join(',')
      )
    );
    const sp = url.searchParams;
    const range = dateRange(Object.fromEntries(sp));
    const name = `budget-buddy-${sp.get('month') || (range ? `${range[0]}_to_${range[1]}` : 'all')}.csv`;
    return { __raw: lines.join('\n'), headers: { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="${name}"` } };
  });
  route('POST', /^\/api\/export\/sheets$/, async (req) => {
    const b = await readJson(req);
    const c = config.load();
    if (!c.sheetsWebhookUrl) throw Object.assign(new Error('Add your Google Sheets web app URL in Settings first.'), { status: 400 });
    const q = { month: b.month, from: b.from, to: b.to };
    const range = dateRange(q);
    const tx = queryTransactions(db, q);
    const s = range ? summary(db, q) : null;
    // The tab name in the sheet: the month, or a label like "2026", "2026 YTD" or "2026-03-01 to 2026-05-15".
    const label = b.month || (range && (String(b.label || '').replace(/[:\\/?*\[\]]/g, '-').slice(0, 80) || `${range[0]} to ${range[1]}`)) || 'all';
    const result = await postToSheet(c.sheetsWebhookUrl, {
      secret: c.sheetsSecret,
      month: label,
      transactions: tx.map((r) => ({
        date: r.date, description: r.description, counterparty: r.counterparty, amount: r.amount,
        category: r.category, tags: r.tags, note: r.note, account: `${r.institution || ''} ${r.account_name || ''}`.trim(),
        status: r.status, excluded: !!r.exclude, spread_months: r.spread_months, id: r.id,
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

module.exports = { start, createApp, __test: { summaryFor: summary, SPREAD_MAX } };

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
