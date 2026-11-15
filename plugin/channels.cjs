const { id } = require('./manifest.json');

// 悬浮球窗口、字幕窗、框选窗共用一套 preload，频道名集中在这里。
module.exports = {
  translate: {
    subtitle: `${id}:tr-subtitle`,
    style: `${id}:tr-style`,
    resize: `${id}:tr-resize`,
    regionCommit: `${id}:tr-region-commit`,
    regionCancel: `${id}:tr-region-cancel`,
    study: `${id}:tr-study`,
    captureStart: `${id}:tr-capture-start`,
    captureFrame: `${id}:tr-capture-frame`,
    captureFailed: `${id}:tr-capture-failed`
  }
};
