const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('dt', {
  preview: () => ipcRenderer.invoke('dt:preview'),
  openPage: () => ipcRenderer.invoke('dt:open-page'),
  pointerInside: () => ipcRenderer.invoke('dt:pointer-inside'),
  drag: (type, screenX, screenY) => ipcRenderer.send('dt:drag', { type, screenX, screenY }),
  onPointerInside: (callback) => {
    const listener = (_event, inside) => callback(inside);
    ipcRenderer.on('dt:pointer-inside', listener);
    return () => ipcRenderer.removeListener('dt:pointer-inside', listener);
  },
  subscribe: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('dt:preview', listener);
    return () => ipcRenderer.removeListener('dt:preview', listener);
  },
});
