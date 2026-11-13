'use strict';
/* Budget Buddy front end — plain JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Local calendar date as YYYY-MM-DD (toISOString would give tomorrow's date late in the evening).
const localISO = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const lastOfMonth = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const niceDate = (iso, withYear = true) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}${withYear ? `, ${iso.slice(0, 4)}` : ''}`;

const state = { month: localISO().slice(0, 7), view: 'dashboard',
  // Date range: mode is month | year | ytd | custom. year is used by "1 Year" and "YTD"; from/to by "Custom".
  range: { mode: 'month', year: new Date().getFullYear(), from: '', to: '' }, tx: [], selected: new Set(), meta: { categories: [], tags: [], budgets: [] } };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', 'X-Budget-Buddy': '1', ...(opts.headers || {}) },
    body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { code: data.code });
  return data;
}

let toastTimer;
function toast(msg, isError = false, html = false) {
  const t = $('#toast');
  t[html ? 'innerHTML' : 'textContent'] = msg;
  t.className = 'toast' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), isError ? 7000 : 3500);
}

async function busy(btn, fn) {
  btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
}

// ---------- navigation ----------
function show(view) {
  state.view = view;
  if (view !== 'projections' && $('#projSettings').open) $('#projSettings').close();
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  // Projections always show the current month/year, so the date picker is hidden there.
  $('.month-picker').classList.toggle('hidden', view === 'projections');
  const loaders = { dashboard: loadDashboard, projections: loadProjections, transactions: loadTransactions, categories: loadCategoryManager,
    accounts: loadAccounts, export: loadExport, settings: loadSettings };
  (loaders[view] || loadDashboard)();
}
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'dashboard'));

// ---------- date range ----------
// The range being viewed: { from, to, label, month? } (month only in Month mode).
function currentRange() {
  const r = state.range;
  if (r.mode === 'year') return { from: `${r.year}-01-01`, to: `${r.year}-12-31`, label: String(r.year) };
  if (r.mode === 'ytd') {
    // Same stretch of the year as today, so last year's YTD compares like for like.
    const today = localISO();
    let to = `${r.year}${today.slice(4)}`;
    if (to.endsWith('02-29') && !(r.year % 4 === 0 && (r.year % 100 !== 0 || r.year % 400 === 0))) to = `${r.year}-02-28`;
    return { from: `${r.year}-01-01`, to, label: `${r.year} YTD` };
  }
  if (r.mode === 'custom' && r.from && r.to) {
    const [from, to] = r.from <= r.to ? [r.from, r.to] : [r.to, r.from];
    return { from, to, label: `${from} to ${to}` };
  }
  return { from: `${state.month}-01`, to: lastOfMonth(state.month), label: state.month, month: state.month };
}
function setRangeParams(p, r = currentRange()) {
  if (r.month) p.set('month', r.month);
  else { p.set('from', r.from); p.set('to', r.to); }
  return p;
}
function saveRange() {
  try { localStorage.setItem('bb.range', JSON.stringify({ mode: state.range.mode, from: state.range.from, to: state.range.to })); } catch {}
}
function renderRangeControls() {
  const r = state.range;
  $('#rangeMode').value = r.mode;
  $('#month').classList.toggle('hidden', r.mode !== 'month');
  $('#customRange').classList.toggle('hidden', r.mode !== 'custom');
  $('#rangeLabel').classList.toggle('hidden', r.mode !== 'year' && r.mode !== 'ytd');
  $('#prevMonth').classList.toggle('hidden', r.mode === 'custom');
  $('#nextMonth').classList.toggle('hidden', r.mode === 'custom');
  const unit = r.mode === 'month' ? 'month' : 'year';
  $('#prevMonth').title = `Previous ${unit}`;
  $('#nextMonth').title = `Next ${unit}`;
  $('#month').value = state.month;
  $('#fromDate').value = r.from;
  $('#toDate').value = r.to;
  if (r.mode === 'year') $('#rangeLabel').textContent = String(r.year);
  if (r.mode === 'ytd') { const c = currentRange(); $('#rangeLabel').textContent = `${niceDate(c.from, false)} – ${niceDate(c.to)}`; }
}
function refreshRange() {
  renderRangeControls();
  saveRange();
  if (state.view === 'dashboard') loadDashboard();
  if (state.view === 'transactions') loadTransactions();
  if (state.view === 'export') loadExport();
}
function setRangeMode(mode) {
  const prev = currentRange();
  const r = state.range;
  if (mode === 'custom' && (!r.from || !r.to)) { r.from = prev.from; r.to = prev.to; }
  if (mode === 'year' || mode === 'ytd') r.year = r.mode === 'month' ? Number(state.month.slice(0, 4)) : r.year;
  if (mode === 'ytd' && r.mode !== 'year') r.year = new Date().getFullYear();
  r.mode = mode;
  refreshRange();
}
function setMonth(m) {
  state.month = m;
  refreshRange();
}
function shiftMonth(delta) {
  const r = state.range;
  if (r.mode === 'custom') return;
  if (r.mode === 'year' || r.mode === 'ytd') { r.year += delta; return refreshRange(); }
  const [y, m] = state.month.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  setMonth(d.toISOString().slice(0, 7));
}

// ---------- meta (categories / tags) ----------
async function loadMeta() {
  state.meta = await api('/api/categories');
  $('#categoryOptions').innerHTML = state.meta.categories.map((c) => `<option value="${esc(c)}">`).join('');
  const fill = (sel, items, label) => {
    const cur = sel.value;
    sel.innerHTML = `<option value="">${label}</option>` + items.map((i) => `<option value="${esc(i)}">${esc(i)}</option>`).join('');
    sel.value = cur;
  };
  fill($('#fCategory'), state.meta.categories, 'All categories');
  fill($('#fTag'), state.meta.tags, 'All tags');
  $('#bulkCat').innerHTML = '<option value="">set category…</option>' + catOptions('');
}

// <option>s for a category picker: every category, the current one (even if unknown), and "New category…".
const NEW_CAT = '__new__';
function catOptions(current) {
  const names = [...state.meta.categories];
  if (current && !names.includes(current)) names.push(current);
  return names.map((c) => `<option value="${esc(c)}"${c === current ? ' selected' : ''}>${esc(c)}</option>`).join('') +
    `<option value="${NEW_CAT}">＋ New category…</option>`;
}

// Swaps a category <select> for a text box to type a new category. Resolves with the name, or null if cancelled.
function askNewCategory(select, restoreTo) {
  return askInline(select, restoreTo, { placeholder: 'New category, then Enter', maxLength: 60 });
}

// Swaps a <select> for a text box until Enter, Escape or blur. Resolves with the trimmed text, or null.
function askInline(select, restoreTo, { placeholder, maxLength = 60, type = 'text', min, max } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.className = 'new-cat';
    input.placeholder = placeholder;
    input.type = type;
    if (type === 'text') input.maxLength = maxLength;
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    select.replaceWith(input);
    input.focus();
    let done = false;
    const finish = (val) => {
      if (done) return;
      done = true;
      select.value = restoreTo;
      input.replaceWith(select);
      resolve(val && val.trim() ? val.trim() : null);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); finish(input.value); }
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
    });
    input.addEventListener('blur', () => finish(input.value));
  });
}

// ---------- dashboard ----------
async function loadDashboard() {
  const s = await api(`/api/summary?${setRangeParams(new URLSearchParams())}`);
  $('#tIncome').textContent = money(s.income);
  $('#tSpending').textContent = money(s.spending);
  $('#tNet').textContent = money(s.net);
  $('#tNet').className = 'value ' + (s.net >= 0 ? 'pos' : 'neg');

  const max = Math.max(1, ...s.byCategory.map((c) => Math.max(c.spent, c.budget || 0)));
  $('#catList').innerHTML = s.byCategory.length
    ? s.byCategory.map((c) => {
        const pct = c.budget ? c.spent / c.budget : 0;
        const cls = c.budget ? (pct > 1 ? 'over' : pct > 0.85 ? 'near' : '') : '';
        const width = (Math.max(0, c.budget ? Math.min(c.spent, c.budget) / c.budget : c.spent / max) * 100).toFixed(1);
        return `<div class="cat-row" data-cat="${esc(c.category)}">
          <div class="cat-name">${esc(c.category)}</div>
          <div class="bar ${cls}"><span style="width:${width}%"></span></div>
          <div class="cat-amt">${money(c.spent)} <span class="budget" data-budget="${esc(c.category)}">${c.budget ? `of ${money(c.budget)}` : '+ budget'}</span></div>
        </div>`;
      }).join('')
    : '<div class="empty">No spending in this period yet. Connect a bank or load demo data from Accounts.</div>';
  const skipped = (s.excludedCategories || []);
  $('#excludedNote').innerHTML = skipped.length
    ? `Not counted: ${skipped.map(esc).join(', ')} · <a href="#categories">change</a>` : '';
  const spread = s.spread || [];
  $('#spreadNote').innerHTML = spread.length
    ? `Spread payments counted here: ${spread.map((p) => `${esc(p.name)} ${money(-p.amount)} of ${money(-p.paid)} ` +
        `(${p.first_part === p.last_part ? `month ${p.first_part}` : `months ${p.first_part}–${p.last_part}`} of ${p.spread_months}, paid ${niceDate(p.paid_date)})`).join(' · ')}`
    : '';
  $('#budgetHint').textContent = s.months === 1 ? 'click a budget to edit it'
    : `budgets × ${s.months} months · click one to edit the monthly amount`;

  $('#tagList').innerHTML = s.byTag.length
    ? s.byTag.map((t) => `<div class="tag-row" data-tag="${esc(t.tag)}"><span class="chip">${esc(t.tag)}</span><span>${money(t.spent)} · ${t.count} txn</span></div>`).join('')
    : '<div class="hint">Tag transactions (e.g. “work-trip”, “gift”) to see them grouped here.</div>';

  drawDaily(s);
}

// Bars for every day (short ranges) or every month (long ranges) between s.from and s.to.
function drawDaily(s) {
  const byMonth = s.granularity === 'month';
  $('#chartTitle').textContent = byMonth ? 'Monthly spending' : 'Daily spending';
  const keys = [];
  if (byMonth) {
    let [y, m] = s.from.split('-').map(Number);
    for (let k = `${y}-${String(m).padStart(2, '0')}`; k <= s.to.slice(0, 7); k = `${y}-${String(m).padStart(2, '0')}`) {
      keys.push(k);
      if (++m > 12) { m = 1; y++; }
    }
  } else {
    for (let t = Date.parse(s.from + 'T00:00:00Z'); t <= Date.parse(s.to + 'T00:00:00Z'); t += 86400000) keys.push(new Date(t).toISOString().slice(0, 10));
  }
  const map = Object.fromEntries(s.daily.map((d) => [d.date, d.spent]));
  const max = Math.max(1, ...Object.values(map));
  const n = keys.length, W = 700, H = 140, pad = 18, bw = (W - 10) / n;
  const multiYear = s.from.slice(0, 4) !== s.to.slice(0, 4);
  const oneMonth = !byMonth && s.from.slice(0, 7) === s.to.slice(0, 7);
  const every = byMonth ? Math.ceil(n / 12) : oneMonth ? 5 : Math.ceil(n / 8);
  const label = (k, i) => byMonth ? MONTHS[Number(k.slice(5, 7)) - 1] + (multiYear && (i === 0 || k.endsWith('-01')) ? ` ’${k.slice(2, 4)}` : '')
    : oneMonth ? String(Number(k.slice(8))) : niceDate(k, false);
  const tip = (k) => byMonth ? `${MONTHS[Number(k.slice(5, 7)) - 1]} ${k.slice(0, 4)}` : k;
  let bars = '';
  keys.forEach((k, i) => {
    const v = map[k] || 0;
    const h = (Math.max(0, v) / max) * (H - pad - 6);
    bars += `<rect x="${5 + i * bw + 1}" y="${H - pad - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${tip(k)}: ${money(v)}</title></rect>`;
    const show = oneMonth ? (i === 0 || (i + 1) % 5 === 0) : i % every === 0;
    if (show) bars += `<text x="${5 + i * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${label(k, i)}</text>`;
  });
  $('#dailyChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}</svg>`;
}

$('#catList').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-budget]');
  if (b) {
    const cat = b.dataset.budget;
    const cur = state.meta.budgets.find((x) => x.category === cat);
    const v = prompt(`Monthly budget for ${cat} (0 to remove):`, cur ? cur.monthly_limit : '');
    if (v === null) return;
    await api('/api/budgets', { method: 'PUT', body: { category: cat, monthly_limit: Number(v) } });
    await loadMeta();
    return loadDashboard();
  }
  const row = e.target.closest('.cat-row');
  if (row) { $('#fCategory').value = row.dataset.cat; location.hash = 'transactions'; }
});
$('#tagList').addEventListener('click', (e) => {
  const row = e.target.closest('.tag-row');
  if (row) { $('#fTag').value = row.dataset.tag; location.hash = 'transactions'; }
});
$('#addBudget').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  await api('/api/budgets', { method: 'PUT', body: { category: f.get('category'), monthly_limit: Number(f.get('limit')) } });
  e.target.reset();
  await loadMeta();
  loadDashboard();
});

// ---------- projections ----------
// Always the current month (or year): income so far + paychecks still to come, minus spending.
const FREQ_LABELS = { weekly: 'Weekly', biweekly: 'Every 2 weeks', semimonthly: 'Twice a month', monthly: 'Monthly' };
// How to estimate a paycheck that changes size (hours, overtime, holiday pay). Same keys as the server.
const ESTIMATE_LABELS = {
  average: '6-month average', recent: 'Average of last 4', median: 'Typical (middle)', low: 'Conservative', last: 'Last paycheck',
};
const ESTIMATE_HELP = {
  average: 'Average of every paycheck in the last 6 months. Busy weeks, slow weeks and holiday pay even out.',
  recent: 'Average of the last 4 paychecks. Follows a recent raise or change in hours.',
  median: 'The middle paycheck of the last 6 months. One unusually big or small check doesn’t move it.',
  low: 'A slower-than-usual paycheck: 3 in 4 of your paychecks were at least this much. Safer for tight budgets.',
  last: 'Exactly what your most recent paycheck was.',
};
const moneyRange = (r) => `${money(r.low)}–${money(r.high)}`;
state.projPeriod = 'month';
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const line = (label, value, hint = '', cls = '') =>
  `<div class="line ${cls}"><span>${label}${hint ? `<span class="hint">${hint}</span>` : ''}</span><span>${value}</span></div>`;
const signed = (n, sign) => `${sign}${money(Math.abs(n))}`;

async function loadProjections() {
  const p = await api(`/api/projections?period=${state.projPeriod}&today=${localISO()}`);
  state.proj = p;
  const yr = p.period === 'year';
  const endWord = yr ? 'year' : 'month';
  $('#view-projections').classList.toggle('year', yr);
  $$('#view-projections .seg button').forEach((b) => b.classList.toggle('active', b.dataset.period === p.period));
  const name = yr ? p.from.slice(0, 4) : new Date(p.from + 'T00:00:00Z').toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  $('#projAsOf').textContent = `${name} · as of ${niceDate(p.today)} · ${plural(p.daysLeft, 'day')} left`;

  const inc = p.income;
  const nPay = inc.streams.filter((s) => s.enabled).reduce((a, s) => a + s.expectedDates.length, 0);
  $('#pIncome').textContent = money(inc.projected);
  $('#pIncomeSub').textContent = `${money(inc.soFar)} so far + ${money(inc.expected)} expected` +
    (inc.range ? ` · likely ${money(inc.range.projectedLow)}–${money(inc.range.projectedHigh)}` : '');
  $('#pSpent').textContent = money(p.spending.soFar);
  $('#pSpentSub').textContent = `about ${money(p.spending.remaining)} more planned`;
  $('#pLeft').textContent = money(p.leftToSpend);
  $('#pLeft').className = 'value ' + (p.leftToSpend >= 0 ? 'pos' : 'neg');
  $('#pLeftSub').textContent = p.leftToSpend >= 0 ? `≈ ${money(p.perDay)} a day for ${plural(p.daysLeft, 'day')}` : 'Spending is ahead of income';
  $('#pBalLabel').textContent = `Bank balance at ${endWord} end`;
  const weekLabel = `End of this week (${niceDate(p.weekEnd, false)})`;
  if (p.balance) {
    $('#pBal').textContent = money(p.balance.end);
    $('#pBal').className = 'value ' + (p.balance.end < 0 ? 'neg' : '');
    $('#pBalSub').textContent = (p.balance.endRange ? `Likely ${moneyRange(p.balance.endRange)} · ` : '') + `${weekLabel}: ${money(p.balance.week)}`;
  } else {
    $('#pBal').textContent = '–';
    $('#pBal').className = 'value';
    $('#pBalSub').textContent = 'Connect a checking or savings account to see this';
  }

  const payDays = inc.streams.filter((s) => s.enabled).flatMap((s) => s.expectedDates).sort();
  const dayList = payDays.length > 4 ? `${niceDate(payDays[0], false)} … ${niceDate(payDays.at(-1), false)}` : payDays.map((d) => niceDate(d, false)).join(', ');
  // Paychecks that vary: show where the total would land if they came in low or high.
  const varyHint = inc.range ? `paychecks vary: likely ${moneyRange(inc.range)}` : '';
  const payHint = [dayList, varyHint].filter(Boolean).join(' · ');
  $('#pMath').innerHTML =
    line('Income so far', signed(inc.soFar, '+')) +
    line(`Paychecks still to come (${nPay})`, signed(inc.expected, '+'), payHint) +
    line('Spent so far', signed(p.spending.soFar, '−')) +
    line('Left to spend', money(p.leftToSpend), p.leftRange ? `likely ${moneyRange(p.leftRange)}` : '', `total ${p.leftToSpend < 0 ? 'neg' : 'pos'}`) +
    line('Left after planned spending', money(p.afterPlanned), 'room for anything unplanned, or to save', `total sub-total ${p.afterPlanned < 0 ? 'neg' : ''}`);
  const accts = p.cash.accounts.map((a) => `${a.name}${a.last_four ? ` ····${a.last_four}` : ''}${a.balance == null ? ' (no balance)' : ''}`).join(', ');
  $('#pBalMath').innerHTML = p.balance
    ? line('Checking &amp; savings today', money(p.cash.total), esc(accts)) +
      line('Paychecks still to come', signed(inc.expected, '+'), varyHint) +
      line('Planned spending still to come', signed(p.spending.remaining, '−')) +
      line(`Projected at ${endWord} end (${niceDate(p.to, false)})`, money(p.balance.end),
        p.balance.endRange ? `likely ${moneyRange(p.balance.endRange)}` : '', `total ${p.balance.end < 0 ? 'neg' : ''}`) +
      line(weekLabel, money(p.balance.week), `${signed(inc.expectedWeek, '+')} paychecks, ${signed(p.spending.remainingWeek, '−')} spending`, 'total sub-total') +
      '<p class="hint">Card purchases count when you make them, as if you pay the card from checking. Card payments are Transfers, so they aren’t counted twice.</p>'
    : '<div class="hint">No checking or savings balance yet. Connect a bank under Accounts and Sync.</div>';

  renderProjAccounts(p);
  renderStreams(p);
  renderProjBudgets(p);
}

// Tick which accounts count toward the projection (balances, paychecks and spending).
const ACCT_TYPES = { depository: 'Checking & savings', credit: 'Card', loan: 'Loan', investment: 'Investment' };
function renderProjAccounts(p) {
  const list = p.accounts || [];
  const on = list.filter((a) => a.included).length;
  $('#projAcctCount').textContent = list.length ? `${on} of ${list.length} counted` : '';
  $('#projAccounts').innerHTML = list.length ? list.map((a) => `<label class="check acct-chip${a.included ? '' : ' off'}" title="${esc(a.institution || '')}">
      <input type="checkbox" class="pa-on" data-id="${esc(a.id)}" ${a.included ? 'checked' : ''}>
      ${esc(a.name)}${a.last_four ? ` ····${esc(a.last_four)}` : ''}<span class="hint">${esc(ACCT_TYPES[a.type] || a.type || '')}</span>
    </label>`).join('')
    : '<div class="hint">No accounts yet. Connect a bank under Accounts and Sync.</div>';
}
$('#projAccounts').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('pa-on')) return;
  try {
    await api(`/api/accounts/${encodeURIComponent(e.target.dataset.id)}`, { method: 'PATCH', body: { in_projections: e.target.checked } });
    await loadProjections();
  } catch (err) { toast(err.message, true); }
});

function renderStreams(p) {
  const yr = p.period === 'year';
  $('#streamPeriodHead').textContent = `Still to come this ${yr ? 'year' : 'month'}`;
  const freqOpts = (cur) => Object.entries(FREQ_LABELS).map(([k, v]) => `<option value="${k}"${k === cur ? ' selected' : ''}>${v}</option>`).join('');
  $('#streamTable tbody').innerHTML = p.income.streams.map((s) => {
    const d = s.detected;
    const info = s.manual ? 'Added by you'
      : s.stale ? `Not seen since ${niceDate(d.lastDate)}, so it’s not counted. Tick Use if it’s still coming.`
      : d.variable ? `Varies: usually ${money(d.low)}–${money(d.high)} (${money(d.min)}–${money(d.max)} over ${plural(d.deposits, 'paycheck')}) · last paid ${niceDate(d.lastDate, false)}`
      : `Found ${plural(d.deposits, 'deposit')} · last paid ${niceDate(d.lastDate, false)}${d.averagedOver > 1 ? ` · average of last ${d.averagedOver}` : ''}`;
    // Hover the source to see the paychecks the estimate is based on.
    const histTitle = d && d.history ? 'Recent paychecks:\n' + d.history.slice().reverse().map((h) => `${niceDate(h.date, false)}  ${money(h.amount)}`).join('\n') : '';
    // Paychecks that vary (or where you picked a method) get a choice of how to estimate them.
    const showEst = d && (d.variable || s.changed.estimate);
    const estSel = showEst ? `<select class="s-est${s.changed.estimate ? ' changed' : ''}" title="${esc(ESTIMATE_HELP[s.estimate] || 'You typed this amount. Pick a method to go back to an estimate.')}">
        ${s.estimate === 'custom' ? '<option value="" selected>Your amount</option>' : ''}
        ${Object.entries(ESTIMATE_LABELS).map(([k, v]) => `<option value="${k}"${k === s.estimate ? ' selected' : ''}>${v} · ${money(d.estimates[k])}</option>`).join('')}
      </select>` : '';
    // Highlights a value you changed; hovering shows what was detected.
    const was = (cls, field, label) => (d && s.changed[field] ? ` class="${cls} changed" title="Detected: ${esc(label)}"` : ` class="${cls}"`);
    const anyChange = Object.values(s.changed).some(Boolean);
    return `<tr data-key="${esc(s.key)}" class="${s.enabled ? '' : 'off'}">
      <td class="center"><input type="checkbox" class="s-on" ${s.enabled ? 'checked' : ''} title="Count this paycheck"></td>
      <td><input${was('stream-name', 'name', d && d.name)} value="${esc(s.name)}" maxlength="60"><div class="hint"${histTitle ? ` title="${esc(histTitle)}"` : ''}>${esc(info)}</div></td>
      <td><select${was('s-freq', 'frequency', d && FREQ_LABELS[d.frequency])}>${freqOpts(s.frequency)}</select></td>
      <td class="num"><input type="number"${was('s-amt', 'amount', d && money(d.amount))} min="0" step="0.01" value="${s.amount}">${estSel ? `<div>${estSel}</div>` : ''}</td>
      <td><input type="date" class="s-next${s.changed.nextDate && d ? ' changed' : ''}" value="${s.nextDate || ''}"${s.changed.nextDate && d ? ' title="You set this date"' : ''}></td>
      <td class="num">${money(s.enabled ? s.expectedTotal : 0)}<div class="hint">${plural(s.expectedDates.length, 'paycheck')}${s.enabled && s.range && s.expectedDates.length ? ` · ${money(s.expectedLow)}–${money(s.expectedHigh)}` : ''}</div></td>
      <td class="num">${s.manual ? '<button class="ghost small s-del">Delete</button>' : anyChange ? '<button class="ghost small s-reset" title="Go back to what was detected">Reset</button>' : ''}</td>
    </tr>`;
  }).join('');
  const empty = !p.income.streams.length;
  $('#streamTable').classList.toggle('hidden', empty);
  $('#streamEmpty').classList.toggle('hidden', !empty);
  $('#streamEmpty').textContent = 'No paychecks found yet. Categorize at least two paycheck deposits as Income, or add one yourself.';
}

function renderProjBudgets(p) {
  const yr = p.period === 'year';
  $('#pbSpentHead').textContent = yr ? 'Spent this year' : 'Spent so far';
  $('#pbProjHead').textContent = yr ? 'Projected for year' : 'Projected for month';
  $('#projBudgets tbody').innerHTML = p.byCategory.length ? p.byCategory.map((c) => {
    const has = c.budget != null;
    const scale = Math.max(1, c.budget || 0, c.projected, c.spent);
    const w = (n) => (Math.max(0, n) / scale * 100).toFixed(1);
    const cls = { over: 'over', near: 'near' }[c.status] || '';
    const note = c.status === 'over' ? `<div class="over-note">Over budget by ${money(c.spent - c.budget)}</div>` : '';
    return `<tr data-cat="${esc(c.category)}" class="${has ? '' : 'no-budget'}">
      <td>${esc(c.category)}${note}</td>
      <td class="num">${money(c.spent)}</td>
      <td class="num"><input type="number" class="pb-input" min="0" step="1" value="${c.budgetMonthly ?? ''}" placeholder="${c.typical ? `~${Math.round(c.typical)}` : 'none'}" title="Monthly budget for ${esc(c.category)}${c.typical ? ` (you usually spend about ${money(c.typical)} a month)` : ''}"></td>
      <td class="num yr">${has ? money(c.budget) : '–'}</td>
      <td class="bar-col"><div class="bar ${cls}"><span style="width:${w(c.spent)}%"></span><span class="plan" style="left:${w(c.spent)}%;width:${w(c.remaining)}%" title="${money(c.remaining)} still planned"></span></div></td>
      <td class="num">${money(c.projected)}</td>
      <td class="num left ${has && c.budget - c.spent < 0 ? 'neg' : ''}">${has ? money(c.budget - c.spent) : '–'}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="hint">No spending yet. Connect a bank or load demo data from Accounts.</td></tr>';
  const shown = new Set(p.byCategory.map((c) => c.category));
  const skip = new Set([...(p.excludedCategories || []), 'Income', 'Transfer']);
  $('#projAddBudget select').innerHTML = '<option value="">Add a budget for…</option>' +
    state.meta.categories.filter((c) => !shown.has(c) && !skip.has(c)).map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  $('#projBudgetHint').textContent = yr ? 'monthly amounts (× 12 for the year); type one in to set it, clear it to remove'
    : 'monthly amounts; type one in to set it, clear it to remove';
  const h = p.history;
  const usual = h.months ? `your usual monthly spending (average of the last ${plural(h.months, 'full month')})` : 'this month’s pace so far (there’s no full month of history yet)';
  $('#projNote').innerHTML = `Projected = spent so far + what’s still planned: your budget, or ${usual} where there’s no budget.` +
    (p.excludedCategories.length ? ` Not counted: ${p.excludedCategories.map(esc).join(', ')} · <a href="#categories">change</a>` : '');
}

// Projection settings drawer (Accounts counted + Paychecks)
const projSettings = $('#projSettings');
$('#projSettingsBtn').addEventListener('click', () => projSettings.showModal());
$('#projSettingsClose').addEventListener('click', () => projSettings.close());
projSettings.addEventListener('click', (e) => { // clicking the dimmed backdrop (outside the panel) closes it
  const r = projSettings.getBoundingClientRect();
  if (e.target === projSettings && (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom)) projSettings.close();
});
$$('#view-projections .seg button').forEach((b) => b.addEventListener('click', () => {
  state.projPeriod = b.dataset.period;
  loadProjections().catch((e) => toast(e.message, true));
}));

async function saveStreamField(key, body) {
  try {
    await api('/api/income-streams', { method: 'PUT', body: { key, ...body } });
    await loadProjections();
  } catch (e) { toast(e.message, true); }
}
$('#streamTable').addEventListener('change', (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const key = tr.dataset.key;
  const el = e.target;
  if (el.classList.contains('s-on')) saveStreamField(key, { enabled: el.checked });
  if (el.classList.contains('s-freq')) saveStreamField(key, { frequency: el.value });
  if (el.classList.contains('s-amt')) saveStreamField(key, { amount: el.value === '' ? null : Number(el.value) });
  // Picking a method replaces an amount you typed in.
  if (el.classList.contains('s-est') && el.value) saveStreamField(key, { estimate: el.value, amount: null });
  if (el.classList.contains('s-next')) saveStreamField(key, { next_date: el.value || null });
  if (el.classList.contains('stream-name')) saveStreamField(key, { name: el.value.trim() || null });
});
$('#streamTable').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) { e.preventDefault(); e.target.blur(); }
});
$('#streamTable').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-key]');
  if (!tr) return;
  const isDel = e.target.classList.contains('s-del');
  if (!isDel && !e.target.classList.contains('s-reset')) return;
  if (isDel && !confirm('Delete this income?')) return;
  try {
    await api(`/api/income-streams?key=${encodeURIComponent(tr.dataset.key)}`, { method: 'DELETE' });
    toast(isDel ? 'Income deleted' : 'Back to the detected paycheck');
    await loadProjections();
  } catch (err) { toast(err.message, true); }
});
$('#addStream').addEventListener('click', (e) => busy(e.target, async () => {
  const { key } = await api('/api/income-streams', { method: 'POST', body: { name: 'Paycheck', amount: 0, frequency: 'biweekly', next_date: localISO() } });
  await loadProjections();
  const row = $$('#streamTable tr[data-key]').find((r) => r.dataset.key === key);
  if (row) { $('.s-amt', row).focus(); $('.s-amt', row).select(); }
}));

async function setBudget(category, value) {
  await api('/api/budgets', { method: 'PUT', body: { category, monthly_limit: Number(value) || 0 } });
  await loadMeta();
  await loadProjections();
}
$('#projBudgets').addEventListener('change', (e) => {
  if (!e.target.classList.contains('pb-input')) return;
  setBudget(e.target.closest('tr[data-cat]').dataset.cat, e.target.value).catch((err) => toast(err.message, true));
});
$('#projBudgets').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('pb-input')) { e.preventDefault(); e.target.blur(); }
});
$('#projAddBudget').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try {
    await setBudget(f.get('category'), f.get('limit'));
    e.target.reset();
  } catch (err) { toast(err.message, true); }
});

// ---------- transactions ----------
function txQuery({ allTime = $('#fAllTime').checked } = {}) {
  const p = new URLSearchParams();
  if (!allTime) setRangeParams(p);
  if ($('#fSearch').value) p.set('q', $('#fSearch').value);
  if ($('#fAmount').value.trim()) p.set('amount', $('#fAmount').value.trim());
  if ($('#fAccount').value) p.set('account', $('#fAccount').value);
  if ($('#fCategory').value) p.set('category', $('#fCategory').value);
  if ($('#fTag').value) p.set('tag', $('#fTag').value);
  if ($('#fUntagged').checked) p.set('untagged', '1');
  return p.toString();
}

// keepSelection: leave the same rows ticked after a reload (used by the bulk bar so several
// actions can be applied to one selection). Rows that no longer match the filters drop out.
async function loadTransactions({ keepSelection = false } = {}) {
  state.tx = await api(`/api/transactions?${txQuery()}`);
  const ids = new Set(state.tx.map((t) => t.id));
  state.selected = keepSelection ? new Set([...state.selected].filter((id) => ids.has(id))) : new Set();
  renderTx();
}

const catExcluded = (c) => (state.meta.excluded || []).includes(c);

// ---------- spreading a payment over several months ----------
const SPREAD_CHOICES = [1, 2, 3, 4, 6, 12, 18, 24];
const SPREAD_MAX = 60;
const OTHER_SPREAD = '__other__';
const monthLabel = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;
const addMonthsYM = (ym, n) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + n, 1)); return d.toISOString().slice(0, 7); };

function spreadOptions(n) {
  const list = SPREAD_CHOICES.includes(n) ? SPREAD_CHOICES : [...SPREAD_CHOICES, n].sort((a, b) => a - b);
  return list.map((k) => `<option value="${k}"${k === n ? ' selected' : ''}>${k === 1 ? 'Count once' : `Spread ${k} mo`}</option>`).join('') +
    `<option value="${OTHER_SPREAD}">Other…</option>`;
}

// What a spread payment counts as each month, e.g. "$50.00/mo · Jan 2026 – Dec 2026".
function spreadDetail(t) {
  const n = t.spread_months || 1;
  if (n <= 1) return '';
  const start = t.date.slice(0, 7);
  return `${money(Math.abs(Math.round((t.amount / n) * 100) / 100))}/mo · ${monthLabel(start)} – ${monthLabel(addMonthsYM(start, n - 1))}`;
}

function amountCell(t) {
  const n = t.spread_months || 1;
  return `<div class="${t.amount < 0 ? '' : 'pos'}">${money(t.amount)}</div>
    <select data-f="spread_months" class="spread${n > 1 ? ' on' : ''}" title="Count this amount in one month, or split it evenly over several (e.g. a year of insurance paid up front)">${spreadOptions(n)}</select>
    ${n > 1 ? `<div class="spread-each">${esc(spreadDetail(t))}</div>` : ''}`;
}

function renderTx() {
  const tbody = $('#txTable tbody');
  tbody.innerHTML = state.tx.map((t) => `
    <tr data-id="${esc(t.id)}" class="${t.exclude || catExcluded(t.category) ? 'excluded' : ''}"${!t.exclude && catExcluded(t.category) ? ` title="${esc(t.category)} isn't counted in totals"` : ''}>
      <td class="cb"><input type="checkbox" class="sel" ${state.selected.has(t.id) ? 'checked' : ''}></td>
      <td class="date">${esc(t.date)}</td>
      <td class="desc"><div class="main" title="${esc(t.description)}">${esc(t.counterparty || t.description)}${t.status === 'pending' ? '<span class="pending">pending</span>' : ''}</div>
        <div class="sub">${esc(t.counterparty ? t.description : '')} · ${esc(t.account_name)}</div></td>
      <td class="cat"><select data-f="category" title="Category">${catOptions(t.category)}</select></td>
      <td class="tags"><input data-f="tags" value="${esc(t.tags.split(',').filter(Boolean).join(', '))}" placeholder="add tags"></td>
      <td class="note"><input data-f="note" value="${esc(t.note)}" placeholder="add a note"></td>
      <td class="num amt">${amountCell(t)}</td>
      <td><input type="checkbox" data-f="exclude" ${t.exclude ? 'checked' : ''} title="Exclude from budget totals"></td>
    </tr>`).join('');
  const empty = $('#txEmpty');
  empty.classList.toggle('hidden', state.tx.length > 0);
  empty.textContent = 'No transactions match. Try “All dates”, clear filters, or Sync.';
  updateBulk();
}

async function saveField(input) {
  const tr = input.closest('tr');
  const id = tr.dataset.id;
  const field = input.dataset.f;
  const tx = state.tx.find((t) => t.id === id);
  let value = field === 'exclude' ? input.checked : input.value;
  if (field === 'category' && value === NEW_CAT) {
    value = await askNewCategory(input, tx.category);
    if (!value) return;
  }
  if (field === 'spread_months') {
    if (value === OTHER_SPREAD) {
      value = await askInline(input, String(tx.spread_months || 1), { placeholder: `Months (1–${SPREAD_MAX}), then Enter`, type: 'number', min: 1, max: SPREAD_MAX });
      if (!value) return;
    }
    value = Number(value);
    if (!Number.isInteger(value) || value < 1 || value > SPREAD_MAX) return toast(`Enter a whole number of months from 1 to ${SPREAD_MAX}`, true);
  }
  const prev = field === 'exclude' ? !!tx.exclude : field === 'tags' ? tx.tags.split(',').filter(Boolean).join(', ')
    : field === 'spread_months' ? tx.spread_months || 1 : tx[field];
  if (prev === value) return;
  try {
    const out = await api(`/api/transactions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [field]: value } });
    Object.assign(tx, out);
    if (field === 'tags') input.value = out.tags.split(',').filter(Boolean).join(', ');
    if (field === 'exclude' || field === 'category') tr.classList.toggle('excluded', !!out.exclude || catExcluded(out.category));
    input.closest('td').classList.remove('saved');
    void input.offsetWidth;
    input.closest('td').classList.add('saved');
    if (field === 'tags') loadMeta();
    if (field === 'spread_months') {
      const td = tr.querySelector('td.amt');
      td.innerHTML = amountCell(tx);
      td.classList.remove('saved');
      void td.offsetWidth;
      td.classList.add('saved');
      toast(tx.spread_months > 1 ? `Counting ${spreadDetail(tx)}` : 'Counted once, in the month it was paid');
      return;
    }
    if (field === 'category') {
      const isNew = !state.meta.categories.includes(out.category);
      await loadMeta();
      // A brand-new category has to show up in every row's list, not just this one.
      if (isNew) {
        $$('select[data-f="category"]', $('#txTable tbody')).forEach((sel) => {
          sel.innerHTML = catOptions(state.tx.find((t) => t.id === sel.closest('tr').dataset.id).category);
        });
      } else input.value = out.category;
      if (out.similar > 0) offerApplySimilar(id, out);
    }
  } catch (e) {
    toast(e.message, true);
  }
}

function offerApplySimilar(id, out) {
  const n = out.similar;
  toast(`Saved. New “${esc(out.merchantName)}” transactions will be ${esc(out.category)} too. ` +
    `<button class="link" id="applySimilar">Change ${n} older one${n === 1 ? '' : 's'}</button>`, false, true);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 9000);
  $('#applySimilar').addEventListener('click', async () => {
    try {
      const r = await api(`/api/transactions/${encodeURIComponent(id)}/apply-to-similar`, { method: 'POST' });
      toast(`Changed ${r.updated} transaction${r.updated === 1 ? '' : 's'} to ${r.category}`);
      loadTransactions();
    } catch (e) { toast(e.message, true); }
  });
}

const tbody = $('#txTable tbody');
tbody.addEventListener('change', (e) => {
  if (e.target.classList.contains('sel')) {
    const id = e.target.closest('tr').dataset.id;
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    return updateBulk();
  }
  if (e.target.dataset.f) saveField(e.target);
});
tbody.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !e.target.dataset.f) return;
  e.preventDefault();
  const field = e.target.dataset.f;
  const next = e.target.closest('tr').nextElementSibling;
  e.target.blur(); // triggers change -> save
  if (next) $(`[data-f="${field}"]`, next).focus();
});

function updateBulk() {
  $('#bulkBar').classList.toggle('hidden', state.selected.size === 0);
  $('#bulkCount').textContent = `${state.selected.size} selected`;
  // Sum of the selected rows (cents math avoids floating-point drift like 0.1 + 0.2).
  const cents = state.tx.reduce((acc, t) => acc + (state.selected.has(t.id) ? Math.round(t.amount * 100) : 0), 0);
  const sumEl = $('#bulkSum');
  sumEl.textContent = `Total: ${money(cents / 100)}`;
  sumEl.classList.toggle('pos', cents > 0);
  $('#selAll').checked = state.tx.length > 0 && state.selected.size === state.tx.length;
  $('#bulkUntagMenu').classList.add('hidden');
}
$('#selAll').addEventListener('change', (e) => {
  state.selected = new Set(e.target.checked ? state.tx.map((t) => t.id) : []);
  renderTx();
});
async function bulk(body, msg) {
  await api('/api/transactions/bulk', { method: 'POST', body: { ids: [...state.selected], ...body } });
  toast(msg || `Updated ${state.selected.size} transactions`);
  await loadMeta();
  await loadTransactions({ keepSelection: true });
}
$('#bulkTagBtn').addEventListener('click', async () => {
  const input = $('#bulkTag');
  if (!input.value.trim()) return;
  try {
    await bulk({ addTags: input.value });
    input.value = '';
  } catch (e) { toast(e.message, true); }
});
$('#bulkCat').addEventListener('change', async (e) => {
  if (e.target.value !== NEW_CAT) return;
  const sel = e.target;
  const name = await askNewCategory(sel, '');
  if (name) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(name)}">${esc(name)}</option>`);
    sel.value = name;
  }
});
$('#bulkCatBtn').addEventListener('click', () => $('#bulkCat').value && $('#bulkCat').value !== NEW_CAT && bulk({ category: $('#bulkCat').value }));
$('#bulkClear').addEventListener('click', () => { state.selected.clear(); renderTx(); });
$('#bulkTag').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#bulkTagBtn').click(); } });

// ---------- bulk: remove tags ----------
// Lists the tags found on the selected transactions (with how many have each) so they can be removed in one go.
function tagsOnSelected() {
  const counts = new Map();
  for (const t of state.tx) {
    if (!state.selected.has(t.id)) continue;
    for (const tag of t.tags.split(',').filter(Boolean)) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
$('#bulkUntagBtn').addEventListener('click', () => {
  const menu = $('#bulkUntagMenu');
  if (!menu.classList.contains('hidden')) return menu.classList.add('hidden');
  const tags = tagsOnSelected();
  menu.innerHTML = tags.length
    ? tags.map(([tag, n]) => `<button data-tag="${esc(tag)}" role="menuitem"><span>${esc(tag)}</span><span class="count">${n}</span></button>`).join('') +
      `<hr><button data-all="1" class="danger" role="menuitem">Remove all tags</button>`
    : '<div class="empty-note">The selected transactions have no tags.</div>';
  menu.classList.remove('hidden');
});
$('#bulkUntagMenu').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  $('#bulkUntagMenu').classList.add('hidden');
  const n = state.selected.size;
  const label = `${n} transaction${n === 1 ? '' : 's'}`;
  if (btn.dataset.all) bulk({ clearTags: true }, `Removed all tags from ${label}`);
  else bulk({ removeTags: btn.dataset.tag }, `Removed “${btn.dataset.tag}” from ${label}`);
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('.menu-wrap')) $('#bulkUntagMenu').classList.add('hidden');
});

// ---------- tag suggestions ----------
// While typing in any tag box (the bulk bar or a row's Tags cell), show existing tags that match the word being typed.
// ↑/↓ to move, Enter or Tab to pick, Esc to close.
const tagNorm = (t) => t.trim().toLowerCase().replace(/\s+/g, '-');
const suggest = { box: null, input: null, items: [], active: 0 };
const isTagInput = (el) => !!el && el.tagName === 'INPUT' && (el.id === 'bulkTag' || el.dataset.f === 'tags');

// The comma-separated piece of the box the caret is in.
function tagToken(input) {
  const v = input.value;
  const caret = input.selectionStart ?? v.length;
  const start = v.lastIndexOf(',', caret - 1) + 1;
  let end = v.indexOf(',', caret);
  if (end < 0) end = v.length;
  return { start, end, word: tagNorm(v.slice(start, end)) };
}

function hideSuggestions() {
  suggest.box?.remove();
  Object.assign(suggest, { box: null, input: null, items: [], active: 0 });
}

function showSuggestions(input) {
  const { word } = tagToken(input);
  if (!word) return hideSuggestions();
  const already = new Set(input.value.split(',').map(tagNorm).filter(Boolean));
  const matches = state.meta.tags.filter((t) => t !== word && !already.has(t) && t.includes(word));
  matches.sort((a, b) => (b.startsWith(word) - a.startsWith(word)) || a.localeCompare(b));
  const items = matches.slice(0, 8);
  if (!items.length) return hideSuggestions();
  if (!suggest.box) {
    suggest.box = document.createElement('div');
    suggest.box.className = 'tag-suggest';
    suggest.box.setAttribute('role', 'listbox');
    // mousedown would blur the box (and save the row) before the click lands, so keep focus where it is.
    suggest.box.addEventListener('mousedown', (e) => e.preventDefault());
    suggest.box.addEventListener('click', (e) => {
      const el = e.target.closest('[data-i]');
      if (el) pickSuggestion(Number(el.dataset.i));
    });
    document.body.appendChild(suggest.box);
  }
  suggest.input = input;
  suggest.items = items;
  suggest.active = 0;
  const hl = (t) => { const i = t.indexOf(word); return esc(t.slice(0, i)) + `<b>${esc(word)}</b>` + esc(t.slice(i + word.length)); };
  suggest.box.innerHTML = items.map((t, i) => `<div data-i="${i}" role="option"${i === 0 ? ' class="active"' : ''}>${hl(t)}</div>`).join('');
  const r = input.getBoundingClientRect();
  suggest.box.style.left = `${r.left}px`;
  suggest.box.style.top = `${r.bottom + 4}px`;
  suggest.box.style.minWidth = `${Math.max(r.width, 160)}px`;
}

function moveSuggestion(step) {
  const n = suggest.items.length;
  suggest.active = (suggest.active + step + n) % n;
  $$('[data-i]', suggest.box).forEach((el, i) => el.classList.toggle('active', i === suggest.active));
  $$('[data-i]', suggest.box)[suggest.active].scrollIntoView({ block: 'nearest' });
}

function pickSuggestion(i) {
  const input = suggest.input;
  const tag = suggest.items[i];
  if (!input || !tag) return;
  const { start, end } = tagToken(input);
  const v = input.value;
  const before = v.slice(0, start);
  const rest = v.slice(end).replace(/^\s*,?\s*/, '');
  const head = `${before}${start > 0 ? ' ' : ''}${tag}, `;
  input.value = head + rest;
  input.setSelectionRange(head.length, head.length);
  hideSuggestions();
  input.focus();
}

