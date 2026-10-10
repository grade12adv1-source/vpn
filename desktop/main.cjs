const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { ProfileStore } = require('./store.cjs');
const { NativeWireGuard } = require('./native.cjs');
const { VpnController } = require('./controller.cjs');

let window;
let controller;
const pageURL = pathToFileURL(path.join(__dirname, '../ui/index.html')).href;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(async () => {
    controller = new VpnController(new ProfileStore(app.getPath('userData')), new NativeWireGuard());
    await controller.store.init();
    const handle = (channel, fn) => ipcMain.handle(channel, async (event, ...args) => {
      if (event.sender !== window?.webContents || event.senderFrame?.url !== pageURL) return { ok: false, error: 'Untrusted request.' };
      try { return { ok: true, data: await fn(...args) }; }
      catch (error) { return { ok: false, error: error.message || 'Operation failed.' }; }
    });
    handle('vpn:state', () => controller.state());
    handle('vpn:connect', id => controller.connect(id));
    handle('vpn:disconnect', () => controller.disconnect());
    handle('vpn:measure', () => controller.measure());
    handle('vpn:remove', id => controller.remove(id));
    handle('vpn:import', async () => {
      const result = await dialog.showOpenDialog(window, { title: 'Import a WireGuard profile', properties: ['openFile'], filters: [{ name: 'WireGuard configuration', extensions: ['conf'] }] });
      if (result.canceled) return controller.state();
      const selected = result.filePaths[0];
      const stat = await fs.stat(selected);
      if (stat.size > 64 * 1024) throw new Error('Profile must be smaller than 64 KB.');
      return controller.import(await fs.readFile(selected, 'utf8'), path.basename(selected, '.conf'));
    });
    handle('vpn:open-docs', () => shell.openExternal('https://www.wireguard.com/install/'));
    createWindow();
    app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
}

function createWindow() {
  window = new BrowserWindow({
    width: 1240, height: 850, minWidth: 960, minHeight: 720,
    backgroundColor: '#090f18', title: 'Aero VPN', icon: path.join(__dirname, '../ui/icon.png'), autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageURL) event.preventDefault(); });
  window.loadFile(path.join(__dirname, '../ui/index.html'));
  window.on('close', async event => {
    if (!controller?.activeId && !controller?.busy) return;
    event.preventDefault();
    if (controller.busy) {
      await dialog.showMessageBox(window, { type: 'info', message: 'Wait for the tunnel operation to finish before closing Aero VPN.' });
      return;
    }
    const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Keep app open', 'Close and keep tunnel running'], defaultId: 0, cancelId: 0, message: 'Your VPN tunnel is running.', detail: 'Closing Aero VPN does not disconnect WireGuard. Reopen the app to manage the tunnel.' });
    if (response === 1) window.destroy();
  });
}
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
