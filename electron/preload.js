const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getBoot: () => ipcRenderer.invoke('get-boot'),
  getStats: () => ipcRenderer.invoke('get-stats'),
  getCustomers: () => ipcRenderer.invoke('get-customers'),
  savePhone: (phone) => ipcRenderer.invoke('save-phone', phone),
  saveSheet: (url) => ipcRenderer.invoke('save-sheet', url),
  finishSetup: () => ipcRenderer.invoke('finish-setup'),
  openCustomersFolder: () => ipcRenderer.invoke('open-customers-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  onWorker: (cb) => ipcRenderer.on('worker', (e, ev) => cb(ev)),
  onStatus: (cb) => ipcRenderer.on('status', (e, ev) => cb(ev)),
  onQr: (cb) => ipcRenderer.on('qr', (e, ev) => cb(ev)),
  onCrm: (cb) => ipcRenderer.on('crm', (e, ev) => cb(ev)),
});
