const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getSources: () => ipcRenderer.invoke('get-sources'),
    sendInputEvent: (type, data) => ipcRenderer.send('input-event', type, data),
    windowControl: (action) => ipcRenderer.send('window-control', action),
    onShortcut: (callback) => ipcRenderer.on('global-shortcut', (_event, value) => callback(value))
});
