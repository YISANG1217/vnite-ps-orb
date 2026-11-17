const { contextBridge, ipcRenderer } = require('electron');
const { id } = require('./manifest.json');
const { translate: TR } = require('./channels.cjs');

const channel = name => `${id}:${name}`;

// 悬浮球、字幕窗、框选窗共用这一个 preload
contextBridge.exposeInMainWorld('psOrb', {
  bootstrap: () => ipcRenderer.invoke(channel('bootstrap')),
  games: () => ipcRenderer.invoke(channel('games')),
  dragStart: () => ipcRenderer.send(channel('drag-start')),
  dragMove: () => ipcRenderer.send(channel('drag-move')),
  dragEnd: () => ipcRenderer.send(channel('drag-end')),
  expand: () => ipcRenderer.invoke(channel('expand')),
  collapse: () => ipcRenderer.invoke(channel('collapse')),
  setIgnore: ignore => ipcRenderer.send(channel('set-ignore'), Boolean(ignore)),
  contextMenu: () => ipcRenderer.send(channel('context-menu')),
  launch: id => ipcRenderer.invoke(channel('launch'), id),
  openVnite: () => ipcRenderer.invoke(channel('open-vnite')),
  hide: () => ipcRenderer.invoke(channel('hide')),
  setOption: (key, value) => ipcRenderer.invoke(channel('set-option'), key, value),
  openTranslateRegion: () => ipcRenderer.invoke(channel('open-translate-region')),
  onLayout: callback => {
    ipcRenderer.on(channel('layout'), (_event, payload) => callback(payload));
  },
  onOpenSettings: callback => {
    ipcRenderer.on(channel('open-settings'), () => callback());
  },
  onBlur: callback => {
    ipcRenderer.on(channel('blur'), () => callback());
  },
  onForceCollapse: callback => {
    ipcRenderer.on(channel('force-collapse'), () => callback());
  },
  onForceExpand: callback => {
    ipcRenderer.on(channel('force-expand'), () => callback());
  },
  onSubtitle: callback => {
    ipcRenderer.on(TR.subtitle, (_event, payload) => callback(payload));
  },
  onSubtitleStyle: callback => {
    ipcRenderer.on(TR.style, (_event, payload) => callback(payload));
  },
  onStudy: callback => {
    ipcRenderer.on(TR.study, (_event, payload) => callback(payload));
  },
  onCaptureStart: callback => {
    ipcRenderer.on(TR.captureStart, (_event, payload) => callback(payload));
  },
  studyDragStart: () => ipcRenderer.send(TR.studyDragStart),
  studyDragEnd: () => ipcRenderer.send(TR.studyDragEnd),
  studyResize: size => ipcRenderer.send(TR.studyResize, size),
  lookupWord: payload => ipcRenderer.invoke(TR.studyLookup, payload),
  wordbookAdd: payload => ipcRenderer.invoke(TR.studyWordbookAdd, payload),
  wordbookList: () => ipcRenderer.invoke(TR.studyWordbookList),
  wordbookExport: () => ipcRenderer.invoke(TR.studyWordbookExport),
  history: () => ipcRenderer.invoke(TR.studyHistory),
  names: () => ipcRenderer.invoke(TR.studyNames),
  renameName: (from, to) => ipcRenderer.invoke(TR.studyRename, from, to),
  pushCaptureFrame: buffer => ipcRenderer.send(TR.captureFrame, buffer),
  captureFailed: reason => ipcRenderer.send(TR.captureFailed, String(reason || 'unknown')),
  resizeSubtitle: height => ipcRenderer.send(TR.resize, height),
  commitRegion: rect => ipcRenderer.send(TR.regionCommit, rect),
  cancelRegion: () => ipcRenderer.send(TR.regionCancel)
});