document.addEventListener('input', (e) => { if (isTagInput(e.target)) showSuggestions(e.target); });
document.addEventListener('focusout', (e) => { if (e.target === suggest.input) hideSuggestions(); });
// Capture phase, so picking a suggestion with Enter doesn't also save the row / jump to the next one.
document.addEventListener('keydown', (e) => {
  if (!suggest.box || e.target !== suggest.input) return;
  const keys = { ArrowDown: () => moveSuggestion(1), ArrowUp: () => moveSuggestion(-1),
    Enter: () => pickSuggestion(suggest.active), Tab: () => pickSuggestion(suggest.active), Escape: hideSuggestions };
  if (!keys[e.key]) return;
  e.preventDefault();
  e.stopPropagation();
  keys[e.key]();
}, true);
window.addEventListener('scroll', hideSuggestions, true);
window.addEventListener('resize', hideSuggestions);

let searchTimer;
for (const id of ['#fSearch', '#fAmount']) {
  $(id).addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTransactions, 250); });
}
['#fAccount', '#fCategory', '#fTag', '#fUntagged', '#fAllTime'].forEach((s) => $(s).addEventListener('change', loadTransactions));

// ---------- accounts ----------
async function loadAccounts() {
  const [enrolls, accounts] = await Promise.all([api('/api/enrollments'), api('/api/accounts')]);
  $('#enrollList').innerHTML = enrolls.length
    ? enrolls.map((e) => `<div class="enroll">
        <div><strong>${esc(e.institution || e.id)}</strong>
          <div class="hint status-${esc(e.status)}">${e.status === 'ok' ? 'Connected' : esc(e.status)}${e.last_error ? ' — ' + esc(e.last_error) : ''}
          ${e.last_synced_at ? ' · last synced ' + new Date(e.last_synced_at).toLocaleString() : ''}</div></div>
        <div>${e.status === 'disconnected' ? `<button class="reconnect" data-id="${esc(e.id)}">Reconnect</button> ` : ''}<button class="ghost remove" data-id="${esc(e.id)}" data-provider="${esc(e.provider)}">Remove</button></div>
      </div>`).join('')
    : '<div class="hint">No banks connected yet. Add your Plaid keys in Settings, then click Connect.</div>';

  $('#accTable tbody').innerHTML = accounts.map((a) => `<tr data-id="${esc(a.id)}">
      <td><strong>${esc(a.name)}</strong> <span class="hint">${esc(a.institution || '')} ····${esc(a.last_four || '')}</span></td>
      <td>${esc(a.subtype || a.type || '')}</td>
      <td class="num">${a.balance_available != null ? money(Number(a.balance_available)) : '–'}</td>
      <td class="num">${a.balance_ledger != null ? money(Number(a.balance_ledger)) : '–'}</td>
      <td class="num">${a.tx_count}</td>
      <td><input type="checkbox" data-k="invert_sign" ${a.invert_sign ? 'checked' : ''}></td>
      <td><input type="checkbox" data-k="hidden" ${a.hidden ? 'checked' : ''}></td>
    </tr>`).join('');

  const f = $('#fAccount');
  const cur = f.value;
  f.innerHTML = '<option value="">All accounts</option>' + accounts.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} ····${esc(a.last_four || '')}</option>`).join('');
  f.value = cur;
  const latest = enrolls.map((e) => e.last_synced_at).filter(Boolean).sort().pop();
  $('#lastSync').textContent = latest ? `Last sync ${new Date(latest).toLocaleString()}` : '';
}
$('#accTable').addEventListener('change', async (e) => {
  const k = e.target.dataset.k;
  if (!k) return;
  await api(`/api/accounts/${encodeURIComponent(e.target.closest('tr').dataset.id)}`, { method: 'PATCH', body: { [k]: e.target.checked } });
  toast('Account updated');
});
$('#enrollList').addEventListener('click', async (e) => {
  if (e.target.classList.contains('remove')) {
    const msg = e.target.dataset.provider === 'teller'
      ? 'Remove this old Teller connection? Any history Plaid did not re-download (and its tags/notes) will be deleted.'
      : 'Remove this bank and all its downloaded transactions from Budget Buddy?';
    if (!confirm(msg)) return;
    await api(`/api/enrollments/${encodeURIComponent(e.target.dataset.id)}`, { method: 'DELETE' });
    await loadMeta();
    loadAccounts();
  }
  if (e.target.classList.contains('reconnect')) connectBank(e.target.dataset.id);
});

// Plaid Link. With enrollmentId it runs in "update mode" to fix an expired bank login.
async function connectBank(enrollmentId) {
  if (!window.Plaid) return toast('Plaid Link failed to load — check your internet connection.', true);
  let token;
  try {
    ({ link_token: token } = await api('/api/plaid/link-token', { method: 'POST', body: { enrollmentId } }));
  } catch (e) {
    toast(e.message, true);
    if (e.code === 'config.missing_keys') location.hash = 'settings';
    return;
  }
  const handler = window.Plaid.create({
    token,
    onSuccess: async (publicToken, metadata) => {
      try {
        if (enrollmentId) await api(`/api/enrollments/${encodeURIComponent(enrollmentId)}/reconnected`, { method: 'POST' });
        else await api('/api/enrollments', { method: 'POST', body: { public_token: publicToken, institution: metadata.institution } });
        toast('Bank connected — syncing…');
        await runSync();
      } catch (e) { toast(e.message, true); }
    },
    onExit: (err) => err && toast(`Plaid: ${err.display_message || err.error_message || err.error_code}`, true),
  });
  handler.open();
}
$('#connectBtn').addEventListener('click', () => connectBank());
$('#demoBtn').addEventListener('click', (e) => busy(e.target, async () => {
  const r = await api('/api/demo', { method: 'POST' });
  toast(`Loaded ${r.transactions} demo transactions. Remove “Demo Bank” anytime.`);
  await loadMeta();
  loadAccounts();
}));

// ---------- sync / export ----------
async function runSync() {
  const { results } = await api('/api/sync', { method: 'POST' });
  const errs = results.filter((r) => r.error);
  const n = results.reduce((a, r) => a + r.transactions, 0);
  if (!results.length) toast('No real banks connected yet — connect one under Accounts.');
  else if (errs.length) toast(errs.map((r) => `${r.institution || r.enrollment}: ${r.error}`).join(' · '), true);
  else {
    const moved = results.reduce((a, r) => a + (r.carriedOver || 0), 0);
    const note = results.map((r) => r.note).find(Boolean);
    toast(`Synced ${n} transactions from ${results.length} bank(s)` +
      (moved ? ` · carried over ${moved} from Teller` : '') + (note ? ` · ${note}` : ''));
  }
  await loadMeta();
  show(state.view);
}
$('#syncBtn').addEventListener('click', (e) => busy(e.target, runSync));
// ---------- export tab ----------
// Plain-English list of the Transactions-page filters that are currently set.
function activeFilters() {
  const out = [];
  const sel = (id) => { const el = $(id); return el.value ? el.selectedOptions[0].textContent : ''; };
  if ($('#fSearch').value.trim()) out.push(`“${$('#fSearch').value.trim()}”`);
  if ($('#fAmount').value.trim()) out.push(`amount ${$('#fAmount').value.trim()}`);
  if (sel('#fAccount')) out.push(sel('#fAccount'));
  if (sel('#fCategory')) out.push(sel('#fCategory'));
  if (sel('#fTag')) out.push(`tag ${sel('#fTag')}`);
  if ($('#fUntagged').checked) out.push('untagged only');
  return out;
}
function loadExport() {
  const all = $('#exAllTime').checked;
  $('#exportRange').textContent = all ? 'All dates' : currentRange().label;
  const f = activeFilters();
  $('#exFilterSummary').textContent = f.length ? `(${f.join(', ')})` : '(none set right now)';
}
$('#exAllTime').addEventListener('change', loadExport);
$('#csvBtn').addEventListener('click', () => {
  const allTime = $('#exAllTime').checked;
  const q = $('#exUseFilters').checked ? txQuery({ allTime }) : (allTime ? '' : setRangeParams(new URLSearchParams()).toString());
  location.href = `/api/export.csv?${q}`;
});
$('#sheetsBtn').addEventListener('click', (e) => busy(e.target, async () => {
  const all = $('#exAllTime').checked;
  const range = currentRange();
  const body = all ? {} : range.month ? { month: range.month } : { from: range.from, to: range.to, label: range.label };
  const r = await api('/api/export/sheets', { method: 'POST', body });
  toast(`Exported ${r.rows} rows to Google Sheets${r.url ? ` — <a href="${esc(r.url)}" target="_blank">open sheet</a>` : ''}`, false, true);
}));

// ---------- settings ----------
async function loadSettings() {
  const cfg = await api('/api/config');
  const form = $('#settingsForm');
  for (const [k, v] of Object.entries(cfg)) if (form.elements[k]) form.elements[k].value = v;
}

// ---------- category manager ----------
async function loadCategoryManager() {
  const { categories, rules } = await api('/api/categories/manage');
  $('#catManage tbody').innerHTML = categories.map((c) => `<tr data-name="${esc(c.name)}">
      <td class="name">${esc(c.name)}${c.builtin ? ' <span class="hint">built in</span>' : ''}</td>
      <td class="num">${c.count}</td>
      <td class="num">${c.budget ? money(c.budget) : '<span class="hint">–</span>'}</td>
      <td class="center"><input type="checkbox" class="exclude-cat" ${c.excluded ? 'checked' : ''} ${c.excludeLocked ? 'disabled title="Transfers are never counted, so card payments and moves between your accounts aren\'t double counted"' : ''}></td>
      <td class="num">${c.builtin ? '' : '<button class="ghost small rename">Rename</button> <button class="ghost small del">Delete</button>'}</td>
    </tr>`).join('');
  $('#ruleList').innerHTML = rules.length
    ? rules.map((r) => `<div class="rule" data-merchant="${esc(r.merchant)}"><span><strong>${esc(r.merchant)}</strong> → ${esc(r.category)}</span>
        <button class="ghost small forget" title="Stop auto-categorizing this merchant">Forget</button></div>`).join('')
    : '<div class="hint">None yet. When you change a transaction’s category, its merchant shows up here.</div>';
}
$('#addCategory').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { name } = await api('/api/categories', { method: 'POST', body: { name: e.target.elements.name.value } });
    e.target.reset();
    toast(`Added “${name}”`);
    await loadMeta();
    loadCategoryManager();
  } catch (err) { toast(err.message, true); }
});
$('#catManage').addEventListener('click', async (e) => {
  const tr = e.target.closest('tr[data-name]');
  if (!tr) return;
  const name = tr.dataset.name;
  if (e.target.classList.contains('del')) {
    if (!confirm(`Delete “${name}”? Its transactions become Uncategorized and its budget is removed.`)) return;
    try {
      const r = await api(`/api/categories?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
      toast(`Deleted “${name}”${r.moved ? ` · ${r.moved} transaction${r.moved === 1 ? '' : 's'} now Uncategorized` : ''}`);
    } catch (err) { return toast(err.message, true); }
    await loadMeta();
    loadCategoryManager();
  }
  if (e.target.classList.contains('rename')) {
    const cell = $('.name', tr);
    cell.innerHTML = `<input class="rename-input" value="${esc(name)}" maxlength="60">`;
    const input = $('input', cell);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const to = input.value.trim();
      if (save && to && to !== name) {
        try {
          const r = await api('/api/categories', { method: 'PATCH', body: { from: name, to } });
          toast(r.name === to ? `Renamed to “${r.name}”` : `Merged into “${r.name}”`);
          await loadMeta();
        } catch (err) { toast(err.message, true); }
      }
      loadCategoryManager();
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') finish(true);
      if (ev.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
  }
});
$('#catManage').addEventListener('change', async (e) => {
  if (!e.target.classList.contains('exclude-cat')) return;
  const name = e.target.closest('tr[data-name]').dataset.name;
  const excluded = e.target.checked;
  try {
    await api('/api/categories/exclude', { method: 'PUT', body: { name, excluded } });
    toast(excluded ? `“${name}” is no longer counted in totals` : `“${name}” is counted in totals again`);
    await loadMeta();
  } catch (err) {
    e.target.checked = !e.target.checked;
    toast(err.message, true);
  }
});
$('#ruleList').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('forget')) return;
  await api(`/api/category-rules?merchant=${encodeURIComponent(e.target.closest('.rule').dataset.merchant)}`, { method: 'DELETE' });
  loadCategoryManager();
});
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/config', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
  toast('Settings saved');
});

