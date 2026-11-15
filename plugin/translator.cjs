// 悬浮球里的「实时翻译字幕」：截屏 → OCR（PaddleOCR / Windows OCR）→ 翻译 → 底部字幕条。
// 以模块形式挂在悬浮球插件内，不单独占一个插件。
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, nativeImage } = require('electron');
const { spawn } = require('node:child_process');
const { writeFileSync, promises: fsPromises } = require('node:fs');
const path = require('node:path');
const { translate: CH } = require('./channels.cjs');
const { createAnalyzer } = require('./analyzer.cjs');
const paddleOcr = require('./paddle-ocr.cjs');

const ENGINES = new Set(['tencent', 'google', 'openai']);

// 日文优先用 PaddleOCR（PP-OCR ONNX）；模型缺失或推理失败时自动回落 Windows OCR
const USE_PADDLE_OCR = true;

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
    stream: false,
    region: null
  };

  let subtitleWin = null;
  let overlayWin = null;
  let studyWin = null;
  let captureWin = null;
  let captureSourceId = '';
  let lastFrameAt = 0;
  let ocrBusy = false;
  let pendingFrame = null;
  let pumpTimer = null;
  let lastOcrStart = 0;
  let streamReady = false;
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
    cfg.stream = preferences?.translateStream === true;
    const interval = Number.parseInt(preferences?.translateInterval, 10);
    cfg.interval = Number.isFinite(interval) ? clamp(interval, 400, 5000) : 1000;
  }

  // ————— OCR 助手 —————
  let ocrProc = null;
  let ocrReady = false;
  let ocrBuffer = '';
  const ocrWaiters = [];

  // PaddleOCR 只识别日文；连续失败三次后彻底回落到 Windows OCR，不每帧重试
  let paddleFailures = 0;
  let paddleWarned = false;

  function paddleUsable() {
    return USE_PADDLE_OCR && cfg.lang === 'ja' && paddleFailures < 3;
  }

  async function paddleRecognize(run) {
    if (!paddleUsable()) return null;
    try {
      const result = await run();
      if (result && Array.isArray(result.lines) && result.lines.length) return result;
      return null;
    } catch (error) {
      paddleFailures += 1;
      if (!paddleWarned) {
        paddleWarned = true;
        console.warn('[PS 悬浮球] PaddleOCR 失败，回落到 Windows OCR', error?.message || error);
      }
      return null;
    }
  }

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
    // 整块面板都可以按住拖动、右下角缩放，所以不再做鼠标穿透
    studyWin.setIgnoreMouseEvents(false);
    studyWin.loadFile(path.join(__dirname, 'study.html'));
    studyWin.on('closed', () => {
      studyWin = null;
      studyBounds = null;
    });
    return studyWin;
  }

  let studyBounds = null;
  let studyRect = null;
  let studyDrag = null;

  const savedStudy = readState().studyRect;
  if (savedStudy && Number.isFinite(savedStudy.width) && Number.isFinite(savedStudy.height)) {
    studyRect = {
      x: Number(savedStudy.x) || 0,
      y: Number(savedStudy.y) || 0,
      width: savedStudy.width,
      height: savedStudy.height
    };
  }

  // 伴学面板：默认贴游戏屏幕右侧竖向居中；拖动/缩放后记住位置与大小
  function placeStudy() {
    if (!studyWin || studyWin.isDestroyed()) return;
    // 拖动过程中不要重排，否则会跟 16ms 的跟随循环抢位置/尺寸
    if (studyDrag) return;
    const display = cfg.region ? screen.getDisplayMatching(cfg.region) : screen.getPrimaryDisplay();
    const area = display.workArea;
    const width = clamp(
      studyRect ? Math.round(studyRect.width) : Math.round(area.width * 0.3),
      320,
      Math.min(620, area.width - 40)
    );
    const height = clamp(
      studyRect ? Math.round(studyRect.height) : Math.round(area.height * 0.68),
      320,
      Math.min(900, area.height - 40)
    );
    const next = {
      x: clamp(studyRect ? Math.round(studyRect.x) : area.x + area.width - width - Math.round(area.width * 0.018), area.x, area.x + area.width - width),
      y: clamp(studyRect ? Math.round(studyRect.y) : area.y + Math.round((area.height - height) / 2), area.y, area.y + area.height - height),
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

  function rememberStudyRect() {
    if (!studyWin || studyWin.isDestroyed()) return;
    const rect = studyWin.getBounds();
    studyRect = rect;
    studyBounds = rect;
    writeState({ studyRect: rect });
  }

  function stopStudyDrag() {
    if (!studyDrag) return;
    clearInterval(studyDrag.timer);
    studyDrag = null;
    rememberStudyRect();
  }

  function handleStudyDragStart(event) {
    if (!studyWin || event.sender !== studyWin.webContents) return;
    stopStudyDrag();
    const point = screen.getCursorScreenPoint();
    const bounds = studyWin.getBounds();
    // 尺寸固定成按下那一刻的值：每帧重新 getBounds 会被系统取整，拖久了面板会慢慢变大
    const drag = {
      dx: point.x - bounds.x,
      dy: point.y - bounds.y,
      width: bounds.width,
      height: bounds.height,
      timer: null
    };
    drag.timer = setInterval(() => {
      if (!studyWin || studyWin.isDestroyed() || studyDrag !== drag) {
        stopStudyDrag();
        return;
      }
      const cursor = screen.getCursorScreenPoint();
      const area = screen.getDisplayNearestPoint(cursor).workArea;
      studyWin.setBounds(
        {
          x: clamp(cursor.x - drag.dx, area.x, area.x + area.width - drag.width),
          y: clamp(cursor.y - drag.dy, area.y, area.y + area.height - drag.height),
          width: drag.width,
          height: drag.height
        },
        false
      );
    }, 16);
    studyDrag = drag;
  }

  function handleStudyResize(event, size) {
    if (!studyWin || event.sender !== studyWin.webContents) return;
    const bounds = studyWin.getBounds();
    const area = screen.getDisplayMatching(bounds).workArea;
    const width = clamp(Math.round(Number(size?.width) || bounds.width), 320, Math.min(620, area.width - 40));
    const height = clamp(Math.round(Number(size?.height) || bounds.height), 320, Math.min(900, area.height - 40));
    studyBounds = null;
    studyWin.setBounds(
      {
        x: clamp(bounds.x, area.x, area.x + area.width - width),
        y: clamp(bounds.y, area.y, area.y + area.height - height),
        width,
        height
      },
      false
    );
    rememberStudyRect();
  }

  function showStudy(payload) {
    if (!cfg.study) return;
    const win = createStudy();
    // 每次显示前再确认一次可点击，避免任何情况下残留穿透状态
    win.setIgnoreMouseEvents(false);
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

  // ————— 持续画面流 —————
  // 参考 Luna Translator 的思路：捕获会话只建立一次，由 GPU 持续出帧，
  // 变化检测放在渲染进程，只有真的换台词才把那一小块图传给主进程做 OCR。
  function sendCaptureConfig() {
    if (!captureWin || captureWin.isDestroyed() || !captureSourceId || !cfg.region) return;
    const display = screen.getDisplayMatching(cfg.region);
    captureWin.webContents.send(CH.captureStart, {
      sourceId: captureSourceId,
      region: cfg.region,
      origin: { x: display.bounds.x, y: display.bounds.y },
      displayWidth: display.size.width,
      displayHeight: display.size.height,
      scale: display.scaleFactor || 1,
      interval: cfg.interval
    });
  }

  async function startCaptureStream() {
    const display = cfg.region ? screen.getDisplayMatching(cfg.region) : screen.getPrimaryDisplay();
    if (!captureSourceId) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1, height: 1 }
        });
        const source = sources.find(item => String(item.display_id) === String(display.id)) || sources[0];
        captureSourceId = source?.id || '';
      } catch (error) {
        console.warn('[PS 悬浮球] 获取屏幕源失败', error?.message || error);
      }
    }
    if (!running || !cfg.region) return false;
    if (!captureSourceId) {
      captureMode = 'gdi';
      return false;
    }
    if (captureWin && !captureWin.isDestroyed()) {
      sendCaptureConfig();
      return true;
    }
    captureWin = new BrowserWindow({
      x: -10,
      y: -10,
      width: 2,
      height: 2,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false
      }
    });
    // 2x2 透明窗口放在角落：页面保持“可见”，视频流才会持续出帧
    captureWin.setOpacity(0.01);
    captureWin.setIgnoreMouseEvents(true);
    captureWin.loadFile(path.join(__dirname, 'capture.html'));
    captureWin.webContents.once('did-finish-load', () => {
      if (!captureWin || captureWin.isDestroyed()) return;
      lastFrameAt = Date.now();
      sendCaptureConfig();
      captureWin.showInactive();
    });
    captureWin.on('closed', () => {
      captureWin = null;
      if (captureMode === 'stream' && running) {
        console.warn('[PS 悬浮球] 画面流窗口关闭，改用直接截屏');
        captureMode = 'gdi';
        lastSignature = null;
        lastOcrAt = 0;
      }
    });
    return true;
  }

  function stopCaptureStream() {
    if (captureWin && !captureWin.isDestroyed()) captureWin.destroy();
    captureWin = null;
  }

  function handleCaptureFrame(event, data) {
    if (!captureWin || event.sender !== captureWin.webContents) return;
    if (captureMode !== 'stream' || !running) return;
    lastFrameAt = Date.now();
    // 空包只是心跳，说明流还活着
    if (!data || data.length === 0) return;
    if (!streamReady) {
      streamReady = true;
      console.log('[PS 悬浮球] 画面流已就绪');
    }
    // 只保留最新一帧，识别跟不上时自然丢中间帧
    pendingFrame = Buffer.from(data);
    pumpCaptureOcr();
  }

  // 画面一直在动（动画、特效）时也至少隔 650ms 才识别一次，避免把 CPU 占满
  const OCR_MIN_GAP = 650;

  // 画面流给的是 JPEG：用 Electron 自带的解码器转成 BGRA 位图，省掉额外的图片解码依赖
  function decodeFrame(buffer) {
    try {
      const image = nativeImage.createFromBuffer(buffer);
      if (image.isEmpty()) return null;
      const size = image.getSize();
      if (!size.width || !size.height) return null;
      return { data: image.toBitmap(), width: size.width, height: size.height, format: 'bgra' };
    } catch {
      return null;
    }
  }

  function pumpCaptureOcr() {
    if (ocrBusy || !pendingFrame || !running || captureMode !== 'stream') return;
    const wait = OCR_MIN_GAP - (Date.now() - lastOcrStart);
    if (wait > 0) {
      if (!pumpTimer) {
        pumpTimer = setTimeout(() => {
          pumpTimer = null;
          pumpCaptureOcr();
        }, wait);
      }
      return;
    }
    const buffer = pendingFrame;
    pendingFrame = null;
    lastOcrStart = Date.now();
    ocrBusy = true;
    fsPromises
      .writeFile(tempImage, buffer)
      .then(async () => {
        if (paddleUsable()) {
          const bitmap = decodeFrame(buffer);
          const result = bitmap ? await paddleRecognize(() => paddleOcr.recognizeBitmap(bitmap)) : null;
          if (result) return result;
        }
        return ocrSend(tempImage, 6000);
      })
      .then(async result => {
        idleTicks = 0;
        const text = await textFromResult(result);
        if (text) await acceptText(text);
        return undefined;
      })
      .catch(error => {
        const message = String(error?.message || '');
        if (failures < 3) console.warn('[PS 悬浮球] 字幕识别失败', message);
      })
      .finally(() => {
        ocrBusy = false;
        pumpCaptureOcr();
      });
  }

  // ————— 主循环 —————
  function schedule(delay) {
    if (!running) return;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = setTimeout(tick, delay);
  }

  // 默认用子进程 GDI 抓屏（不会触发 Windows 的屏幕捕获提示）；
  // 想省 CPU 可打开「系统画面流」，但系统会在屏幕顶部显示捕获提示条
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

  let deliverSeq = 0;

  async function deliver(text) {
    lastText = text;
    const seq = (deliverSeq += 1);
    const cached = cache.get(text);
    // 先把原文贴出来，译文回来后再补：长句翻译要一两秒，不能干等
    showSubtitle(text, cached !== undefined ? cached : '翻译中…');
    if (cfg.study) {
      analyzeLine(text, cached || '').catch(error => {
        console.warn('[PS 悬浮球] 分词失败', error?.message || error);
      });
    }
    if (cached !== undefined) {
      lastTranslated = cached;
      return;
    }
    const translated = await translateText(text).catch(error => {
      console.warn('[PS 悬浮球] 翻译失败', error?.message || error);
      return '';
    });
    if (seq !== deliverSeq) return;
    if (translated) {
      cache.set(text, translated);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
    lastTranslated = translated || '';
    showSubtitle(text, translated || '（翻译失败，检查引擎设置）');
  }

  // ————— 文本去抖：同一句被识别成两个版本时字幕不要来回跳 —————
  let pendingText = '';

  const SKELETON_RE = /[\s\p{P}\p{S}]/gu;

  function skeleton(text) {
    return String(text || '').replace(SKELETON_RE, '');
  }

  function editDistance(a, b) {
    const cols = b.length + 1;
    let prev = new Array(cols);
    let curr = new Array(cols);
    for (let j = 0; j < cols; j += 1) prev[j] = j;
    for (let i = 1; i <= a.length; i += 1) {
      curr[0] = i;
      for (let j = 1; j < cols; j += 1) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      const swap = prev;
      prev = curr;
      curr = swap;
    }
    return prev[cols - 1];
  }

  // 同一句的两种识别结果差异很小 → 忽略，保留先显示的那次
  // 完全不同的文本要连续出现两次才上屏，避免闪一下乱码又跳回来
  function acceptText(text) {
    if (!text) return undefined;
    if (text === lastText) {
      pendingText = '';
      return undefined;
    }
    const a = skeleton(lastText);
    const b = skeleton(text);
    if (a && b) {
      if (a === b) return undefined;
      if (1 - editDistance(a, b) / Math.max(a.length, b.length) >= 0.82) return undefined;
    }
    if (!lastText) {
      pendingText = '';
      return deliver(text);
    }
    if (pendingText && skeleton(pendingText) === b) {
      pendingText = '';
      return deliver(text);
    }
    // 长句直接上屏：大图识别本来就慢，再等一帧会让延迟翻倍
    if (b.length >= 16) {
      pendingText = '';
      return deliver(text);
    }
    pendingText = text;
    return undefined;
  }

  // 子进程直接抓屏：只在主屏上启用，坐标才能和物理像素一一对应
  function canCaptureInHelper() {
    const display = screen.getDisplayMatching(cfg.region);
    return display.bounds.x === 0 && display.bounds.y === 0;
  }

  // 把我们自己的字幕条/伴学面板涂黑再识别，否则会把显示出来的译文中再识别一遍
  function maskRects(scale) {
    const rects = [];
    [subtitleWin, studyWin].forEach(win => {
      if (!win || win.isDestroyed() || !win.isVisible()) return;
      const bounds = win.getBounds();
      rects.push(
        Math.round(bounds.x * scale),
        Math.round(bounds.y * scale),
        Math.round(bounds.width * scale),
        Math.round(bounds.height * scale)
      );
    });
    return rects.length ? ` ${rects.join(' ')}` : '';
  }

  async function captureInHelper() {
    const display = screen.getDisplayMatching(cfg.region);
    const scale = display.scaleFactor || 1;
    const x = Math.round(cfg.region.x * scale);
    const y = Math.round(cfg.region.y * scale);
    const width = Math.max(8, Math.round(cfg.region.width * scale));
    const height = Math.max(8, Math.round(cfg.region.height * scale));
    const masks = maskRects(scale);
    if (paddleUsable()) {
      // 先只抓图（复用子进程的抓屏 + 去重），PNG 交给主进程里的 PaddleOCR
      const grabbed = await ocrSend(`grab "${tempImage}" ${x} ${y} ${width} ${height}${masks}`, 5000);
      if (grabbed.skip) return grabbed;
      if (grabbed.file) {
        const result = await paddleRecognize(() => paddleOcr.recognizeFile(grabbed.file));
        if (result) return result;
        // 没检测到文字或推理失败：同一张 PNG 直接交给 Windows OCR，不重复抓屏
        return ocrSend(grabbed.file, 5000);
      }
    }
    return ocrSend(`cap ${x} ${y} ${width} ${height}${masks}`, 5000);
  }

  // OCR 行 → 文本：先拼接，再用词典把浊点误读纠回来（ブ↔プ、が↔か）
  async function textFromResult(result) {
    const raw = normalizeText(result.lines || []);
    if (!raw) return '';
    return analyzer.correct(raw).catch(() => raw);
  }

  async function processFrame() {
    if (captureMode === 'gdi' && canCaptureInHelper()) {
      const result = await captureInHelper();
      if (result.skip) {
        idleTicks += 1;
        return;
      }
      idleTicks = 0;
      const text = await textFromResult(result);
      if (text) await acceptText(text);
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
    const text = await textFromResult(result);
    if (!text) return;
    await acceptText(text);
  }

  async function tick() {
    loopTimer = null;
    if (!running) return;
    const started = Date.now();
    if (captureMode === 'stream') {
      // 帧由渲染进程推送，这里只做存活检查：流 9 秒没动静就回落
      if (lastFrameAt && Date.now() - lastFrameAt > 9000) {
        console.warn('[PS 悬浮球] 画面流无响应，改用直接截屏');
        captureMode = 'gdi';
        lastSignature = null;
        lastOcrAt = 0;
        stopCaptureStream();
      }
      schedule(cfg.interval);
      return;
    }
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
    pendingText = '';
    idleTicks = 0;
    failures = 0;
    captureFailures = 0;
    paddleFailures = 0;
    lastOcrStart = 0;
    pendingFrame = null;
    streamReady = false;
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
      // 提前把 ONNX 会话建好，避免第一句台词多等三百毫秒
      if (paddleUsable()) paddleOcr.load().catch(() => {});
      captureMode = cfg.stream ? 'stream' : 'gdi';
      lastFrameAt = 0;
      if (cfg.stream) {
        startCaptureStream().catch(error => {
          console.warn('[PS 悬浮球] 启动画面流失败', error?.message || error);
          captureMode = 'gdi';
        });
      }
      schedule(120);
    }
    refreshTray();
  }

  function stop() {
    running = false;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    if (pumpTimer) clearTimeout(pumpTimer);
    pumpTimer = null;
    pendingFrame = null;
    stopOcr();
    stopCaptureStream();
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
    // 画面流不用重建，换一下裁剪范围就行
    if (running && captureMode === 'stream') sendCaptureConfig();
    placeSubtitle();
  });

  ipcMain.on(CH.regionCancel, event => {
    if (!overlayWin || event.sender !== overlayWin.webContents) return;
    overlayWin.close();
  });

  ipcMain.on(CH.captureFrame, handleCaptureFrame);

  ipcMain.on(CH.studyDragStart, handleStudyDragStart);
  ipcMain.on(CH.studyDragEnd, () => stopStudyDrag());
  ipcMain.on(CH.studyResize, handleStudyResize);

  // 点单词查释义：优先用词形还原后的原形查，结果按词缓存
  const lookupCache = new Map();

  async function lookupWord(payload) {
    const surface = String(payload?.surface || '').trim().slice(0, 40);
    if (!surface) return { meaning: '' };
    const base = String(payload?.base || '').trim().slice(0, 40);
    const query = base || surface;
    let meaning = lookupCache.get(query);
    if (meaning === undefined) {
      meaning = await translateText(query).catch(() => '');
      if (meaning) {
        lookupCache.set(query, meaning);
        if (lookupCache.size > 200) lookupCache.delete(lookupCache.keys().next().value);
      }
    }
    return { meaning };
  }

  ipcMain.handle(CH.studyLookup, (event, payload) => {
    if (!studyWin || studyWin.isDestroyed() || event.sender !== studyWin.webContents) {
      return { meaning: '' };
    }
    return lookupWord(payload);
  });

  ipcMain.on(CH.captureFailed, (event, reason) => {
    if (!captureWin || event.sender !== captureWin.webContents) return;
    console.warn('[PS 悬浮球] 画面流不可用，改用直接截屏', reason);
    captureMode = 'gdi';
    lastSignature = null;
    lastOcrAt = 0;
    stopCaptureStream();
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
        study: cfg.study,
        stream: cfg.stream
      };
      applyConfig(preferences);
      if (before.lang !== cfg.lang) {
        stopOcr();
        lastSignature = null;
        lastText = '';
        pendingText = '';
      }
      if (before.fontSize !== cfg.fontSize || before.original !== cfg.original) pushStyle();
      if (before.interval !== cfg.interval) schedule(cfg.interval);
      if (before.stream !== cfg.stream && running) {
        // 切换取画方式：关掉画面流（避免系统捕获提示常驻），按新方式重来
        stopCaptureStream();
        captureMode = cfg.stream ? 'stream' : 'gdi';
        lastSignature = null;
        lastOcrAt = 0;
        if (cfg.stream) {
          startCaptureStream().catch(() => {
            captureMode = 'gdi';
          });
        }
      }
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
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = null;
      stopStudyDrag();
      stopOcr();
      ipcMain.removeAllListeners(CH.regionCommit);
      ipcMain.removeAllListeners(CH.regionCancel);
      ipcMain.removeAllListeners(CH.resize);
      ipcMain.removeAllListeners(CH.captureFrame);
      ipcMain.removeAllListeners(CH.captureFailed);
      ipcMain.removeAllListeners(CH.studyDragStart);
      ipcMain.removeAllListeners(CH.studyDragEnd);
      ipcMain.removeAllListeners(CH.studyResize);
      ipcMain.removeHandler(CH.studyLookup);
      [overlayWin, subtitleWin, studyWin, captureWin].forEach(target => {
        if (target && !target.isDestroyed()) target.destroy();
      });
      overlayWin = null;
      subtitleWin = null;
      studyWin = null;
      captureWin = null;
    }
  };
}

module.exports = { createTranslator };
