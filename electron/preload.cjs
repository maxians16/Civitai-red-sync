const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  openPath: (p) => ipcRenderer.invoke('openPath', p),
  verifyKey: (secretKey) => ipcRenderer.invoke('api:verifyKey', { secretKey }),
  parseUrl: (url) => ipcRenderer.invoke('parseUrl', url),
  previewFetch: (url) => ipcRenderer.invoke('preview:fetch', { url }),
  startDownload: (opts) => ipcRenderer.invoke('download:start', opts),
  cancelDownload: () => ipcRenderer.invoke('download:cancel'),
  onLog: (cb) => ipcRenderer.on('log', (_e, p) => cb(p)),
  onProgress: (cb) => ipcRenderer.on('progress', (_e, p) => cb(p)),
  onBegin: (cb) => ipcRenderer.on('download:begin', (_e, p) => cb(p)),
  onEnd: (cb) => ipcRenderer.on('download:end', (_e, p) => cb(p))
});
