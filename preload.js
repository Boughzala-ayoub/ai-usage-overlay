'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const on = (ch) => (fn) => ipcRenderer.on(ch, (_e, v) => fn(v));

contextBridge.exposeInMainWorld('api', {
  onData: on('data'),
  onLayout: on('layout'),
  onOpen: on('open'),
  onReset: on('reset'),
  onReveal: on('reveal'),
  onDragging: on('dragging'),
  get: () => ipcRenderer.invoke('data'),
  rects: (r) => ipcRenderer.send('rects', r),
  menu: () => ipcRenderer.send('menu'),
  refresh: () => ipcRenderer.invoke('refresh'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.send('drag-end'),
});
