const { contextBridge, ipcRenderer } = require('electron');
const { id } = require('./manifest.json');

const channel = name => `${id}:${name}`;

contextBridge.exposeInMainWorld('psOrb', {
  bootstrap: () => ipcRenderer.invoke(channel('bootstrap')),
  games: () => ipcRenderer.invoke(channel('games')),
  dragStart: () => ipcRenderer.send(channel('drag-start')),
  dragMove: () => ipcRenderer.send(channel('drag-move')),
  dragEnd: () => ipcRenderer.send(channel('drag-end')),
  expand: () => ipcRenderer.invoke(channel('expand')),
  collapse: () => ipcRenderer.invoke(channel('collapse')),
  launch: id => ipcRenderer.invoke(channel('launch'), id),
  openVnite: () => ipcRenderer.invoke(channel('open-vnite')),
  hide: () => ipcRenderer.invoke(channel('hide')),
  onBlur: callback => {
    ipcRenderer.on(channel('blur'), () => callback());
  },
  onForceCollapse: callback => {
    ipcRenderer.on(channel('force-collapse'), () => callback());
  }
});
