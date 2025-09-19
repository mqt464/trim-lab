// Use CommonJS in preload to avoid ESM import errors
const { contextBridge, ipcRenderer } = require('electron');

// Inline IPC constants to expose synchronously
const IPC = {
  openFileDialog: 'open-file-dialog',
  fileOpenedFromOS: 'file-opened-from-os',
  analyze: 'analyze-file',
  export: 'export-clip',
  revealItem: 'reveal-item',
  readFileChunks: 'read-file-chunks',
  fileChunk: 'file-chunk',
  fileChunkEnd: 'file-chunk-end',
  cancelReadFile: 'cancel-read-file'
};
const ExportMode = { Precise: 'precise', Copy: 'copy' };
const GEN_WAVEFORM = 'generate-waveform';
const GEN_THUMBS = 'generate-thumbnails';
const PREP_AUDIO = 'prepare-audio-tracks';

contextBridge.exposeInMainWorld('trimlab', {
  openFile: async () => ipcRenderer.invoke(IPC.openFileDialog),
  onFileOpenedFromOS: (cb) => ipcRenderer.on(IPC.fileOpenedFromOS, (_e, filePath) => cb(filePath)),
  analyze: async (filePath) => ipcRenderer.invoke(IPC.analyze, filePath),
  export: async (opts) => ipcRenderer.invoke(IPC.export, opts),
  onExportProgress: (cb) => ipcRenderer.on('export-progress', (_e, msg) => cb(msg)),
  cancelExport: async () => ipcRenderer.invoke('export-cancel'),
  reveal: async (filePath) => ipcRenderer.invoke(IPC.revealItem, filePath),
  readFileChunks: (filePath, chunkSize) => ipcRenderer.send(IPC.readFileChunks, { filePath, chunkSize }),
  onFileChunk: (cb) => ipcRenderer.on(IPC.fileChunk, (_e, msg) => cb(msg)),
  onFileChunkEnd: (cb) => ipcRenderer.on(IPC.fileChunkEnd, (_e, msg) => cb(msg)),
  cancelReadFile: (filePath) => ipcRenderer.send(IPC.cancelReadFile, filePath),
  generateWaveform: async (opts) => ipcRenderer.invoke(GEN_WAVEFORM, opts),
  generateThumbnails: async (opts) => ipcRenderer.invoke(GEN_THUMBS, opts),
  prepareAudioTracks: async (opts) => ipcRenderer.invoke(PREP_AUDIO, opts),
  constants: { ExportMode }
});
