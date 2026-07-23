const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getBoot: () => ipcRenderer.invoke('get-boot'),
  getConn: () => ipcRenderer.invoke('get-conn'),
  getCustomers: (date) => ipcRenderer.invoke('get-customers', date),
  savePhone: (phone) => ipcRenderer.invoke('save-phone', phone),
  saveSheet: (url) => ipcRenderer.invoke('save-sheet', url),
  savePortal: (url) => ipcRenderer.invoke('save-portal', url),
  saveWorkers: (workers) => ipcRenderer.invoke('save-workers', workers),
  finishSetup: () => ipcRenderer.invoke('finish-setup'),
  reconnectWhatsapp: () => ipcRenderer.invoke('reconnect-whatsapp'),
  retryCrm: () => ipcRenderer.invoke('retry-crm'),
  retryPortal: () => ipcRenderer.invoke('retry-portal'),
  openPortal: () => ipcRenderer.invoke('open-portal'),
  openCustomersFolder: () => ipcRenderer.invoke('open-customers-folder'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  onWorker: (cb) => ipcRenderer.on('worker', (e, ev) => cb(ev)),
  onConn: (cb) => ipcRenderer.on('conn', (e, ev) => cb(ev)),
  onQr: (cb) => ipcRenderer.on('qr', (e, ev) => cb(ev)),
  onCrm: (cb) => ipcRenderer.on('crm', (e, ev) => cb(ev)),
});
