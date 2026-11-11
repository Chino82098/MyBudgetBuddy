'use strict';
// Desktop wrapper: starts the local Budget Buddy server and shows it in a native window.
const { app, BrowserWindow, shell } = require('electron');
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

// Lets Windows group the window with the Budget Buddy shortcut on the taskbar.
if (process.platform === 'win32') app.setAppUserModelId('com.budgetbuddy.app');

// Only one copy of the app: launching it again just brings the open window forward.
const isFirstCopy = app.requestSingleInstanceLock();
if (!isFirstCopy) app.quit();
app.on('second-instance', () => {
  const [win] = BrowserWindow.getAllWindows();
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

async function createWindow() {
  const { port } = await startServer();
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    title: 'Budget Buddy',
    icon: path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  // Teller Connect (and bank OAuth pages) may open popups; keep those in-app, send everything else to the browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    const host = new URL(url).hostname;
    if (host.endsWith('teller.io')) return { action: 'allow' };
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://localhost:${port}/`);
}

if (isFirstCopy) app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
