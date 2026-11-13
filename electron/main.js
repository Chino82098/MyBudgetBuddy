'use strict';
// Desktop wrapper: starts the local Budget Buddy server and shows it in a native window.
const { app, BrowserWindow, Menu, shell } = require('electron');
const path = require('node:path');

async function startServer() {
  const { start } = require(path.join(__dirname, '..', 'server'));
  try {
    return await start(Number(process.env.PORT) || 4757);
  } catch (e) {
    if (e.code === 'EADDRINUSE') return start(0); // another copy running — pick any free port
    throw e;
  }
}

async function createWindow() {
  const { port } = await startServer();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    title: 'Budget Buddy',
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Plaid Link opens bank OAuth logins in a popup that starts on plaid.com; keep those in-app, send everything else to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const host = new URL(url).hostname;
    if (host.endsWith('.plaid.com') && host !== 'dashboard.plaid.com') return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://localhost:${port}/`);
  buildMenu(win);
}

// App menu: Settings lives under File instead of the sidebar.
function buildMenu(win) {
  const openSettings = () => win.webContents.executeJavaScript("location.hash = 'settings'");
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'File', submenu: [
      { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
