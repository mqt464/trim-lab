const IPC = {
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

const ExportMode = {
  Precise: 'precise',
  Copy: 'copy'
};

module.exports = { IPC, ExportMode };
