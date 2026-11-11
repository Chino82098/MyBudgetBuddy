# Budget Buddy

A personal budgeting desktop app that pulls your bank data from the [Teller API](https://teller.io/docs/api).

- **Sync** accounts, balances and transactions from any bank Teller supports
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

**Windows: one-click launch.** After `npm install`, double-click **`Create Shortcut.bat`** once. It adds a **Budget Buddy** shortcut (with icon) to your Desktop and Start Menu that opens the app window directly, no terminal. Right-click it → *Pin to taskbar* if you like. Opening it again while it's running just brings the window forward. Re-run the .bat if you move the folder.

To try it without a bank, open **Accounts → Load demo data**. Remove "Demo Bank" when you're done.

## 2. Connect Teller

1. Create an account at [teller.io](https://teller.io) and open the dashboard.
2. Copy your **Application ID** (`app_…`).
3. Download your **certificate**. The zip contains `certificate.pem` and `private_key.pem`. Keep them somewhere private, outside this repo.
4. In Budget Buddy, open **Settings** and fill in:
   - Application ID
   - Environment: `sandbox` to test with fake banks (username `username`, password `password`); `development` or `production` for your real accounts
   - Full paths to `certificate.pem` and `private_key.pem` (required for development and production)
5. Go to **Accounts → Connect a bank** and finish the Teller Connect flow. The app saves the access token and runs a first sync.

Click **↻ Sync** any time to pull new transactions. The first sync gets full history. Later syncs only re-fetch from about 2 weeks before your newest transaction, which catches pending → posted changes.

If a bank shows **disconnected** (e.g. you changed your password), click **Reconnect**.

## 3. Set up Google Sheets export (one time, ~2 min)

1. Create a new Google Sheet → **Extensions → Apps Script**.
2. Paste in the contents of [`google-sheets/Code.gs`](google-sheets/Code.gs). Change `SECRET` to a random string.
3. **Deploy → New deployment → Web app**. Set *Execute as*: **Me** and *Who has access*: **Anyone**. Authorize it.
4. Copy the web app URL (ends in `/exec`). In Budget Buddy **Settings**, paste the URL and the same secret.
5. Click **Export to Google Sheets**. Each export writes a tab for the month (e.g. `2026-11`) and a `2026-11 summary` tab, replacing older exports of that month.

## How the numbers work

- Negative amounts are money out, positive amounts are money in. If a credit card shows purchases as positive, tick **Flip signs** for that account under Accounts.
- **Spending/Income** leave out anything categorized `Transfer`, so card payments and moves between your own accounts aren't double counted. They also leave out any row with **Skip** ticked. Teller `transfer` transactions default to `Transfer`; recategorize any that are real spending (e.g. Zelle rent).
- Hidden accounts are left out everywhere.
- Shortcuts: `←`/`→` change month, `/` jumps to search.

## Where your data lives

Everything is in `~/.budgetbuddy/` (override with `BUDGETBUDDY_DATA=/some/dir`):

| File | Contents |
| --- | --- |
| `budgetbuddy.db` | accounts, transactions, your tags/notes/budgets, Teller access tokens |
| `config.json` | settings (cert *paths*, not the certs themselves) |

Both are created owner-only (`0600`/`0700`). The access tokens are stored unencrypted on disk, so treat this folder like a password file and keep your disk encrypted. The server only listens on `127.0.0.1`. It rejects requests sent under other hostnames and requires an app header on every write, so websites you visit can't reach it.

## Project layout

```
server/      Node stdlib HTTP server, Teller mTLS client, SQLite (node:sqlite), sync, Sheets export
public/      UI (plain HTML/CSS/JS, no build step)
electron/    desktop window wrapper
google-sheets/Code.gs   Apps Script receiver for exports
test/        node:test suite (fake Teller client + API tests)
```

```bash
npm test
```
