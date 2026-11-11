'use strict';
/* Budget Buddy front end — plain JS, no build step. */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const money = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = { month: new Date().toISOString().slice(0, 7), view: 'dashboard', tx: [], selected: new Set(), meta: { categories: [], tags: [], budgets: [] } };

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
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === view));
  ({ dashboard: loadDashboard, transactions: loadTransactions, accounts: loadAccounts, settings: loadSettings })[view]();
}
window.addEventListener('hashchange', () => show(location.hash.slice(1) || 'dashboard'));

function setMonth(m) {
  state.month = m;
  $('#month').value = m;
  if (state.view === 'dashboard') loadDashboard();
  if (state.view === 'transactions') loadTransactions();
}
function shiftMonth(delta) {
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
}

// ---------- dashboard ----------
async function loadDashboard() {
  const s = await api(`/api/summary?month=${state.month}`);
  $('#tIncome').textContent = money(s.income);
  $('#tSpending').textContent = money(s.spending);
  $('#tNet').textContent = money(s.net);
  $('#tNet').className = 'value ' + (s.net >= 0 ? 'pos' : 'neg');

  const max = Math.max(1, ...s.byCategory.map((c) => Math.max(c.spent, c.budget || 0)));
  $('#catList').innerHTML = s.byCategory.length
    ? s.byCategory.map((c) => {
        const pct = c.budget ? c.spent / c.budget : 0;
        const cls = c.budget ? (pct > 1 ? 'over' : pct > 0.85 ? 'near' : '') : '';
        const width = ((c.budget ? Math.min(c.spent, c.budget) / c.budget : c.spent / max) * 100).toFixed(1);
        return `<div class="cat-row" data-cat="${esc(c.category)}">
          <div class="cat-name">${esc(c.category)}</div>
          <div class="bar ${cls}"><span style="width:${width}%"></span></div>
          <div class="cat-amt">${money(c.spent)} <span class="budget" data-budget="${esc(c.category)}">${c.budget ? `of ${money(c.budget)}` : '+ budget'}</span></div>
        </div>`;
      }).join('')
    : '<div class="empty">No spending this month yet. Connect a bank or load demo data from Accounts.</div>';

  $('#tagList').innerHTML = s.byTag.length
    ? s.byTag.map((t) => `<div class="tag-row" data-tag="${esc(t.tag)}"><span class="chip">${esc(t.tag)}</span><span>${money(t.spent)} · ${t.count} txn</span></div>`).join('')
    : '<div class="hint">Tag transactions (e.g. “work-trip”, “gift”) to see them grouped here.</div>';

  drawDaily(s);
}

