const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  verifyKey: (secretKey) => ipcRenderer.invoke('api:verifyKey', { secretKey }),
  parseUrl: (url) => ipcRenderer.invoke('parseUrl', url),
  previewFetch: (urls) => ipcRenderer.invoke('preview:fetch', { urls }),
  startDownload: (tasks) => ipcRenderer.invoke('download:start', { tasks }),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  onLog: (cb) => ipcRenderer.on('log', (_e, p) => cb(p)),
  onItemProgress: (cb) => ipcRenderer.on('progress:item', (_e, p) => cb(p)),
  onBytesProgress: (cb) => ipcRenderer.on('progress:bytes', (_e, p) => cb(p)),
  onBatchBegin: (cb) => ipcRenderer.on('batch:begin', (_e, p) => cb(p)),
  onBatchItemStart: (cb) => ipcRenderer.on('batch:itemStart', (_e, p) => cb(p)),
  onBatchItemEnd: (cb) => ipcRenderer.on('batch:itemEnd', (_e, p) => cb(p)),
  onBatchDone: (cb) => ipcRenderer.on('batch:done', (_e, p) => cb(p))
});
