const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('blackfoxApi', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  getDiagnostics: () => ipcRenderer.invoke('get-diagnostics'),
  setSafeGraphics: (enabled) => ipcRenderer.invoke('set-safe-graphics', Boolean(enabled)),
  clearGameCache: () => ipcRenderer.invoke('clear-game-cache'),
  checkLauncherUpdate: () => ipcRenderer.invoke('check-launcher-update'),
  applyLauncherUpdate: () => ipcRenderer.invoke('apply-launcher-update'),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  syncModpack: () => ipcRenderer.invoke('sync-modpack'),
  launchGame: () => ipcRenderer.invoke('launch-game'),
  openGameFolder: () => ipcRenderer.invoke('open-game-folder'),
  windowControl: (action) => ipcRenderer.send('window-control', action),
  onProgress: (cb) => {
    const listener = (_, data) => cb(data);
    ipcRenderer.on('sync-progress', listener);
    return () => ipcRenderer.removeListener('sync-progress', listener);
  },
  onLog: (cb) => {
    const listener = (_, line) => cb(line);
    ipcRenderer.on('launcher-log', listener);
    return () => ipcRenderer.removeListener('launcher-log', listener);
  },
  onGameExit: (cb) => {
    const listener = (_, code) => cb(code);
    ipcRenderer.on('game-exit', listener);
    return () => ipcRenderer.removeListener('game-exit', listener);
  },
});