function drawDaily(s) {
  const [y, m] = s.month.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const map = Object.fromEntries(s.daily.map((d) => [Number(d.date.slice(8)), d.spent]));
  const max = Math.max(1, ...Object.values(map));
  const W = 700, H = 140, pad = 18, bw = (W - 10) / days;
  let bars = '';
  for (let d = 1; d <= days; d++) {
    const v = map[d] || 0;
    const h = (v / max) * (H - pad - 6);
    bars += `<rect x="${5 + (d - 1) * bw + 1}" y="${H - pad - h}" width="${Math.max(1, bw - 2)}" height="${h}" rx="2"><title>${s.month}-${String(d).padStart(2, '0')}: ${money(v)}</title></rect>`;
    if (d === 1 || d % 5 === 0) bars += `<text x="${5 + (d - 1) * bw + bw / 2}" y="${H - 4}" text-anchor="middle">${d}</text>`;
  }
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

// ---------- transactions ----------
function txQuery() {
  const p = new URLSearchParams();
  if (!$('#fAllTime').checked) p.set('month', state.month);
  if ($('#fSearch').value) p.set('q', $('#fSearch').value);
  if ($('#fAccount').value) p.set('account', $('#fAccount').value);
  if ($('#fCategory').value) p.set('category', $('#fCategory').value);
  if ($('#fTag').value) p.set('tag', $('#fTag').value);
  if ($('#fUntagged').checked) p.set('untagged', '1');
  return p.toString();
}

async function loadTransactions() {
  state.tx = await api(`/api/transactions?${txQuery()}`);
  state.selected.clear();
  renderTx();
}

function renderTx() {
  const tbody = $('#txTable tbody');
  tbody.innerHTML = state.tx.map((t) => `
    <tr data-id="${esc(t.id)}" class="${t.exclude ? 'excluded' : ''}">
      <td class="cb"><input type="checkbox" class="sel" ${state.selected.has(t.id) ? 'checked' : ''}></td>
      <td class="date">${esc(t.date)}</td>
      <td class="desc"><div class="main" title="${esc(t.description)}">${esc(t.counterparty || t.description)}${t.status === 'pending' ? '<span class="pending">pending</span>' : ''}</div>
        <div class="sub">${esc(t.counterparty ? t.description : '')} · ${esc(t.account_name)}</div></td>
      <td class="cat"><input data-f="category" list="categoryOptions" value="${esc(t.category)}"></td>
      <td class="tags"><input data-f="tags" value="${esc(t.tags.split(',').filter(Boolean).join(', '))}" placeholder="add tags"></td>
      <td class="note"><input data-f="note" value="${esc(t.note)}" placeholder="add a note"></td>
      <td class="num ${t.amount < 0 ? '' : 'pos'}">${money(t.amount)}</td>
      <td><input type="checkbox" data-f="exclude" ${t.exclude ? 'checked' : ''} title="Exclude from budget totals"></td>
    </tr>`).join('');
  const empty = $('#txEmpty');
  empty.classList.toggle('hidden', state.tx.length > 0);
  empty.textContent = 'No transactions match. Try “All months”, clear filters, or Sync.';
  updateBulk();
}

async function saveField(input) {
  const tr = input.closest('tr');
  const id = tr.dataset.id;
  const field = input.dataset.f;
  const value = field === 'exclude' ? input.checked : input.value;
  const tx = state.tx.find((t) => t.id === id);
  const prev = field === 'exclude' ? !!tx.exclude : field === 'tags' ? tx.tags.split(',').filter(Boolean).join(', ') : tx[field];
  if (prev === value) return;
  try {
    const out = await api(`/api/transactions/${encodeURIComponent(id)}`, { method: 'PATCH', body: { [field]: value } });
    Object.assign(tx, out);
    if (field === 'tags') input.value = out.tags.split(',').filter(Boolean).join(', ');
    if (field === 'exclude') tr.classList.toggle('excluded', !!out.exclude);
    input.closest('td').classList.remove('saved');
    void input.offsetWidth;
    input.closest('td').classList.add('saved');
    if (field === 'tags' || field === 'category') loadMeta();
  } catch (e) {
    toast(e.message, true);
  }
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
  $('#selAll').checked = state.tx.length > 0 && state.selected.size === state.tx.length;
}
$('#selAll').addEventListener('change', (e) => {
  state.selected = new Set(e.target.checked ? state.tx.map((t) => t.id) : []);
  renderTx();
});
async function bulk(body) {
  await api('/api/transactions/bulk', { method: 'POST', body: { ids: [...state.selected], ...body } });
  toast(`Updated ${state.selected.size} transactions`);
  await loadMeta();
  loadTransactions();
}
$('#bulkTagBtn').addEventListener('click', () => $('#bulkTag').value && bulk({ addTags: $('#bulkTag').value }));
$('#bulkCatBtn').addEventListener('click', () => $('#bulkCat').value && bulk({ category: $('#bulkCat').value }));
$('#bulkClear').addEventListener('click', () => { state.selected.clear(); renderTx(); });

let searchTimer;
$('#fSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadTransactions, 250); });
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
$('#csvBtn').addEventListener('click', () => { location.href = `/api/export.csv?${txQuery()}`; });
$('#sheetsBtn').addEventListener('click', (e) => busy(e.target, async () => {
  const r = await api('/api/export/sheets', { method: 'POST', body: { month: $('#fAllTime').checked && state.view === 'transactions' ? null : state.month } });
  toast(`Exported ${r.rows} rows to Google Sheets${r.url ? ` — <a href="${esc(r.url)}" target="_blank">open sheet</a>` : ''}`, false, true);
}));

// ---------- settings ----------
async function loadSettings() {
  const cfg = await api('/api/config');
  const form = $('#settingsForm');
  for (const [k, v] of Object.entries(cfg)) if (form.elements[k]) form.elements[k].value = v;
}
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  await api('/api/config', { method: 'PUT', body: Object.fromEntries(new FormData(e.target)) });
  toast('Settings saved');
});

// ---------- boot ----------
$('#month').value = state.month;
$('#month').addEventListener('change', (e) => e.target.value && setMonth(e.target.value));
$('#prevMonth').addEventListener('click', () => shiftMonth(-1));
$('#nextMonth').addEventListener('click', () => shiftMonth(1));
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'ArrowLeft') shiftMonth(-1);
  if (e.key === 'ArrowRight') shiftMonth(1);
  if (e.key === '/') { e.preventDefault(); location.hash = 'transactions'; $('#fSearch').focus(); }
});
(async () => {
  await loadMeta();
  await loadAccounts();
  show(location.hash.slice(1) || 'dashboard');
})().catch((e) => toast(e.message, true));
