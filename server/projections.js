'use strict';
// Projections: how much is left to spend this month (or year), and what the bank balance should be
// at the end of the week and the period. Paychecks are found from your Income transactions and can
// be adjusted; spending still to come uses your budgets, or what you usually spend when there's none.
// Paychecks that change size (hours, overtime, holiday pay) are estimated from their recent history
// in a way you pick, and the projection shows a low-to-high range around that estimate.
const categories = require('./categories');

const AMT = 'CASE WHEN a.invert_sign=1 THEN -t.amount ELSE t.amount END';
const DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const utc = (d) => Date.parse(d + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const addDays = (d, n) => iso(utc(d) + Math.round(n) * DAY);
const diffDays = (a, b) => Math.round((utc(b) - utc(a)) / DAY); // b minus a
const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const parts = (d) => d.split('-').map(Number);
const monthEnd = (d) => { const [y, m] = parts(d); return ymd(y, m, lastDay(y, m)); };
const addMonths = (d, n) => { let [y, m] = parts(d); m += n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return ymd(y, m, 1); };
const round2 = (n) => Math.round(n * 100) / 100;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };
const mean = (xs) => xs.reduce((a, x) => a + x, 0) / xs.length;
// Percentile with straight-line interpolation between values (p = 0.25 is the lower quartile).
const percentile = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo);
};

// Ways to estimate a paycheck that isn't the same every time, from the last 6 months of paychecks.
const ESTIMATES = {
  average: 'Average of the last 6 months', // smooths out busy/slow weeks and holiday pay over time
  recent: 'Average of the last 4', // follows a recent raise or change in hours
  median: 'Typical paycheck', // the middle one: a one-off big or small check doesn't move it
  low: 'Conservative', // a slower-than-usual paycheck (3 in 4 were at least this much)
  last: 'Last paycheck',
};
// A paycheck counts as "varies" when its size swings by more than 10% of the average.
const VARIES = 0.1;

// The estimates and range for one payer's paychecks (oldest first).
function payStats(amounts) {
  const recent = amounts.slice(-4);
  const avg = mean(amounts);
  const min = Math.min(...amounts);
  const max = Math.max(...amounts);
  return {
    estimates: Object.fromEntries(Object.entries({
      average: avg, recent: mean(recent), median: median(amounts), low: percentile(amounts, 0.25), last: amounts.at(-1),
    }).map(([k, v]) => [k, round2(v)])),
    // Where most paychecks land (middle half), and the smallest/largest seen.
    low: round2(percentile(amounts, 0.25)), high: round2(percentile(amounts, 0.75)), min: round2(min), max: round2(max),
    variable: amounts.length >= 3 && avg > 0 && (max - min) / avg > VARIES,
  };
}

const FREQUENCIES = { weekly: 7, biweekly: 14, semimonthly: 365.25 / 24, monthly: 365.25 / 12 };
const EOM = 31; // pay day "last day of the month"

// Day of month, with the last day of a month saved as EOM so it lands on Feb 28, Apr 30, etc.
function domOf(d) {
  const [y, m, day] = parts(d);
  return day === lastDay(y, m) ? EOM : day;
}
// The other pay day of a twice-a-month schedule: 1 → 15, 15 → 1 (or 29), last day → 15.
function pairDays(dom) {
  const other = dom >= 28 ? 15 : dom <= 14 ? dom + 14 : dom - 14;
  return [dom, other >= 28 ? EOM : other].sort((a, b) => a - b);
}

// Every pay date of a schedule between from and to (inclusive).
function payDates(s, from, to) {
  if (!s.anchor || from > to) return [];
  const out = [];
  if (s.frequency === 'weekly' || s.frequency === 'biweekly') {
    const step = FREQUENCIES[s.frequency];
    const k = Math.ceil(diffDays(s.anchor, from) / step);
    for (let d = addDays(s.anchor, k * step); d <= to; d = addDays(d, step)) out.push(d);
    return out;
  }
  const days = s.frequency === 'monthly' ? [domOf(s.anchor)] : s.days || pairDays(domOf(s.anchor));
  let [y, m] = parts(from);
  for (;;) {
    if (ymd(y, m, 1) > to) break;
    for (const d of days) {
      const date = ymd(y, m, Math.min(d, lastDay(y, m)));
      if (date >= from && date <= to) out.push(date);
    }
    if (++m > 12) { m = 1; y++; }
  }
  return [...new Set(out)].sort();
}

