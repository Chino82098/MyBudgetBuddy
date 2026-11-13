/**
 * Budget Buddy → Google Sheets receiver.
 *
 * Setup (one time, ~2 minutes):
 *  1. Create a Google Sheet. Extensions → Apps Script. Replace the code with this file.
 *  2. Change SECRET below to any random string, and paste the same value into
 *     Budget Buddy → Settings → Shared secret.
 *  3. Deploy → New deployment → type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Authorize, then copy the Web app URL (ends in /exec) into Budget Buddy → Settings.
 *
 * Each export rewrites a tab named after the month (e.g. "2026-11") plus a "<month> summary" tab.
 */
const SECRET = 'change-me';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (SECRET && data.secret !== SECRET) return json({ ok: false, error: 'Wrong shared secret' });

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const name = data.month || 'all';

    // Transactions tab
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    sheet.clear();
    const header = ['Date', 'Description', 'Counterparty', 'Amount', 'Category', 'Tags', 'Note', 'Account', 'Status', 'Excluded', 'Spread (months)', 'ID'];
    const rows = (data.transactions || []).map(function (t) {
      return [t.date, t.description, t.counterparty || '', Number(t.amount), t.category || '',
        (t.tags || '').split(',').filter(String).join(', '), t.note || '', t.account || '',
        t.status || '', t.excluded ? 'yes' : '', t.spread_months > 1 ? t.spread_months : '', t.id];
    });
    sheet.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
    if (rows.length) {
      sheet.getRange(2, 1, rows.length, header.length).setValues(rows);
      sheet.getRange(2, 4, rows.length, 1).setNumberFormat('$#,##0.00;[Red]-$#,##0.00');
    }
    sheet.setFrozenRows(1);
    sheet.autoResizeColumns(1, header.length);

    // Summary tab
    if (data.summary) {
      const sname = name + ' summary';
      const s = ss.getSheetByName(sname) || ss.insertSheet(sname);
      s.clear();
      const out = [
        ['Income', data.summary.income, ''],
        ['Spending', data.summary.spending, ''],
        ['Net', data.summary.net, ''],
        ['', '', ''],
        ['Category', 'Spent', 'Budget'],
      ];
      (data.summary.byCategory || []).forEach(function (c) { out.push([c.category, c.spent, c.budget || '']); });
      out.push(['', '', ''], ['Tag', 'Spent', 'Count']);
      (data.summary.byTag || []).forEach(function (t) { out.push([t.tag, t.spent, t.count]); });
      s.getRange(1, 1, out.length, 3).setValues(out);
      s.getRange('A5:C5').setFontWeight('bold');
      s.getRange(1, 2, out.length, 1).setNumberFormat('$#,##0.00');
      s.autoResizeColumns(1, 3);
    }

    return json({ ok: true, rows: rows.length, url: ss.getUrl() + '#gid=' + sheet.getSheetId() });
  } catch (err) {
    return json({ ok: false, error: String(err) });
  }
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
