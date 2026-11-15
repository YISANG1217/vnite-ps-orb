// 悬浮球里的「实时翻译字幕」：截屏 → Windows OCR → 翻译 → 底部字幕条。
// 以模块形式挂在悬浮球插件内，不单独占一个插件。
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');
const { translate: CH } = require('./channels.cjs');
const { createAnalyzer } = require('./analyzer.cjs');

const ENGINES = new Set(['tencent', 'google', 'openai']);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createTranslator({ api, stateFile, readState, writeState, refreshTray, defaults }) {
  const tempImage = path.join(app.getPath('temp'), 'local-vnite-ps-orb-ocr.png');

  const cfg = {
    enabled: false,
    engine: 'tencent',
    lang: 'ja',
    apiUrl: '',
    apiKey: '',
    model: '',
    fontSize: 22,
    original: true,
    interval: 1000,
    study: false,
    region: null
  };

  let subtitleWin = null;
  let overlayWin = null;
  let studyWin = null;
  let loopTimer = null;
  let running = false;
  let lastSignature = null;
  let lastOcrAt = 0;
  let idleTicks = 0;
  let lastText = '';
  let lastTranslated = '';
  let failures = 0;

  const analyzer = createAnalyzer(path.join(__dirname, 'node_modules', 'kuromoji'));

  const savedRegion = readState().translateRegion;
  if (savedRegion && Number.isFinite(savedRegion.x) && Number.isFinite(savedRegion.width)) {
    cfg.region = savedRegion;
  }

  function applyConfig(preferences) {
    cfg.enabled = preferences?.translateEnabled === true;
    cfg.engine = ENGINES.has(preferences?.translateEngine) ? preferences.translateEngine : 'tencent';
    cfg.lang = preferences?.translateLang === 'en' ? 'en' : 'ja';
    cfg.apiUrl = String(preferences?.translateApiUrl || defaults.translateApiUrl || '');
    cfg.apiKey = String(preferences?.translateApiKey || '');
    cfg.model = String(preferences?.translateModel || defaults.translateModel || '');
    const fontSize = Number.parseInt(preferences?.translateFontSize, 10);
    cfg.fontSize = Number.isFinite(fontSize) ? clamp(fontSize, 14, 40) : 22;
    cfg.original = preferences?.translateOriginal !== false;
    cfg.study = preferences?.translateStudy === true;
    const interval = Number.parseInt(preferences?.translateInterval, 10);
    cfg.interval = Number.isFinite(interval) ? clamp(interval, 400, 5000) : 1000;
  }

  // ————— OCR 助手 —————
  let ocrProc = null;
  let ocrReady = false;
  let ocrBuffer = '';
  const ocrWaiters = [];

  function stopOcr() {
    ocrReady = false;
    ocrBuffer = '';
    ocrWaiters.splice(0).forEach(waiter => {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('ocr-stopped'));
    });
    if (ocrProc) {
      try {
        ocrProc.stdin.end();
        ocrProc.kill();
      } catch {
        /* 忽略 */
      }
      ocrProc = null;
    }
  }

  function startOcr() {
    if (ocrProc) return;
    const script = path.join(__dirname, 'ovr.ps1');
    ocrProc = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Lang', cfg.lang],
      { windowsHide: true }
    );
    ocrProc.stdout.setEncoding('utf8');
    ocrProc.stdout.on('data', chunk => {
      ocrBuffer += chunk;
      let index;
      while ((index = ocrBuffer.indexOf('\n')) !== -1) {
        const line = ocrBuffer.slice(0, index).trim();
        ocrBuffer = ocrBuffer.slice(index + 1);
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.ready) {
          ocrReady = true;
          continue;
        }
        const waiter = ocrWaiters.shift();
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        if (payload.error) waiter.reject(new Error(payload.error));
        else waiter.resolve(payload);
      }
    });
    ocrProc.stderr.on('data', () => {});
    ocrProc.on('exit', () => {
      ocrProc = null;
      ocrReady = false;
      ocrWaiters.splice(0).forEach(waiter => {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('ocr-exit'));
      });
    });
  }

  // 向 OCR 助手发一条命令：可以是图片路径，也可以是 `cap x y w h` 直接抓屏
  function ocrSend(command, timeout = 4000) {
    return new Promise((resolve, reject) => {
      if (!ocrReady && !ocrProc) startOcr();
      if (!ocrProc) {
        reject(new Error('ocr-unavailable'));
        return;
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        // 超时后必须从队列里摘掉，否则后续响应会错位给下一个请求
        const index = ocrWaiters.indexOf(waiter);
        if (index !== -1) ocrWaiters.splice(index, 1);
        reject(new Error('ocr-timeout'));
      }, timeout);
      ocrWaiters.push(waiter);
      try {
        ocrProc.stdin.write(`${command}\n`);
      } catch (error) {
        clearTimeout(waiter.timer);
        const index = ocrWaiters.indexOf(waiter);
        if (index !== -1) ocrWaiters.splice(index, 1);
        reject(error);
      }
    });
  }

  // ————— 截图 —————
  async function grabRegion() {
    const display = screen.getDisplayMatching(cfg.region);
    const scale = display.scaleFactor || 1;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * scale),
        height: Math.round(display.size.height * scale)
      }
    });
    const source = sources.find(item => String(item.display_id) === String(display.id)) || sources[0];
    if (!source) throw new Error('no-screen-source');
    const size = source.thumbnail.getSize();
    if (!size.width || !size.height) throw new Error('empty-thumbnail');
    const ratio = size.width / display.size.width;
    const x = clamp(Math.round((cfg.region.x - display.bounds.x) * ratio), 0, size.width - 2);
    const y = clamp(Math.round((cfg.region.y - display.bounds.y) * ratio), 0, size.height - 2);
    const width = clamp(Math.round(cfg.region.width * ratio), 2, size.width - x);
    const height = clamp(Math.round(cfg.region.height * ratio), 2, size.height - y);
    return source.thumbnail.crop({ x, y, width, height });
  }

  function normalizeText(lines) {
    const joiner = cfg.lang === 'en' ? ' ' : '';
    return lines
      .map(line => String(line || '').trim())
      .filter(Boolean)
      .join(joiner)
      .replace(/\s+/g, joiner)
      .trim();
  }

  // ————— 翻译 —————
  const cache = new Map();

  async function tencent(text) {
    const response = await fetch('https://transmart.qq.com/api/imt', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Referer: 'https://transmart.qq.com/zh-CN/index',
        Origin: 'https://transmart.qq.com',
        'User-Agent': 'Mozilla/5.0'
      },
      body: JSON.stringify({
        header: {
          fn: 'auto_translation',
          client_key: `browser-chrome-124.0.0-Windows-10-${Date.now()}-default`
        },
        type: 'plain',
        model_category: 'normal',
        source: { lang: cfg.lang, text_list: [text] },
        target: { lang: 'zh' }
      })
    });
    const data = await response.json();
    if (data?.header?.ret_code && data.header.ret_code !== 'succ') {
      throw new Error(`tencent-${data.header.ret_code}`);
    }
    return (data?.auto_translation || []).join('');
  }

  async function google(text) {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=${cfg.lang}&tl=zh-CN&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = await response.json();
    return (data?.[0] || []).map(part => part?.[0] || '').join('');
  }

  async function openaiCompatible(text) {
    const base = cfg.apiUrl.replace(/\/+$/, '');
    if (!base) throw new Error('missing-api-url');
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const response = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model || 'gpt-4o-mini',
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              '你是视觉小说翻译引擎。把用户给出的原文翻译成简体中文，只输出译文，不要解释、不要加引号，保留人物语气和称呼。'
          },
          { role: 'user', content: text }
        ]
      })
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  }

  function translateText(text) {
    if (cfg.engine === 'google') return google(text);
    if (cfg.engine === 'openai') return openaiCompatible(text);
    return tencent(text);
  }

  // ————— 字幕窗 —————
  function createSubtitle() {
    if (subtitleWin && !subtitleWin.isDestroyed()) return subtitleWin;
    subtitleWin = new BrowserWindow({
      width: 900,
      height: 168,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    subtitleWin.setAlwaysOnTop(true, 'screen-saver');
    // 字幕窗不接收任何鼠标事件；不开 forward，避免每次鼠标移动都往渲染进程转发事件
    subtitleWin.setIgnoreMouseEvents(true);
    subtitleWin.loadFile(path.join(__dirname, 'subtitle.html'));
    subtitleWin.on('closed', () => {
      subtitleWin = null;
      subtitleBounds = null;
    });
    return subtitleWin;
  }

  // 位置没变就不要重复 setBounds：透明窗口每次改尺寸都会重建交换链，累积起来就是卡顿
  let subtitleBounds = null;

  function placeSubtitle() {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    const display = cfg.region ? screen.getDisplayMatching(cfg.region) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.round(area.width * 0.74);
    const height = clamp(subtitleBounds?.height || subtitleWin.getBounds().height || 168, 96, 320);
    const next = {
      x: area.x + Math.round((area.width - width) / 2),
      y: area.y + area.height - height - Math.round(area.height * 0.055),
      width,
      height
    };
    if (
      subtitleBounds &&
      next.x === subtitleBounds.x &&
      next.y === subtitleBounds.y &&
      next.width === subtitleBounds.width &&
      next.height === subtitleBounds.height
    ) {
      return;
    }
    subtitleBounds = next;
    subtitleWin.setBounds(next, false);
  }

  function showSubtitle(original, translated) {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    subtitleWin.webContents.send(CH.subtitle, {
      original: cfg.original ? original : '',
      translated
    });
    placeSubtitle();
    if (!subtitleWin.isVisible()) subtitleWin.showInactive();
  }

  function pushStyle() {
    if (!subtitleWin || subtitleWin.isDestroyed()) return;
    subtitleWin.webContents.send(CH.style, { fontSize: cfg.fontSize, showOriginal: cfg.original });
  }

  // ————— 伴学面板 —————
  function createStudy() {
    if (studyWin && !studyWin.isDestroyed()) return studyWin;
    studyWin = new BrowserWindow({
      width: 440,
      height: 640,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      alwaysOnTop: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    studyWin.setAlwaysOnTop(true, 'screen-saver');
    studyWin.setIgnoreMouseEvents(true);
    studyWin.loadFile(path.join(__dirname, 'study.html'));
    studyWin.on('closed', () => {
      studyWin = null;
      studyBounds = null;
    });
    return studyWin;
  }

  let studyBounds = null;

  // 伴学面板贴在游戏窗口所在屏幕的右侧，竖向居中
  function placeStudy() {
    if (!studyWin || studyWin.isDestroyed()) return;
    const display = cfg.region ? screen.getDisplayMatching(cfg.region) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = Math.min(460, Math.max(320, Math.round(area.width * 0.3)));
    const height = Math.min(680, Math.round(area.height * 0.68));
    const next = {
      x: area.x + area.width - width - Math.round(area.width * 0.018),
      y: area.y + Math.round((area.height - height) / 2),
      width,
      height
    };
    if (
      studyBounds &&
      next.x === studyBounds.x &&
      next.y === studyBounds.y &&
      next.width === studyBounds.width &&
      next.height === studyBounds.height
    ) {
      return;
    }
    studyBounds = next;
    studyWin.setBounds(next, false);
  }

  function showStudy(payload) {
    if (!cfg.study) return;
    const win = createStudy();
    win.webContents.send(CH.study, payload);
    placeStudy();
    if (!win.isVisible()) win.showInactive();
  }

  const analysisCache = new Map();

  async function analyzeLine(text, translation) {
    let analysis = analysisCache.get(text);
    if (!analysis) {
      analysis = await analyzer.analyze(text);
      if (!analysis) return;
      analysisCache.set(text, analysis);
      if (analysisCache.size > 60) analysisCache.delete(analysisCache.keys().next().value);
    }
    showStudy({ ...analysis, translation });
  }

  // ————— 主循环 —————
  function schedule(delay) {
    if (!running) return;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = setTimeout(tick, delay);
  }

  // 默认让 OCR 助手用 GDI 直接抓区域：抓屏、比对、识别都在子进程里完成，
  // 主进程不再每秒截一次全屏、不再写临时文件，鼠标就不会隔几秒卡一下。
  let captureMode = 'gdi';
  let captureFailures = 0;

  const SIGNATURE_WIDTH = 48;
  const DIFF_THRESHOLD = 0.035;
  const OCR_COOLDOWN = 520;

  function coarseSignature(image) {
    const size = image.getSize();
    const height = Math.max(2, Math.round((size.height / Math.max(1, size.width)) * SIGNATURE_WIDTH));
    return image.resize({ width: SIGNATURE_WIDTH, height }).toBitmap();
  }

  function diffRatio(previous, next) {
    if (!previous || !next || previous.length !== next.length) return 1;
    const pixels = next.length / 4;
    let changed = 0;
    for (let index = 0; index < next.length; index += 4) {
      const delta =
        Math.abs(next[index] - previous[index]) +
        Math.abs(next[index + 1] - previous[index + 1]) +
        Math.abs(next[index + 2] - previous[index + 2]);
      if (delta > 36) changed += 1;
    }
    return changed / pixels;
  }

  async function deliver(text) {
    lastText = text;
    let translated = cache.get(text);
    if (translated === undefined) {
      translated = await translateText(text).catch(error => {
        console.warn('[PS 悬浮球] 翻译失败', error?.message || error);
        return '';
      });
      if (translated) {
        cache.set(text, translated);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
      }
    }
    lastTranslated = translated || '';
    showSubtitle(text, translated || '（翻译失败，检查引擎设置）');
    if (cfg.study) {
      analyzeLine(text, translated || '').catch(error => {
        console.warn('[PS 悬浮球] 分词失败', error?.message || error);
      });
    }
  }

  // 子进程直接抓屏：只在主屏上启用，坐标才能和物理像素一一对应
  function canCaptureInHelper() {
    const display = screen.getDisplayMatching(cfg.region);
    return display.bounds.x === 0 && display.bounds.y === 0;
  }

  async function captureInHelper() {
    const display = screen.getDisplayMatching(cfg.region);
    const scale = display.scaleFactor || 1;
    const x = Math.round(cfg.region.x * scale);
    const y = Math.round(cfg.region.y * scale);
    const width = Math.max(8, Math.round(cfg.region.width * scale));
    const height = Math.max(8, Math.round(cfg.region.height * scale));
    return ocrSend(`cap ${x} ${y} ${width} ${height}`, 5000);
  }

  async function processFrame() {
    if (captureMode === 'gdi' && canCaptureInHelper()) {
      const result = await captureInHelper();
      if (result.skip) {
        idleTicks += 1;
        return;
      }
      idleTicks = 0;
      const text = normalizeText(result.lines || []);
      if (text && text !== lastText) await deliver(text);
      return;
    }

    const image = await grabRegion();
    const signature = coarseSignature(image);
    const now = Date.now();
    // 冷却中或画面变化太小：跳过本帧，保留旧基准以便慢速变化累积
    if (now - lastOcrAt < OCR_COOLDOWN || diffRatio(lastSignature, signature) < DIFF_THRESHOLD) {
      idleTicks += 1;
      return;
    }
    lastSignature = signature;
    lastOcrAt = now;
    idleTicks = 0;

    writeFileSync(tempImage, image.toPNG());
    const result = await ocrSend(tempImage);
    const text = normalizeText(result.lines || []);
    if (!text || text === lastText) return;
    await deliver(text);
  }

  async function tick() {
    loopTimer = null;
    if (!running) return;
    const started = Date.now();
    try {
      if (cfg.region) await processFrame();
      failures = 0;
    } catch (error) {
      failures += 1;
      const message = String(error?.message || '');
      if (failures <= 3) console.warn('[PS 悬浮球] 字幕识别失败', message || error);
      lastSignature = null;
      if (captureMode === 'gdi' && /^capture-|^bad-capture-args$|^ocr-timeout$/.test(message)) {
        captureFailures += 1;
        if (captureFailures >= 2) {
          captureMode = 'electron';
          console.warn('[PS 悬浮球] 直接截屏不可用，改用系统截图');
        }
      }
      if (failures === 3) stopOcr();
    }
    // 子进程抓屏很便宜，不需要降频（降频会让新台词晚 1-3 秒才出现）；
    // 只有回落到主进程截图时才降频，避免反复抓全屏
    const backoff =
      captureMode === 'electron'
        ? idleTicks >= 10
          ? Math.round(cfg.interval * 1.4)
          : idleTicks >= 3
            ? Math.round(cfg.interval * 0.6)
            : 0
        : 0;
    schedule(Math.max(150, cfg.interval + backoff - (Date.now() - started)));
  }

  function start() {
    if (running) return;
    running = true;
    lastSignature = null;
    lastText = '';
    lastTranslated = '';
    idleTicks = 0;
    failures = 0;
    captureFailures = 0;
    createSubtitle();
    pushStyle();
    placeSubtitle();
    subtitleWin.showInactive();
    if (cfg.study) {
      analyzer.warmup();
      createStudy();
      placeStudy();
    }
    if (cfg.region) {
      startOcr();
      schedule(120);
    }
    refreshTray();
  }

  function stop() {
    running = false;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    stopOcr();
    if (subtitleWin && !subtitleWin.isDestroyed()) subtitleWin.hide();
    if (studyWin && !studyWin.isDestroyed()) studyWin.hide();
    refreshTray();
  }

  // ————— 框选区域 —————
  function openOverlay() {
    if (overlayWin && !overlayWin.isDestroyed()) {
      overlayWin.show();
      overlayWin.focus();
      return;
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    overlayWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    overlayWin.loadFile(path.join(__dirname, 'overlay.html'));
    overlayWin.once('ready-to-show', () => {
      if (!overlayWin) return;
      overlayWin.setBounds(display.bounds);
      overlayWin.show();
      overlayWin.focus();
    });
    overlayWin.on('closed', () => {
      overlayWin = null;
    });
  }

  ipcMain.on(CH.regionCommit, (event, rect) => {
    if (!overlayWin || event.sender !== overlayWin.webContents) return;
    const bounds = overlayWin.getBounds();
    const region = {
      x: Math.round(bounds.x + Math.max(0, rect?.x || 0)),
      y: Math.round(bounds.y + Math.max(0, rect?.y || 0)),
      width: Math.max(24, Math.round(rect?.width || 0)),
      height: Math.max(16, Math.round(rect?.height || 0))
    };
    const area = screen.getDisplayMatching(region).bounds;
    region.width = Math.min(region.width, area.x + area.width - region.x);
    region.height = Math.min(region.height, area.y + area.height - region.y);
    cfg.region = region;
    lastSignature = null;
    lastOcrAt = 0;
    lastText = '';
    writeState({ translateRegion: region });
    overlayWin.close();
    if (cfg.enabled && !running) start();
    placeSubtitle();
  });

  ipcMain.on(CH.regionCancel, event => {
    if (!overlayWin || event.sender !== overlayWin.webContents) return;
    overlayWin.close();
  });

  ipcMain.on(CH.resize, (event, height) => {
    if (!subtitleWin || subtitleWin.isDestroyed() || event.sender !== subtitleWin.webContents) return;
    const next = clamp(Math.round(Number(height) || 0), 96, 320);
    const bounds = subtitleWin.getBounds();
    if (Math.abs(bounds.height - next) < 2) return;
    subtitleBounds = null;
    subtitleWin.setBounds({ ...bounds, y: bounds.y + bounds.height - next, height: next }, false);
  });

  return {
    sync(preferences) {
      const before = {
        enabled: cfg.enabled,
        lang: cfg.lang,
        fontSize: cfg.fontSize,
        original: cfg.original,
        interval: cfg.interval,
        study: cfg.study
      };
      applyConfig(preferences);
      if (before.lang !== cfg.lang) {
        stopOcr();
        lastSignature = null;
        lastText = '';
      }
      if (before.fontSize !== cfg.fontSize || before.original !== cfg.original) pushStyle();
      if (before.interval !== cfg.interval) schedule(cfg.interval);
      if (before.study !== cfg.study) {
        if (cfg.study) {
          analyzer.warmup();
          createStudy();
          placeStudy();
          if (lastText) analyzeLine(lastText, lastTranslated).catch(() => {});
        } else if (studyWin && !studyWin.isDestroyed()) {
          studyWin.hide();
        }
      }
      if (before.enabled !== cfg.enabled) {
        if (cfg.enabled) start();
        else stop();
      }
    },
    async toggle() {
      const next = !running;
      try {
        await api.PluginDB.setValue('translateEnabled', next);
      } catch {
        /* 写入失败时仍然先按当前操作生效 */
      }
      cfg.enabled = next;
      if (next) start();
      else stop();
    },
    isRunning: () => running,
    info: () => ({ translateEnabled: running, translateFontSize: cfg.fontSize, studyEnabled: cfg.study }),
    openOverlay,
    dispose() {
      running = false;
      if (loopTimer) clearTimeout(loopTimer);
      loopTimer = null;
      stopOcr();
      ipcMain.removeAllListeners(CH.regionCommit);
      ipcMain.removeAllListeners(CH.regionCancel);
      ipcMain.removeAllListeners(CH.resize);
      [overlayWin, subtitleWin, studyWin].forEach(target => {
        if (target && !target.isDestroyed()) target.destroy();
      });
      overlayWin = null;
      subtitleWin = null;
      studyWin = null;
    }
  };
}

module.exports = { createTranslator };