// How far a date is from a pay day of the month (looking at the month before and after too).
function distanceToDay(date, dom) {
  const [y, m] = parts(date);
  let best = Infinity;
  for (const off of [-1, 0, 1]) {
    const first = addMonths(ymd(y, m, 1), off);
    const [yy, mm] = parts(first);
    best = Math.min(best, Math.abs(diffDays(date, ymd(yy, mm, Math.min(dom, lastDay(yy, mm))))));
  }
  return best;
}

// Paychecks: Income deposits from the last 6 months, grouped by who paid them, with a regular schedule.
function detectStreams(db, today) {
  const rows = db
    .prepare(
      `SELECT t.date, ${AMT} AS amount, t.counterparty, t.description FROM transactions t JOIN accounts a ON a.id=t.account_id
       WHERE a.hidden=0 AND a.in_projections=1 AND t.exclude=0 AND t.category='Income' AND t.date BETWEEN ? AND ? ORDER BY t.date`
    )
    .all(addDays(today, -183), today)
    .filter((r) => r.amount > 0);
  const groups = new Map();
  for (const r of rows) {
    const key = categories.merchantKey(r) || 'income';
    const g = groups.get(key) || { key, name: 'Income', deposits: [] };
    g.name = r.counterparty || r.description || g.name;
    // Deposits from the same payer within 3 days are one paycheck (e.g. split between two accounts).
    const last = g.deposits.at(-1);
    if (last && diffDays(last.date, r.date) <= 3) last.amount += r.amount;
    else g.deposits.push({ date: r.date, amount: r.amount });
    groups.set(key, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const dates = g.deposits.map((d) => d.date);
    if (dates.length < 2) continue;
    const gap = median(dates.slice(1).map((d, i) => diffDays(dates[i], d)));
    let frequency;
    let days = null;
    if (gap < 5) continue; // too frequent to be a paycheck (e.g. daily gig payouts)
    else if (gap <= 10) frequency = 'weekly';
    else if (gap <= 18) {
      // Paid on the same two days each month (1st & 15th) vs. every other week (the day drifts).
      const [a, b] = [domOf(dates.at(-2)), domOf(dates.at(-1))].sort((x, y) => x - y);
      const semi = dates.length >= 3 && a !== b && dates.every((d) => Math.min(distanceToDay(d, a), distanceToDay(d, b)) <= 3);
      frequency = semi ? 'semimonthly' : 'biweekly';
      if (semi) days = [a, b];
    } else if (gap <= 40) frequency = 'monthly';
    else continue;
    const stats = payStats(g.deposits.map((d) => d.amount));
    // Steady paychecks keep using the last 4; ones that vary default to the 6-month average.
    const estimate = stats.variable ? 'average' : 'recent';
    out.push({
      key: g.key, name: g.name, frequency, days, gap, estimate, ...stats,
      amount: stats.estimates[estimate],
      averagedOver: Math.min(4, g.deposits.length), deposits: dates.length, lastDate: dates.at(-1),
      history: g.deposits.slice(-12).map((d) => ({ date: d.date, amount: round2(d.amount) })),
    });
  }
  return out.sort((a, b) => b.amount / FREQUENCIES[b.frequency] - a.amount / FREQUENCIES[a.frequency]);
}

// Paychecks still to come between today and `to`. A payday up to 3 days ago that hasn't arrived
// yet still counts (banks run late); one that already arrived early doesn't count twice.
function upcoming(s, today, to) {
  const after = s.lastDate ? addDays(s.lastDate, 3) : '';
  return payDates(s, addDays(today, -3), to).filter((d) => d > after);
}

// Detected paychecks with your changes applied, plus any you added yourself.
function incomeStreams(db, today) {
  const saved = new Map(db.prepare('SELECT * FROM income_streams').all().map((r) => [r.key, r]));
  const out = [];
  const build = (d, o) => {
    const frequency = (o && o.frequency) || (d && d.frequency) || 'biweekly';
    const custom = !!(o && o.amount != null);
    const estimate = d ? (o && o.estimate && ESTIMATES[o.estimate] ? o.estimate : d.estimate) : null;
    const s = {
      key: d ? d.key : o.key,
      name: (o && o.name) || (d && d.name) || 'Income',
      manual: !!(o && o.manual),
      frequency,
      amount: custom ? o.amount : d ? d.estimates[estimate] : 0,
      // How the amount is worked out: one of ESTIMATES, or 'custom' when you typed it in.
      estimate: custom || !d ? 'custom' : estimate,
      variable: !!(d && d.variable),
      // A range only makes sense when the amount comes from paychecks that vary.
      range: d && d.variable && !custom ? { low: d.low, high: d.high } : null,
      lastDate: d ? d.lastDate : null,
      detected: d && {
        name: d.name, frequency: d.frequency, amount: d.amount, estimate: d.estimate, estimates: d.estimates,
        low: d.low, high: d.high, min: d.min, max: d.max, variable: d.variable, history: d.history,
        averagedOver: d.averagedOver, deposits: d.deposits, lastDate: d.lastDate,
      },
      changed: {
        amount: custom, frequency: !!(o && o.frequency), nextDate: !!(o && o.next_date), name: !!(o && o.name),
        estimate: !!(d && o && o.estimate && o.estimate !== d.estimate),
      },
    };
    if (o && o.next_date) {
      s.anchor = o.next_date;
      s.days = pairDays(domOf(o.next_date));
    } else if (d) {
      s.anchor = d.lastDate;
      s.days = frequency === 'semimonthly' && d.days ? d.days : pairDays(domOf(d.lastDate));
    } else {
      s.anchor = today;
      s.days = pairDays(domOf(today));
    }
    // A paycheck that hasn't shown up for two pay periods is probably over (old job); it's left unticked.
    s.stale = !!(d && diffDays(d.lastDate, today) > FREQUENCIES[d.frequency] * 2 + 7);
    s.enabled = o && o.enabled != null ? !!o.enabled : !s.stale;
    s.nextDate = upcoming(s, today, addDays(today, 400))[0] || null;
    return s;
  };
  for (const d of detectStreams(db, today)) {
    out.push(build(d, saved.get(d.key)));
    saved.delete(d.key);
  }
  for (const o of saved.values()) if (o.manual) out.push(build(null, o));
  return out;
}

// Every visible account, and whether you've ticked it to count in Projections.
function projectionAccounts(db) {
  return db
    .prepare('SELECT id, name, institution, last_four, type, subtype, in_projections FROM accounts WHERE hidden=0 ORDER BY institution, name')
    .all()
    .map((a) => ({ id: a.id, name: a.name, institution: a.institution, last_four: a.last_four, type: a.type, subtype: a.subtype, included: a.in_projections !== 0 }));
}

function cashAccounts(db) {
  return db
    .prepare("SELECT name, institution, last_four, balance_available, balance_ledger FROM accounts WHERE hidden=0 AND in_projections=1 AND type='depository' ORDER BY institution, name")
    .all()
    .map((a) => {
      const raw = a.balance_available ?? a.balance_ledger;
      return { name: a.name, institution: a.institution, last_four: a.last_four, balance: raw == null || raw === '' ? null : Number(raw) };
    });
}

// q: { period: 'month' | 'year', today: 'YYYY-MM-DD' }. summary is index.js's summary().
function project(db, q, summary) {
  const period = q.period === 'year' ? 'year' : 'month';
  const today = DATE_RE.test(q.today || '') && !Number.isNaN(utc(q.today)) ? q.today : iso(Date.now() - new Date().getTimezoneOffset() * 60000);
  const [year, month] = parts(today);
  const monthStart = ymd(year, month, 1);
  const mEnd = monthEnd(today);
  const from = period === 'year' ? ymd(year, 1, 1) : monthStart;
  const to = period === 'year' ? ymd(year, 12, 31) : mEnd;
  const periodMonths = period === 'year' ? 12 : 1;
  const monthsAfter = period === 'year' ? 12 - month : 0; // whole months left after this one
  const weekEnd = addDays(today, (7 - new Date(utc(today)).getUTCDay()) % 7); // weeks run Monday–Sunday

  const skip = new Set([...categories.excluded(db), 'Income']);
  const spentBy = (s) => Object.fromEntries(s.byCategory.filter((c) => !skip.has(c.category)).map((c) => [c.category, c.spent]));
  // Only the accounts ticked under "Accounts counted" (projection: true).
  const soFar = summary(db, { from, to: today, projection: true });
  const thisMonth = period === 'month' ? soFar : summary(db, { from: monthStart, to: today, projection: true });

  // "Usual" monthly spending: the last 3 complete months (only months fully covered by your history).
  const first = db.prepare('SELECT MIN(t.date) AS d FROM transactions t JOIN accounts a ON a.id=t.account_id WHERE a.hidden=0 AND a.in_projections=1').get().d;
  const firstFull = first ? (first.endsWith('-01') ? first.slice(0, 8) + '01' : addMonths(first, 1)) : monthStart;
  const histFrom = [addMonths(monthStart, -3), firstFull].sort().pop();
  const histMonths = Math.max(0, Math.round(diffDays(histFrom, monthStart) / 30.44));
  let usual = {};
  const history = { months: histMonths, from: histMonths ? histFrom : null, to: histMonths ? addDays(monthStart, -1) : null };
  if (histMonths) {
    const h = spentBy(summary(db, { from: histFrom, to: addDays(monthStart, -1), projection: true }));
    usual = Object.fromEntries(Object.entries(h).map(([c, v]) => [c, v / histMonths]));
  } else {
    // No full month yet: assume this month continues at the pace so far.
    const scale = lastDay(year, month) / Number(today.slice(8));
    usual = Object.fromEntries(Object.entries(spentBy(thisMonth)).map(([c, v]) => [c, v * scale]));
  }

  const budgets = Object.fromEntries(db.prepare('SELECT * FROM budgets').all().map((b) => [b.category, b.monthly_limit]));
  const spent = spentBy(soFar);
  const spentMonth = spentBy(thisMonth);
  const names = [...new Set([...Object.keys(spent), ...Object.keys(spentMonth), ...Object.keys(usual), ...Object.keys(budgets)])]
    .filter((c) => !skip.has(c));
  const daysLeftMonth = diffDays(today, mEnd) + 1; // including today
  const weekDaysThisMonth = diffDays(today, weekEnd <= mEnd ? weekEnd : mEnd) + 1;
  const weekDaysNextMonth = weekEnd > mEnd ? diffDays(mEnd, weekEnd) : 0;
  const nextMonthDays = (() => { const n = addMonths(monthStart, 1); const [y, m] = parts(n); return lastDay(y, m); })();

  const byCategory = names.map((category) => {
    const s = spent[category] || 0;
    const sm = spentMonth[category] || 0;
    const typical = Math.max(0, usual[category] || 0);
    const budgetMonthly = budgets[category] ?? null;
    const plan = budgetMonthly ?? typical; // what you expect to spend in a month
    const leftThisMonth = Math.max(0, plan - sm);
    const remaining = leftThisMonth + plan * monthsAfter;
    const remainingWeek = leftThisMonth * (weekDaysThisMonth / daysLeftMonth) + plan * (weekDaysNextMonth / nextMonthDays);
    const budget = budgetMonthly != null ? budgetMonthly * periodMonths : null;
    // Where you'd land spending your usual amount (shown for reference; no longer used to flag the budget).
    const atUsual = s + Math.max(0, typical - sm) + typical * monthsAfter;
    let status = 'none';
    if (budget != null) status = s > budget + 0.005 ? 'over' : s >= budget * 0.85 ? 'near' : 'ok';
    return {
      category, spent: round2(s), spentMonth: round2(sm), typical: round2(typical), budgetMonthly, budget: budget == null ? null : round2(budget),
      remaining: round2(remaining), remainingWeek: round2(remainingWeek), projected: round2(s + remaining), atUsual: round2(atUsual), status,
    };
  });
  byCategory.sort((a, b) => b.projected - a.projected || a.category.localeCompare(b.category));

  const streams = incomeStreams(db, today).map((s) => {
    const dates = upcoming(s, today, to);
    const weekDates = upcoming(s, today, weekEnd);
    const lo = s.range ? s.range.low : s.amount;
    const hi = s.range ? s.range.high : s.amount;
    return {
      ...s, expectedDates: dates, expectedTotal: round2(dates.length * s.amount), expectedWeek: round2(weekDates.length * s.amount),
      expectedLow: round2(dates.length * lo), expectedHigh: round2(dates.length * hi),
    };
  });
  const on = streams.filter((s) => s.enabled);
  const sum = (f) => round2(on.reduce((a, s) => a + s[f], 0));
  const expected = sum('expectedTotal');
  const expectedWeek = sum('expectedWeek');
  // Low/high: every paycheck that varies comes in at the low (or high) end of where they usually land.
  const expectedRange = on.some((s) => s.range && s.expectedDates.length) ? { low: sum('expectedLow'), high: sum('expectedHigh') } : null;
  const remaining = round2(byCategory.reduce((a, c) => a + c.remaining, 0));
  const remainingWeek = round2(byCategory.reduce((a, c) => a + c.remainingWeek, 0));
  const projectedIncome = round2(soFar.income + expected);
  const leftToSpend = round2(projectedIncome - soFar.spending);
  const daysLeft = diffDays(today, to) + 1;
  const accounts = cashAccounts(db);
  const known = accounts.filter((a) => a.balance != null);
  const cash = known.length ? round2(known.reduce((a, x) => a + x.balance, 0)) : null;

  return {
    period, today, from, to, weekEnd, daysLeft, history, excludedCategories: [...skip].filter((c) => c !== 'Income').sort(),
    income: {
      soFar: round2(soFar.income), expected, expectedWeek, projected: projectedIncome, streams,
      range: expectedRange && { ...expectedRange, projectedLow: round2(soFar.income + expectedRange.low), projectedHigh: round2(soFar.income + expectedRange.high) },
    },
    spending: { soFar: round2(soFar.spending), remaining, remainingWeek, projected: round2(soFar.spending + remaining) },
    leftToSpend,
    leftRange: expectedRange && { low: round2(leftToSpend - expected + expectedRange.low), high: round2(leftToSpend - expected + expectedRange.high) },
    perDay: round2(leftToSpend / daysLeft),
    afterPlanned: round2(leftToSpend - remaining),
    cash: { total: cash, accounts },
    accounts: projectionAccounts(db),
    balance: cash == null ? null : {
      end: round2(cash + expected - remaining), week: round2(cash + expectedWeek - remainingWeek),
      endRange: expectedRange && { low: round2(cash + expectedRange.low - remaining), high: round2(cash + expectedRange.high - remaining) },
    },
    byCategory,
  };
}

// Save your change to a paycheck. Fields set to null go back to what was detected.
function saveStream(db, b) {
  const key = String(b.key || '');
  if (!key) throw Object.assign(new Error('key required'), { status: 400 });
  const cur = db.prepare('SELECT * FROM income_streams WHERE key=?').get(key) || { key, manual: 0 };
  const next = { ...cur };
  if (b.name !== undefined) next.name = b.name == null ? null : categories.cleanName(b.name) || null;
  if (b.amount !== undefined) {
    if (b.amount == null || b.amount === '') next.amount = null;
    else {
      const n = Number(b.amount);
      if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error('Amount must be a positive number'), { status: 400 });
      next.amount = round2(n);
    }
  }
  if (b.frequency !== undefined) {
    if (b.frequency != null && !FREQUENCIES[b.frequency]) throw Object.assign(new Error('Unknown frequency'), { status: 400 });
    next.frequency = b.frequency || null;
  }
  if (b.next_date !== undefined) {
    if (b.next_date && !DATE_RE.test(b.next_date)) throw Object.assign(new Error('Date must be YYYY-MM-DD'), { status: 400 });
    next.next_date = b.next_date || null;
  }
  if (b.estimate !== undefined) {
    if (b.estimate != null && !ESTIMATES[b.estimate]) throw Object.assign(new Error('Unknown estimate'), { status: 400 });
    next.estimate = b.estimate || null;
  }
  if (b.enabled !== undefined) next.enabled = b.enabled == null ? null : b.enabled ? 1 : 0;
  db.prepare(
    `INSERT INTO income_streams (key, name, amount, frequency, next_date, enabled, manual, estimate, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET name=excluded.name, amount=excluded.amount, frequency=excluded.frequency,
       next_date=excluded.next_date, enabled=excluded.enabled, estimate=excluded.estimate, updated_at=excluded.updated_at`
  ).run(key, next.name ?? null, next.amount ?? null, next.frequency ?? null, next.next_date ?? null, next.enabled ?? null, next.manual ? 1 : 0,
    next.estimate ?? null);
  return { key };
}

function addStream(db, b) {
  const key = `manual:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  db.prepare("INSERT INTO income_streams (key, manual, enabled, updated_at) VALUES (?, 1, 1, datetime('now'))").run(key);
  saveStream(db, { key, name: b.name || 'Other income', amount: b.amount ?? 0, frequency: b.frequency || 'biweekly', next_date: b.next_date || null });
  return { key };
}

module.exports = { project, saveStream, addStream, detectStreams, payDates, payStats, FREQUENCIES, ESTIMATES };
