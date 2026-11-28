// 위쪽 막대와 가운데 막대(폭 조절)용
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('silo', {
  cmd: (c, a) => ipcRenderer.send('bar:cmd', c, a),
  onState: (f) => ipcRenderer.on('bar:state', (_e, s) => f(s)),
  onToast: (f) => ipcRenderer.on('bar:toast', (_e, t) => f(t)),
  drag: (phase, x) => ipcRenderer.send('divider:drag', phase, x),
  brandRect: (r) => ipcRenderer.send('bar:brand', r),
  onUpdatePrompt: (f) => ipcRenderer.on('update:prompt', (_e, p) => f(p)),
});
