const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petAPI', {
  setIgnore: (v) => ipcRenderer.send('set-ignore', v),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragEnd: () => ipcRenderer.invoke('drag-end'),
  showMenu: () => ipcRenderer.send('show-menu'),
  sendStats: (s) => ipcRenderer.send('stats', s),
  quit: () => ipcRenderer.send('quit-now'),
  requestShow: () => ipcRenderer.send('request-show'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getSong: () => ipcRenderer.invoke('get-song'),
  aiStatus: () => ipcRenderer.invoke('ai-status'),
  aiIdle: (ctx) => ipcRenderer.invoke('ai-idle', ctx),
  aiChat: (text, ctx) => ipcRenderer.invoke('ai-chat', text, ctx),
  songBpm: (title, artist) => ipcRenderer.invoke('song-bpm', title, artist),
  reportModelMetrics: (m) => ipcRenderer.send('model-metrics', m),
  focusWindow: () => ipcRenderer.send('focus-window'),
  voiceGet: (text) => ipcRenderer.invoke('voice-get', text),
  voicePrefetch: (lines) => ipcRenderer.send('voice-prefetch', lines),
  on: (channel, fn) => {
    if (['cursor', 'action', 'settings', 'drag-state', 'hidden', 'song', 'lyrics', 'long-work'].includes(channel)) {
      ipcRenderer.on(channel, (_e, data) => fn(data));
    }
  },
});
