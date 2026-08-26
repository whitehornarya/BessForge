const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bessforgeTokenSetup', Object.freeze({
  save: token => ipcRenderer.invoke('bessforge:save-cesium-token', token),
  skip: () => ipcRenderer.send('bessforge:skip-cesium-token'),
}));