// ---------- boot ----------
try {
  const saved = JSON.parse(localStorage.getItem('bb.range') || 'null');
  if (saved && ['month', 'year', 'ytd', 'custom'].includes(saved.mode)) Object.assign(state.range, saved);
} catch {}
if (state.range.mode === 'custom' && !(state.range.from && state.range.to)) state.range.mode = 'month';
renderRangeControls();
$('#month').addEventListener('change', (e) => e.target.value && setMonth(e.target.value));
$('#rangeMode').addEventListener('change', (e) => setRangeMode(e.target.value));
for (const id of ['#fromDate', '#toDate']) {
  $(id).addEventListener('change', () => {
    const from = $('#fromDate').value, to = $('#toDate').value;
    if (!from || !to) return;
    state.range.from = from;
    state.range.to = to;
    refreshRange();
  });
}
// Toolbar Undo/Redo: same as Edit → Undo/Redo (Ctrl+Z / Ctrl+Y), acting on the text box you're typing in.
const isTextField = (el) => el && (el.tagName === 'TEXTAREA' ||
  (el.tagName === 'INPUT' && /^(text|search|number|email|url|tel|password|)$/.test(el.type)));
function updateEditTools() {
  const on = isTextField(document.activeElement);
  $('#undoBtn').disabled = !on;
  $('#redoBtn').disabled = !on;
}
['undo', 'redo'].forEach((cmd) => {
  const btn = $(`#${cmd}Btn`);
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus (and the cursor) in the text box
  btn.addEventListener('click', () => {
    if (isTextField(document.activeElement)) document.execCommand(cmd);
  });
});
document.addEventListener('focusin', updateEditTools);
document.addEventListener('focusout', () => setTimeout(updateEditTools));
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (state.view === 'projections' && e.key.startsWith('Arrow')) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  if (e.key === 'ArrowRight') shiftMonth(1);
  if (e.key === '/') { e.preventDefault(); location.hash = 'transactions'; $('#fSearch').focus(); }
  if (e.key === ',' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); location.hash = 'settings'; }
});
(async () => {
  await loadMeta();
  await loadAccounts();
  show(location.hash.slice(1) || 'dashboard');
})().catch((e) => toast(e.message, true));
