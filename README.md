# Budget Buddy

A personal budgeting desktop app that pulls your bank data from the [Plaid API](https://plaid.com/docs/api/).

> **Moving from Teller?** Teller shut down its API. Your old data stays put: connect each bank again through Plaid and Budget Buddy copies your categories, tags and notes onto the matching Plaid transactions, then removes the Teller duplicates. Older history Plaid doesn't have is kept. See [Switching from Teller](#switching-from-teller).

- **Sync** accounts, balances and transactions from any bank Plaid supports
- **Quick updates:** edit category, tags and notes inline. Press Enter to save and jump to the next row, or bulk-tag selected rows.
- **Budgets** per category with progress bars, plus spending by tag (e.g. `work-trip`, `gift`)
- **Export** a month to Google Sheets in one click, or download a CSV
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
3. In Budget Buddy, open **Settings** and fill in:
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
4. Copy the web app URL (ends in `/exec`). In Budget Buddy **Settings**, paste the URL and the same secret.
5. Click **Export to Google Sheets**. Each export writes a tab for the month (e.g. `2026-11`) and a `2026-11 summary` tab, replacing older exports of that month.

## How the numbers work

- Negative amounts are money out, positive amounts are money in. If a credit card shows purchases as positive, tick **Flip signs** for that account under Accounts.
- **Spending/Income** leave out anything categorized `Transfer`, so card payments and moves between your own accounts aren't double counted. They also leave out any row with **Skip** ticked. Plaid's transfer and credit-card-payment categories default to `Transfer`; recategorize any that are real spending (e.g. Zelle rent). Plaid reports money out as positive; Budget Buddy flips it so spending is negative everywhere, so **Flip signs** is rarely needed now.
- Hidden accounts are left out everywhere.
- Shortcuts: `←`/`→` change month, `/` jumps to search.

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
