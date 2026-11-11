'use strict';
// Pushes transactions + a monthly summary to a Google Sheet through a small Apps Script
// web app the user deploys from google-sheets/Code.gs (no Google OAuth needed in this app).

async function postToSheet(url, payload) {
  if (!/^https:\/\/script\.google(usercontent)?\.com\//.test(url)) {
    throw new Error('The Sheets web app URL should start with https://script.google.com/');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // Apps Script reads e.postData.contents
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Unexpected response from Apps Script (HTTP ${res.status}). Check the deployment is "Anyone" access.`);
  }
  if (!data.ok) throw new Error(data.error || 'Apps Script reported an error');
  return data;
}

module.exports = { postToSheet };
