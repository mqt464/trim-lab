// Use CommonJS in preload to avoid ESM import errors
const { contextBridge, ipcRenderer } = require('electron');
let IPC = {
  openFileDialog: 'open-file-dialog',
  fileOpenedFromOS: 'file-opened-from-os',
  analyze: 'analyze-file',
  export: 'export-clip',
  exportProgress: 'export-progress',
  exportCancel: 'export-cancel',
  revealItem: 'reveal-item',
  readFileChunks: 'read-file-chunks',
  fileChunk: 'file-chunk',
  fileChunkEnd: 'file-chunk-end',
  cancelReadFile: 'cancel-read-file',
  generateWaveform: 'generate-waveform',
  generateThumbnails: 'generate-thumbnails',
  prepareAudioTracks: 'prepare-audio-tracks'
};
let ExportMode = { Precise: 'precise', Copy: 'copy' };
try {
  const shared = require('../common/ipc.js');
  if (shared?.IPC) IPC = shared.IPC;
  if (shared?.ExportMode) ExportMode = shared.ExportMode;
} catch {}

contextBridge.exposeInMainWorld('trimlab', {
  openFile: async () => ipcRenderer.invoke(IPC.openFileDialog),
  onFileOpenedFromOS: (cb) => {
    const handler = (_e, filePath) => cb(filePath);
    ipcRenderer.on(IPC.fileOpenedFromOS, handler);
    return () => ipcRenderer.removeListener(IPC.fileOpenedFromOS, handler);
  },
  analyze: async (filePath) => ipcRenderer.invoke(IPC.analyze, filePath),
  export: async (opts) => ipcRenderer.invoke(IPC.export, opts),
  onExportProgress: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on(IPC.exportProgress, handler);
    return () => ipcRenderer.removeListener(IPC.exportProgress, handler);
  },
  cancelExport: async () => ipcRenderer.invoke(IPC.exportCancel),
  reveal: async (filePath) => ipcRenderer.invoke(IPC.revealItem, filePath),
  readFileChunks: (filePath, chunkSize) => ipcRenderer.send(IPC.readFileChunks, { filePath, chunkSize }),
  onFileChunk: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on(IPC.fileChunk, handler);
    return () => ipcRenderer.removeListener(IPC.fileChunk, handler);
  },
  onFileChunkEnd: (cb) => {
    const handler = (_e, msg) => cb(msg);
    ipcRenderer.on(IPC.fileChunkEnd, handler);
    return () => ipcRenderer.removeListener(IPC.fileChunkEnd, handler);
  },
  cancelReadFile: (filePath) => ipcRenderer.send(IPC.cancelReadFile, filePath),
  generateWaveform: async (opts) => ipcRenderer.invoke(IPC.generateWaveform, opts),
  generateThumbnails: async (opts) => ipcRenderer.invoke(IPC.generateThumbnails, opts),
  prepareAudioTracks: async (opts) => ipcRenderer.invoke(IPC.prepareAudioTracks, opts),
  constants: { ExportMode }
});
