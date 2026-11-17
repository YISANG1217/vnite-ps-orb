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
    studyDragStart: `${id}:tr-study-drag-start`,
    studyDragEnd: `${id}:tr-study-drag-end`,
    studyResize: `${id}:tr-study-resize`,
    studyLookup: `${id}:tr-study-lookup`,
    studyWordbookAdd: `${id}:tr-study-wordbook-add`,
    studyWordbookList: `${id}:tr-study-wordbook-list`,
    studyWordbookExport: `${id}:tr-study-wordbook-export`,
    studyHistory: `${id}:tr-study-history`,
    studyNames: `${id}:tr-study-names`,
    studyRename: `${id}:tr-study-rename`,
    captureStart: `${id}:tr-capture-start`,
    captureFrame: `${id}:tr-capture-frame`,
    captureFailed: `${id}:tr-capture-failed`
  }
};
