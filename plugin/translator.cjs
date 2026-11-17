// 悬浮球里的「实时翻译字幕」：截屏 → Windows OCR → 翻译 → 底部字幕条。
// 以模块形式挂在悬浮球插件内，不单独占一个插件。
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require('electron');
const { spawn } = require('node:child_process');
const { writeFileSync, appendFileSync, statSync, renameSync } = require('node:fs');
const path = require('node:path');
const { translate: CH } = require('./channels.cjs');
const { createAnalyzer } = require('./analyzer.cjs');

const ENGINES = new Set(['tencent', 'google', 'openai']);

// 启动时把版本打进日志：排查「装了新版但界面没变」时一眼能看出跑的是哪一版
const VERSION = (() => {
  try {
    return require('./manifest.json').version || '?';
  } catch {
    return '?';
  }
})();

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function createTranslator({ api, stateFile, readState, writeState, refreshTray, defaults }) {
  const tempImage = path.join(app.getPath('temp'), 'local-vnite-ps-orb-ocr.png');

  // 诊断日志：OCR 出错时把两份识别结果写进 translate.log，方便对照调参。
  // 超过 512KB 就换一份，长期挂机不会把磁盘写满。
  function debugLog(line) {
    try {
      const file = path.join(path.dirname(stateFile), 'translate.log');
      try {
        if (statSync(file).size > 512 * 1024) renameSync(file, `${file}.1`);
      } catch {
        /* 文件还不存在 */
      }
      appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch {
      /* 忽略 */
    }
  }

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
    ocrEngine: 'paddle',
    subtitlePos: 'bottom',
    subtitleOffset: 0,
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
    cfg.subtitlePos = preferences?.translateSubtitlePos === 'top' ? 'top' : 'bottom';
    const offset = Number.parseInt(preferences?.translateSubtitleOffset, 10);
    cfg.subtitleOffset = Number.isFinite(offset) ? clamp(offset, 0, 300) : 0;
    cfg.ocrEngine = preferences?.translateOcrEngine === 'windows' ? 'windows' : 'paddle';
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

  // ————— PaddleOCR 子进程 —————
  // Windows 自带 OCR 对游戏里的描边字、半透明对话框很不稳；PaddleOCR 走的是
  // 专门的文字检测 + 日文识别模型，同样的台词基本能整句认对。
  // 模型加载要几百毫秒，所以只拉起一次常驻进程，逐张图复用。
  let paddleProc = null;
  let paddleBuffer = '';
  let paddleWaiters = [];
  // 子进程起不来（缺模型、杀软拦截）时先禁用一段时间，之后自动重试，
  // 不能因为一次启动失败就整局退化成 Windows OCR。
  const PADDLE_RETRY_MS = 5 * 60 * 1000;
  let paddleDownUntil = 0;

  function stopPaddle() {
    paddleBuffer = '';
    paddleWaiters.splice(0).forEach(waiter => {
      clearTimeout(waiter.timer);
      waiter.reject(new Error('paddle-stopped'));
    });
    if (paddleProc) {
      try {
        paddleProc.stdin.end();
        paddleProc.kill();
      } catch {
        /* 忽略 */
      }
      paddleProc = null;
    }
  }

  function startPaddle() {
    if (paddleProc || Date.now() < paddleDownUntil) return;
    const script = path.join(__dirname, 'ocr-paddle.cjs');
    paddleProc = spawn(process.execPath, [script], {
      windowsHide: true,
      // Vnite 主进程本身是 Electron，加上这个环境变量才会以纯 Node 方式跑脚本
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    });
    paddleProc.stdout.setEncoding('utf8');
    paddleProc.stdout.on('data', chunk => {
      paddleBuffer += chunk;
      let index;
      while ((index = paddleBuffer.indexOf('\n')) !== -1) {
        const line = paddleBuffer.slice(0, index).trim();
        paddleBuffer = paddleBuffer.slice(index + 1);
        if (!line) continue;
        let payload;
        try {
          payload = JSON.parse(line);
        } catch {
          continue;
        }
        if (payload.ready) continue;
        const waiter = paddleWaiters.shift();
        if (!waiter) continue;
        clearTimeout(waiter.timer);
        if (payload.error) waiter.reject(new Error(payload.error));
        else waiter.resolve(payload);
      }
    });
    paddleProc.stderr.on('data', () => {});
    paddleProc.on('exit', () => {
      paddleProc = null;
      paddleWaiters.splice(0).forEach(waiter => {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('paddle-exit'));
      });
    });
  }

  function paddleSend(imagePath, attempt = 1, timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (!paddleProc) startPaddle();
      if (!paddleProc) {
        reject(new Error('paddle-unavailable'));
        return;
      }
      const waiter = { resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const index = paddleWaiters.indexOf(waiter);
        if (index !== -1) paddleWaiters.splice(index, 1);
        reject(new Error('paddle-timeout'));
      }, timeout);
      paddleWaiters.push(waiter);
      try {
        paddleProc.stdin.write(`${JSON.stringify({ image: imagePath, attempt })}\n`);
      } catch (error) {
        clearTimeout(waiter.timer);
        const index = paddleWaiters.indexOf(waiter);
        if (index !== -1) paddleWaiters.splice(index, 1);
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

  // ————— 人名/称呼 —————
  // 同一部作品里同一个角色要一直叫同一个名字。OCR 偶尔会把生僻名字读成形近字
  // （壬→王），只靠「第一次见到的写法」会把第一次的错误永久固定下来，
  // 所以按出现次数投票：同一簇里出现最多的写法当标准名，其余变体往它上面归。
  const NAME_RE = /【([^】]{1,8})】/g;
  // 人名只允许假名和汉字：OCR 把引号、括号也吞进来时不能当成人名学习
  const NAME_OK = /^[\u3040-\u30ff\u4e00-\u9fff々〆ヵヶ]{1,8}$/;
  const nameStats = new Map(
    Object.entries(readState().nameStats || {})
      .filter(([name]) => NAME_OK.test(name))
      .map(([name, stat]) => [name, { count: Math.max(1, Number(stat?.count) || 1) }])
  );
  const glossary = new Map(
    Object.entries(readState().translateNames || {}).filter(([name]) => NAME_OK.test(name))
  );
  const pendingNames = new Set();
  let nameSaveTimer = null;

  // 已经翻译过的人名当作可信写法，给 5 次底分：
  // 之后 OCR 偶尔读成形近字（计数 1）也不会把正确写法顶掉
  Object.keys(glossary).forEach(name => {
    if (!nameStats.has(name)) nameStats.set(name, { count: 5 });
  });

  function persistNames() {
    writeState({
      translateNames: Object.fromEntries(glossary),
      nameStats: Object.fromEntries(nameStats)
    });
  }

  // 每句都会调到这里，攒 4 秒再落盘，避免每行字幕都写一次状态文件
  function scheduleNameSave() {
    if (nameSaveTimer) return;
    nameSaveTimer = setTimeout(() => {
      nameSaveTimer = null;
      persistNames();
    }, 4000);
  }

  function speakerNames(text) {
    return Array.from(String(text || '').matchAll(NAME_RE))
      .map(match => match[1].trim())
      .filter(name => name && NAME_OK.test(name));
  }

  // 两个写法是否同一个角色：单字名字太容易撞（武 / 慧 / 慧），只认完全相同；
  // 两字以上允许差一个字，但必须至少有一半字符对齐
  function sameName(a, b) {
    if (a === b) return true;
    if (a.length < 2 || b.length < 2) return false;
    if (Math.abs(a.length - b.length) > 1) return false;
    const distance = editDistance(a, b);
    return distance <= 1 && distance < Math.min(a.length, b.length);
  }

  // 同一簇里出现次数最多的写法就是标准名
  function canonicalName(name) {
    let best = name;
    let bestCount = nameStats.get(name)?.count || 0;
    for (const [variant, stat] of nameStats) {
      if (!sameName(variant, name)) continue;
      if (stat.count > bestCount) {
        bestCount = stat.count;
        best = variant;
      }
    }
    return best;
  }

  function fixSpeakers(text) {
    return String(text || '').replace(NAME_RE, (match, raw) => {
      const name = raw.trim();
      if (!name || !NAME_OK.test(name)) return match;
      const canonical = canonicalName(name);
      if (canonical !== name) {
        debugLog(`称呼纠正 ${name} → ${canonical}`);
        return `【${canonical}】`;
      }
      return match;
    });
  }

  function learnSpeakers(text) {
    speakerNames(text).forEach(name => {
      const stat = nameStats.get(name);
      if (stat) stat.count += 1;
      else nameStats.set(name, { count: 1 });
      // 换作品后旧人名会越攒越多，超量就把出现次数最少的丢掉
      if (nameStats.size > 80) {
        let weakest = '';
        let weakestCount = Infinity;
        for (const [variant, item] of nameStats) {
          if (item.count < weakestCount) {
            weakestCount = item.count;
            weakest = variant;
          }
        }
        if (weakest) nameStats.delete(weakest);
      }
      scheduleNameSave();
      if (glossary.has(name) || pendingNames.has(name)) return;
      pendingNames.add(name);
      translateText(name)
        .then(meaning => {
          const zh = String(meaning || '').trim();
          if (zh && zh !== name) {
            glossary.set(name, zh);
            scheduleNameSave();
          }
        })
        .catch(() => {})
        .finally(() => pendingNames.delete(name));
    });
  }

  function glossaryHint() {
    const pairs = [...glossary.entries()].filter(([, zh]) => zh).slice(0, 24);
    if (!pairs.length) return '';
    return `\n人物名对照（原文=译名，必须沿用）：${pairs.map(([ja, zh]) => `${ja}=${zh}`).join('，')}`;
  }

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
              '你是视觉小说翻译引擎。把用户给出的原文翻译成简体中文，只输出译文，不要解释、不要加引号，保留人物语气和称呼。' +
              glossaryHint()
          },
          { role: 'user', content: text }
        ]
      })
    });
    if (!response.ok) throw new Error(`http-${response.status}`);
    const data = await response.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  }

  // 接口偶尔抽风（超时、5xx）重试两次就够了；4xx 是配置问题，重试也没用
  async function withRetry(run, attempts = 3) {
    let lastError;
    for (let i = 0; i < attempts; i += 1) {
      try {
        return await run();
      } catch (error) {
        lastError = error;
        if (/^http-4|missing-api-url/.test(String(error?.message || ''))) break;
        await new Promise(resolve => setTimeout(resolve, 400 * (i + 1)));
      }
    }
    throw lastError;
  }

  function translateText(text) {
    if (cfg.engine === 'google') return withRetry(() => google(text));
    if (cfg.engine === 'openai') return withRetry(() => openaiCompatible(text));
    return withRetry(() => tencent(text));
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
    const height = clamp(subtitleBounds?.height || subtitleWin.getBounds().height || 168, 40, 320);
    const margin = Math.max(18, Math.round(area.height * 0.055));
    const next = {
      x: area.x + Math.round((area.width - width) / 2),
      // 贴底时底边固定、高度向上长；贴顶时上边固定、向下长
      y:
        cfg.subtitlePos === 'top'
          ? area.y + margin + cfg.subtitleOffset
          : area.y + area.height - height - margin - cfg.subtitleOffset,
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
      // 面板要接收点击（查词、拖动、缩放），不能再是非激活窗口：
      // 非激活 + 置顶的透明窗口在部分全屏游戏上会收不到鼠标消息
      focusable: true,
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
    // 相对层级 1：保证压在同为 screen-saver 的字幕窗/悬浮球窗之上
    studyWin.setAlwaysOnTop(true, 'screen-saver', 1);
    // 整块面板都可以按住拖动、右下角缩放，所以不再做鼠标穿透
    studyWin.setIgnoreMouseEvents(false);
    // Windows 上在 show 之前设置的穿透状态可能不生效，显示后再确认一次
    const rearm = () => {
      if (!studyWin || studyWin.isDestroyed()) return;
      studyWin.setIgnoreMouseEvents(false);
    };
    studyWin.on('show', rearm);
    studyWin.on('focus', rearm);
    studyWin.webContents.on('did-finish-load', rearm);
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
    win.webContents.send(CH.study, payload);
    placeStudy();
    if (!win.isVisible()) win.showInactive();
    // 先显示再关穿透，并提到最前，避免被置顶的游戏窗口挡住鼠标
    win.setIgnoreMouseEvents(false);
    win.moveTop();
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
      .then(() => ocrSend(tempImage, 6000))
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
  const DIFF_THRESHOLD = 0.012;
  const OCR_COOLDOWN = 380;

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
    learnSpeakers(text);
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
      rememberLine(text, cached);
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
    rememberLine(text, translated || '');
    showSubtitle(text, translated || '（翻译失败，检查引擎设置）');
  }

  // ————— 文本去抖：同一句被识别成两个版本时字幕不要来回跳 —————

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
  function acceptText(text) {
    if (!text) return undefined;
    if (text === lastText) return undefined;
    const a = skeleton(lastText);
    const b = skeleton(text);
    // 只把「同一句的识别抖动」当成重复：改一两个字相似度仍在 0.9 以上。
    // 以前用 0.82，会把「そうか」→「そうかよ」这种正常换行也吞掉，看起来就是漏行。
    if (a && b && 1 - editDistance(a, b) / Math.max(a.length, b.length) >= 0.9) return undefined;
    return deliver(text);
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

  // captureOnly：只把画面存成 BMP 交给 PaddleOCR，不在 PowerShell 里识别
  async function captureInHelper(captureOnly) {
    const display = screen.getDisplayMatching(cfg.region);
    const scale = display.scaleFactor || 1;
    const x = Math.round(cfg.region.x * scale);
    const y = Math.round(cfg.region.y * scale);
    const width = Math.max(8, Math.round(cfg.region.width * scale));
    const height = Math.max(8, Math.round(cfg.region.height * scale));
    const masks = maskRects(scale);
    const command = captureOnly ? 'capimg' : 'cap';
    return ocrSend(`${command} ${x} ${y} ${width} ${height}${masks}`, 5000);
  }

  // 两套预处理的结果里挑更像日文的那份：OCR 出错最典型的表现是假名被认成
  // 半角字母/数字、或者混进奇怪符号，按字符类别打分就能把这类垃圾档筛掉。
  function jpScore(text) {
    if (!text) return -Infinity;
    let kana = 0;
    let kanji = 0;
    let latin = 0;
    let digit = 0;
    let weird = 0;
    let useful = 0;
    for (const char of text) {
      if (/[\u3041-\u3096\u30a1-\u30fa\u30fc]/.test(char)) kana += 1;
      else if (/[\u4e00-\u9fff\u3005]/.test(char)) kanji += 1;
      else if (/[A-Za-z]/.test(char)) latin += 1;
      else if (/[0-9]/.test(char)) digit += 1;
      else if (/[、。，．！？…「」『』（）()・ー〜\s]/.test(char)) useful += 1;
      else weird += 1;
    }
    const total = kana + kanji + latin + digit + weird + useful;
    if (!total) return -Infinity;
    return (kana * 1.0 + kanji * 0.9 + useful * 0.2 - latin * 1.6 - digit * 1.6 - weird * 2.2) / total;
  }

  function pickBetter(base, alt) {
    if (!alt) return base;
    if (!base) return alt;
    const delta = jpScore(alt) - jpScore(base);
    // 分数接近时取更长的一份：漏字比错字更难靠翻译补救
    if (Math.abs(delta) < 0.05) return alt.length > base.length ? alt : base;
    return delta > 0 ? alt : base;
  }

  // 识别进程已经按「是否是同一个文本框」把视觉行归并成 blocks，
  // 不同文本框之间保留换行，避免把名字框和台词粘成一句。
  function normalizeBlocks(blocks) {
    const joiner = cfg.lang === 'en' ? ' ' : '';
    return blocks
      .map(block => String(block || '').replace(/\s+/g, joiner).trim())
      .filter(Boolean)
      .join('\n');
  }

  // OCR 行 → 文本：先拼接，再用词典把浊点误读纠回来（ブ↔プ、が↔か）
  async function textFromResult(result) {
    const baseRaw = Array.isArray(result.blocks) && result.blocks.length
      ? normalizeBlocks(result.blocks)
      : normalizeText(result.lines || []);
    const altRaw = Array.isArray(result.altBlocks) && result.altBlocks.length
      ? normalizeBlocks(result.altBlocks)
      : normalizeText(result.alt || []);
    const base = baseRaw ? await analyzer.correct(baseRaw).catch(() => baseRaw) : '';
    const alt = altRaw ? await analyzer.correct(altRaw).catch(() => altRaw) : '';
    const text = pickBetter(base, alt);
    if (alt && alt !== base) {
      debugLog(
        `ocr base=${JSON.stringify(base.slice(0, 40))} alt=${JSON.stringify(alt.slice(0, 40))} pick=${text === alt ? 'alt' : 'base'}`
      );
    }
    return fixSpeakers(text);
  }

  // 用离线词典给 OCR 结果打个分：正常台词几乎都能被切出来，乱码时未登录词会成片出现
  async function measureQuality(text) {
    if (!text) return { oov: 1, unknown: 0, total: 0, bad: true };
    const result = await analyzer.check(text).catch(() => null);
    return result || { oov: 0, unknown: 0, total: 0, bad: false };
  }

  async function processFrame() {
    if (captureMode === 'gdi' && canCaptureInHelper()) {
      const usePaddle = cfg.ocrEngine === 'paddle' && Date.now() >= paddleDownUntil;
      const result = await captureInHelper(usePaddle);
      if (result.skip || result.wait) {
        // wait：字幕还在逐字显示或画面在动，识别进程让我们等稳定帧
        idleTicks += 1;
        return;
      }
      idleTicks = 0;
      let text = '';
      if (usePaddle) {
        let payload;
        try {
          payload = await paddleSend(result.img, 1);
        } catch (error) {
          const reason = String(error?.message || error);
          // 开关翻译、切引擎时会主动停掉子进程，这不算故障，别进 5 分钟冷却
          if (reason === 'paddle-stopped') {
            debugLog('paddle 请求被打断，本轮忽略');
            return;
          }
          // 只有真的起不来才回落；过几分钟会自动再试
          paddleDownUntil = Date.now() + PADDLE_RETRY_MS;
          stopPaddle();
          debugLog(`paddle 不可用，${Math.round(PADDLE_RETRY_MS / 60000)} 分钟后重试: ${reason}`);
          console.warn(
            '[PS 悬浮球] PaddleOCR 不可用，暂时改用 Windows OCR',
            reason.startsWith('missing-model') ? `模型文件缺失（${reason}），请重新安装插件包` : reason
          );
          return;
        }
        text = await textFromResult(payload);
        // 这一帧没有文字（过场黑屏、菜单界面）直接结束，不用自检和复检
        if (!text) return;
        // 自检：生词率过高说明这帧基本是乱码，放大 1.5 倍复检一次再决定用哪份
        const quality = await measureQuality(text);
        if (quality.bad) {
          debugLog(`ocr 自检生词率 ${quality.oov.toFixed(2)}（${quality.unknown}/${quality.total}），复检`);
          let chosen = quality;
          try {
            const retry = await paddleSend(result.img, 2, 12000);
            const retryText = await textFromResult(retry);
            const retryQuality = await measureQuality(retryText);
            debugLog(`ocr 复检生词率 ${retryQuality.oov.toFixed(2)}`);
            if (retryText && (!retryQuality.bad || retryQuality.oov < quality.oov)) {
              text = retryText;
              chosen = retryQuality;
            }
          } catch (error) {
            debugLog(`ocr 复检失败: ${error?.message || error}`);
          }
          if (chosen.bad) {
            // 两份都像乱码：宁可不出字幕，也别把垃圾翻出来
            debugLog(`ocr 结果疑似乱码，本轮跳过: ${JSON.stringify(text.slice(0, 40))}`);
            return;
          }
        }
      } else {
        text = await textFromResult(result);
      }
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
    debugLog(`翻译启动 v${VERSION}（ocr=${cfg.ocrEngine}，位置=${cfg.subtitlePos}）`);
    lastSignature = null;
    lastText = '';
    lastTranslated = '';
    idleTicks = 0;
    failures = 0;
    captureFailures = 0;
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
      paddleDownUntil = 0;
      if (cfg.ocrEngine === 'paddle') startPaddle();
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
    stopPaddle();
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

  // 点单词查释义：有道「新日汉」词条带音调、词性、多个义项和双语例句，
  // 比把单个词丢给翻译引擎只换回一个笼统说法有用得多。
  // 词典未收录（人名、方言、拟声词）时回落到翻译引擎，至少有个近义说法。
  const lookupCache = new Map();

  function stripTags(text) {
    return String(text || '')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async function youdaoEntry(query) {
    const url = `https://dict.youdao.com/jsonapi?q=${encodeURIComponent(query)}&le=jap`;
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://dict.youdao.com/' }
    });
    if (!response.ok) throw new Error(`youdao-${response.status}`);
    const data = await response.json();
    const entry = data?.newjc;
    if (!entry || !entry.word) return null;
    const head = entry.word.head || {};
    const homonym = Array.isArray(entry.word.homonymD) ? entry.word.homonymD[0] : null;
    const senses = [];
    const pushSenses = list => {
      if (!Array.isArray(list)) return;
      list.forEach(sense => {
        const items = (sense?.phrList || []).map(item => stripTags(item?.jmsy)).filter(Boolean);
        if (items.length) senses.push({ pos: stripTags(sense?.cx || ''), text: items.join('；') });
      });
    };
    pushSenses(homonym?.sense);
    pushSenses(entry.word.sense);
    const examples = (data?.blng_sents_part?.['sentence-pair'] || [])
      .map(pair => ({
        ja: stripTags(pair?.sentence),
        zh: stripTags(pair?.['sentence-translation'])
      }))
      // 有道的例句偶尔会串到别的词（只按读音模糊匹配），单词核一下开头两三个字
      .filter(pair => {
        if (!pair.ja || !pair.zh || pair.zh === pair.ja) return false;
        const stem = query.slice(0, Math.min(3, query.length));
        return pair.ja.includes(stem);
      })
      .slice(0, 2);
    return {
      word: stripTags(head.hw || ''),
      // 词条可能以假名为主词条，汉字写法单独带出来
      kanji: stripTags(homonym?.head?.hw || ''),
      reading: stripTags(head.pjm || ''),
      tone: stripTags(homonym?.head?.tone || head.tone || ''),
      // 主词条的罗马字比 head 的「いじわる → iji/jiwaru」干净
      romaji: stripTags(homonym?.head?.rs || head.rs || '').replace(/\//g, '、'),
      exam: Array.isArray(entry.exam_type) ? entry.exam_type.join(' / ') : '',
      senses,
      examples
    };
  }

  async function lookupWord(payload) {
    const surface = String(payload?.surface || '').trim().slice(0, 40);
    if (!surface) return { meaning: '', detail: null };
    const base = String(payload?.base || '').trim().slice(0, 40);
    const query = base || surface;
    let entry = lookupCache.get(query);
    if (!entry) {
      entry = await youdaoEntry(query).catch(() => null);
      if (!entry || !entry.senses.length) {
        const meaning = await translateText(query).catch(() => '');
        entry = meaning ? { senses: [{ pos: '', text: meaning }], examples: [] } : null;
      }
      if (entry) {
        lookupCache.set(query, entry);
        if (lookupCache.size > 200) lookupCache.delete(lookupCache.keys().next().value);
      }
    }
    if (!entry) return { meaning: '', detail: null };
    const first = entry.senses?.[0]?.text || '';
    return {
      // 列表里只放第一义项的开头，完整的留到详情卡
      meaning: first.length > 36 ? `${first.slice(0, 36)}…` : first,
      detail: entry
    };
  }

  ipcMain.handle(CH.studyLookup, (event, payload) => {
    if (!studyWin || studyWin.isDestroyed() || event.sender !== studyWin.webContents) {
      return { meaning: '' };
    }
    return lookupWord(payload);
  });

  // ————— 生词本 / 字幕历史 —————
  const wordbook = Array.isArray(readState().wordbook) ? readState().wordbook.slice(0, 600) : [];
  const history = [];
  const HISTORY_LIMIT = 20;

  function wordbookList() {
    return wordbook.slice();
  }

  async function addToWordbook(payload) {
    const surface = String(payload?.surface || '').trim().slice(0, 40);
    if (!surface) return wordbookList();
    const key = String(payload?.base || surface).trim() || surface;
    // 同一个词（按原形判）只留一条，重复点击不叠加
    if (wordbook.some(item => item.key === key)) return wordbookList();
    const entry = await lookupWord(payload);
    wordbook.unshift({
      key,
      word: surface,
      reading: String(payload?.reading || '').trim(),
      pos: String(payload?.pos || '').trim(),
      meaning: String(entry?.meaning || '').trim(),
      at: Date.now()
    });
    if (wordbook.length > 600) wordbook.length = 600;
    writeState({ wordbook });
    return wordbookList();
  }

  function exportWordbook() {
    const escape = value => `"${String(value || '').replace(/"/g, '""')}"`;
    const rows = [['单词', '读音', '词性', '释义']];
    wordbook.forEach(item => rows.push([item.word, item.reading, item.pos, item.meaning]));
    const csv = rows.map(row => row.map(escape).join(',')).join('\r\n');
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(app.getPath('documents'), `ps-orb-生词本-${stamp}.csv`);
    // 带 BOM，Excel 双击打开不会把日文变成乱码
    writeFileSync(file, `\uFEFF${csv}`, 'utf8');
    return file;
  }

  function rememberLine(ja, zh) {
    if (!ja) return;
    const speaker = speakerNames(ja)[0] || '';
    if (history[0]?.ja === ja) {
      history[0].zh = zh || history[0].zh;
      return;
    }
    history.unshift({ ja, zh: zh || '', speaker, at: Date.now() });
    if (history.length > HISTORY_LIMIT) history.pop();
  }

  // 只有伴学窗口能读写，和 studyLookup 同一套校验
  function fromStudy(event) {
    return studyWin && !studyWin.isDestroyed() && event.sender === studyWin.webContents;
  }

  ipcMain.handle(CH.studyWordbookAdd, (event, payload) => {
    if (!fromStudy(event)) return [];
    return addToWordbook(payload);
  });

  ipcMain.handle(CH.studyWordbookList, event => {
    if (!fromStudy(event)) return [];
    return wordbookList();
  });

  ipcMain.handle(CH.studyWordbookExport, event => {
    if (!fromStudy(event)) return { error: 'forbidden' };
    try {
      return { file: exportWordbook() };
    } catch (error) {
      return { error: String(error?.message || error) };
    }
  });

  ipcMain.handle(CH.studyHistory, event => {
    if (!fromStudy(event)) return [];
    return history;
  });

  // 手动改名：用户看到 OCR 把生僻名字认错时可以一次性改正，
  // 改完给新写法一个压倒性的计数，以后即使又读错也会被投票纠正回来
  function renameSpeaker(from, to) {
    if (!from || !to || from === to || !NAME_OK.test(to)) return;
    const count = nameStats.get(from)?.count || 1;
    nameStats.set(to, { count: Math.max(count, nameStats.get(to)?.count || 0) + 50 });
    nameStats.delete(from);
    const zh = glossary.get(to);
    glossary.delete(from);
    if (!zh) {
      translateText(to)
        .then(value => {
          const text = String(value || '').trim();
          if (text && text !== to) {
            glossary.set(to, text);
            persistNames();
          }
        })
        .catch(() => {});
    }
    persistNames();
  }

  ipcMain.handle(CH.studyNames, event => {
    if (!fromStudy(event)) return [];
    return [...nameStats.entries()]
      .map(([name, stat]) => ({ name, zh: glossary.get(name) || '', count: stat.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
  });

  ipcMain.handle(CH.studyRename, (event, from, to) => {
    if (!fromStudy(event)) return [];
    renameSpeaker(String(from || ''), String(to || ''));
    return [...nameStats.entries()]
      .map(([name, stat]) => ({ name, zh: glossary.get(name) || '', count: stat.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 40);
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
    const next = clamp(Math.round(Number(height) || 0), 44, 320);
    const bounds = subtitleWin.getBounds();
    if (Math.abs(bounds.height - next) < 2) return;
    subtitleBounds = null;
    // 贴底时保持底边不动、向上长；贴顶时保持上边不动、向下长
    const y = cfg.subtitlePos === 'top' ? bounds.y : bounds.y + bounds.height - next;
    subtitleWin.setBounds({ ...bounds, y, height: next }, false);
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
        stream: cfg.stream,
        ocrEngine: cfg.ocrEngine,
        subtitlePos: cfg.subtitlePos,
        subtitleOffset: cfg.subtitleOffset
      };
      applyConfig(preferences);
      if (before.subtitlePos !== cfg.subtitlePos || before.subtitleOffset !== cfg.subtitleOffset) {
        subtitleBounds = null;
        placeSubtitle();
      }
      if (before.lang !== cfg.lang) {
        stopOcr();
        lastSignature = null;
        lastText = '';
      }
      if (before.ocrEngine !== cfg.ocrEngine) {
        paddleDownUntil = 0;
        stopPaddle();
        lastSignature = null;
        if (running && cfg.ocrEngine === 'paddle') startPaddle();
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
      // 还没落盘的人名计数补一次，避免刚玩几分钟就关 Vnite 时白学
      if (nameSaveTimer) {
        clearTimeout(nameSaveTimer);
        nameSaveTimer = null;
        persistNames();
      }
      if (loopTimer) clearTimeout(loopTimer);
      loopTimer = null;
      if (pumpTimer) clearTimeout(pumpTimer);
      pumpTimer = null;
      stopStudyDrag();
      stopOcr();
      stopPaddle();
      ipcMain.removeAllListeners(CH.regionCommit);
      ipcMain.removeAllListeners(CH.regionCancel);
      ipcMain.removeAllListeners(CH.resize);
      ipcMain.removeAllListeners(CH.captureFrame);
      ipcMain.removeAllListeners(CH.captureFailed);
      ipcMain.removeAllListeners(CH.studyDragStart);
      ipcMain.removeAllListeners(CH.studyDragEnd);
      ipcMain.removeAllListeners(CH.studyResize);
      ipcMain.removeHandler(CH.studyLookup);
      ipcMain.removeHandler(CH.studyWordbookAdd);
      ipcMain.removeHandler(CH.studyWordbookList);
      ipcMain.removeHandler(CH.studyWordbookExport);
      ipcMain.removeHandler(CH.studyHistory);
      ipcMain.removeHandler(CH.studyNames);
      ipcMain.removeHandler(CH.studyRename);
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
