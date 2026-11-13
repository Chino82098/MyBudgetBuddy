# Budget Buddy

A personal budgeting desktop app that pulls your bank data from the [Plaid API](https://plaid.com/docs/api/).

> **Moving from Teller?** Teller shut down its API. Your old data stays put: connect each bank again through Plaid and Budget Buddy copies your categories, tags and notes onto the matching Plaid transactions, then removes the Teller duplicates. Older history Plaid doesn't have is kept. See [Switching from Teller](#switching-from-teller).

- **Sync** accounts, balances and transactions from any bank Plaid supports
- **Quick updates:** edit category, tags and notes inline. Press Enter to save and jump to the next row, or bulk-tag selected rows.
- **Your own categories:** pick from the Category list on any row or choose **＋ New category…** to make one. Rename, merge or delete them under **Settings → Categories**.
- **Remembers your choices:** a category you set is never changed by a sync, even when a pending charge posts under a new ID. New transactions from that merchant get the same category automatically. Change older ones in one click, or forget a merchant under **Settings → Remembered merchants**.
- **Projections:** how much you have left to spend this month (or year), and your projected bank balance at the end of the week and month/year. Paychecks are detected from your Income transactions and can be adjusted.
- **Budgets** per category with progress bars (set them on the Dashboard or in Projections), plus spending by tag (e.g. `work-trip`, `gift`)
- **View** a month, a full year, year-to-date, or any custom date range (budgets scale to the length of the range)
- **Export** the period you're viewing to Google Sheets in one click, or download a CSV
- Everything is stored **locally** in SQLite. Your edits are never overwritten by a re-sync.

![stack](https://img.shields.io/badge/node-%E2%89%A522.13-green) No runtime dependencies. Electron is only needed for the desktop window.

---

## 1. Run it

Requires **Node.js 22.13 or newer** (`node -v`).

```bash
git clone https://github.com/Chino82098/MyBudgetBuddy.git
cd MyBudgetBuddy

# Option A: in your browser (no install step)
npm start                 # → http://localhost:4757

# Option B: as a desktop window
npm install
npm run desktop
```

To try it without a bank, open **Accounts → Load demo data**. Remove "Demo Bank" when you're done.

## 2. Connect Plaid

1. Sign up at [dashboard.plaid.com/signup](https://dashboard.plaid.com/signup). For a personal app, choose **Personal use**. New US/Canada teams get a free **Trial** plan with real bank data (limited to a handful of banks/Items); older accounts may have *Limited Production* instead.
2. Open **Developers → Keys** and copy your **client_id** and the **secret** for the environment you want. Sandbox and Production have different secrets.
3. In Budget Buddy, open **File → Settings** (Ctrl+,) and fill in:
   - Client ID and Secret
   - Environment: `sandbox` to test with fake banks (username `user_good`, password `pass_good`), or `production` for your real accounts
4. Go to **Accounts → Connect a bank** and finish the Plaid Link flow. The app swaps the one-time token for an access token, saves it and runs a first sync.

Click **↻ Sync** any time to pull new transactions. Budget Buddy asks Plaid for up to 2 years of history and uses Plaid's `/transactions/sync` cursor, so later syncs only download what changed. Right after you connect a bank, Plaid may still be fetching older history; if the sync says so, sync again in a few minutes. When a pending transaction posts, its tags and notes move to the posted version.

If a bank shows **disconnected** (e.g. you changed your password), click **Reconnect** to log in again through Plaid Link. Your history is kept.

Removing a bank under Accounts also tells Plaid to stop syncing it, so it no longer counts toward your plan.

> Some big banks (Chase, Capital One, …) log in through their own site in a popup. Allow popups if your browser asks. In the desktop window this works automatically.

### Switching from Teller

Teller connections now show as **retired**. They no longer sync, but their transactions stay in place. Connect the same bank through Plaid. On every sync, Budget Buddy matches each Plaid account to the old Teller account with the same bank name and last 4 digits, then pairs up transactions with the same amount within 3 days of each other. For each pair it copies your category, tags, notes and Skip flag onto the Plaid transaction and deletes the Teller copy. Teller transactions older than Plaid's history are left alone. Once a Teller connection has nothing left, it's removed automatically. You can also remove it yourself under Accounts, but that deletes any history only Teller had.

## 3. Set up Google Sheets export (one time, ~2 min)

1. Create a new Google Sheet → **Extensions → Apps Script**.
2. Paste in the contents of [`google-sheets/Code.gs`](google-sheets/Code.gs). Change `SECRET` to a random string.
3. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Authorize it.
4. Copy the web app URL (ends in `/exec`). In Budget Buddy **File → Settings**, paste the URL and the same secret.
5. Click **Export to Google Sheets**. Each export writes a tab for the period you're viewing (e.g. `2026-11`, `2026`, `2026 YTD` or `2026-03-01 to 2026-05-15`) and a matching `… summary` tab, replacing older exports of that period.

## How the numbers work

- Negative amounts are money out, positive amounts are money in. If a credit card shows purchases as positive, tick **Flip signs** for that account under Accounts.
- **Income** is only transactions categorized `Income`. **Spending** is everything else, net of money back: a refund or return in Groceries lowers Groceries spending instead of counting as income. If money in (e.g. a friend paying you back) should be income, categorize it `Income`.
- **Spending/Income** leave out anything categorized `Transfer`, so card payments and moves between your own accounts aren't double counted. They also leave out any row with **Skip** ticked. To leave out a whole category (say Rent, or Reimbursable), tick **Excluded** next to it in **Categories**; its transactions still show up in the list and exports, dimmed, but don't count toward income, spending, charts or budgets. Plaid's transfer and credit-card-payment categories default to `Transfer`; recategorize any that are real spending (e.g. Zelle rent). Plaid reports money out as positive; Budget Buddy flips it so spending is negative everywhere, so **Flip signs** is rarely needed now.
- Hidden accounts are left out everywhere.
- Shortcuts: `←`/`→` step back/forward a month (or a year in 1 Year and YTD views), `/` jumps to search.

## How Projections work

**Projections** always shows the current month; switch to **Year** for the whole calendar year.

- **Paychecks** are found from transactions categorized `Income` over the last 6 months, grouped by who paid them. Two or more deposits on a regular schedule (weekly, every 2 weeks, twice a month or monthly) count as a paycheck; the amount is the average of the last 4. One-off income (a friend paying you back) is counted in income so far but not projected. Change a paycheck's amount, schedule or next payday in the table, untick **Use** to leave it out, or **+ Add income** for one that wasn't found. **Reset** goes back to what was detected. A paycheck that stops arriving for two pay periods is left unticked.
- **Paychecks that change size** (hourly pay, overtime, holiday pay) are spotted automatically when they swing by more than 10%. They're estimated with the **6-month average** by default, and a picker under the amount lets you switch to **Average of last 4** (follows a recent raise or change in hours), **Typical** (the middle paycheck, so one huge holiday check doesn't skew it), **Conservative** (a slower week: 3 in 4 paychecks were at least this much) or **Last paycheck**. Each option shows its dollar amount. The projection also shows a **likely range** for income, left to spend and the end-of-period balance, based on where the middle half of your paychecks landed. Hover a paycheck's description to see the paychecks it's based on. Typing your own amount overrides the estimate.
- **Left to spend** = income so far + paychecks still to come − spent so far.
- **Accounts counted**: tick which bank accounts the projections use. An unticked account's balance, paychecks and spending are left out of Projections only; the Dashboard and Transactions still show everything.
- **Planned spending still to come** uses each category's budget, or, where there's no budget, what you usually spend there in a month (average of your last 3 full months). Spending already done this month counts against it, so rent paid on the 1st isn't projected again.
- **Bank balance** = today's checking & savings balances + paychecks still to come − planned spending still to come. Card purchases are treated as if paid from checking; card payments are Transfers so nothing counts twice. Weeks end on Sunday.

## Where your data lives

Everything is in `~/.budgetbuddy/` (override with `BUDGETBUDDY_DATA=/some/dir`):

| File | Contents |
| --- | --- |
| `budgetbuddy.db` | accounts, transactions, your tags/notes/budgets, Plaid access tokens |
| `config.json` | settings, including your Plaid client ID and secret |

Both are created owner-only (`0600`/`0700`). The access tokens and Plaid secret are stored unencrypted on disk, so treat this folder like a password file and keep your disk encrypted. The server only listens on `127.0.0.1`. It rejects requests sent under other hostnames and requires an app header on every write, so websites you visit can't reach it.

## Project layout

```
server/      Node stdlib HTTP server, Plaid client, SQLite (node:sqlite), sync, Sheets export
public/      UI (plain HTML/CSS/JS, no build step)
electron/    desktop window wrapper
google-sheets/Code.gs   Apps Script receiver for exports
test/        node:test suite (fake Plaid client, Teller migration + API tests)
```

```bash
npm test
```
