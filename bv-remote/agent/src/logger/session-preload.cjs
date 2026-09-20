// Preload for Logger's hidden session window. Bridges the WebRTC renderer to the
// main process: screen source, signalling relay, and the one-way capture feed
// (main -> renderer -> data channel). CommonJS on purpose — Electron loads
// preloads as CJS. Channel names are namespaced `bvlog:` so they never collide
// with the Remote session's `bv:` channels running in the same process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('bvSession', {
  getSource: () => ipcRenderer.invoke('bvlog:get-source'),
  onStart: (cb) => ipcRenderer.on('bvlog:start', (_e, d) => cb(d)),
  onAnswer: (cb) => ipcRenderer.on('bvlog:answer', (_e, a) => cb(a)),
  onAdminCandidate: (cb) => ipcRenderer.on('bvlog:admin-candidate', (_e, c) => cb(c)),
  onSetFps: (cb) => ipcRenderer.on('bvlog:set-fps', (_e, fps) => cb(fps)),
  // The captured keyboard/mouse events, pushed from the main process for the
  // renderer to forward over the `capture` data channel.
  onCaptureEvent: (cb) => ipcRenderer.on('bvlog:capture', (_e, evt) => cb(evt)),
  sendOffer: (nonce, offer) => ipcRenderer.send('bvlog:offer', { nonce, offer }),
  sendCandidate: (nonce, candidate) => ipcRenderer.send('bvlog:device-candidate', { nonce, candidate }),
})
