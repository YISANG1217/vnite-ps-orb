const { app, BrowserWindow, ipcMain, screen, globalShortcut } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { id: pluginId, configuration } = require('./manifest.json');

const PAD = 26;
const GAP = 16;
const PANEL_W = 344;
const PANEL_H = 452;
const VISIBLE_MARGIN = 8;

const CHANNELS = {
  bootstrap: `${pluginId}:bootstrap`,
  games: `${pluginId}:games`,
  dragStart: `${pluginId}:drag-start`,
  dragMove: `${pluginId}:drag-move`,
  dragEnd: `${pluginId}:drag-end`,
  expand: `${pluginId}:expand`,
  collapse: `${pluginId}:collapse`,
  launch: `${pluginId}:launch`,
  openVnite: `${pluginId}:open-vnite`,
  hide: `${pluginId}:hide`,
  blur: `${pluginId}:blur`,
  forceCollapse: `${pluginId}:force-collapse`
};

const OPTION_DEFAULTS = Object.fromEntries(
  (configuration || []).map(option => [option.id, option.default])
);

const SIZES = new Set([84, 96, 112]);
const ACCENTS = new Set(['blue', 'violet', 'cyan']);

let dispose;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function activate(api) {
  if (dispose) return;
  await api.PluginDB.getValue('#all', {});

  const stateFile = path.join(app.getPath('userData'), 'plugins', pluginId, 'state.json');
  let orbSize = 96;
  let accent = 'blue';
  let sound = true;
  let expanded = false;
  let orbPoint = null;
  let drag = null;
  let win = null;

  function readPreferences() {
    return api.PluginDB.getValue('#all', {}).catch(() => ({}));
  }

  function applyOptions(preferences) {
    const size = Number.parseInt(preferences?.size, 10);
    orbSize = SIZES.has(size) ? size : Number.parseInt(OPTION_DEFAULTS.size, 10) || 96;
    accent = ACCENTS.has(preferences?.accent) ? preferences.accent : 'blue';
    sound = preferences?.sound ?? true;
  }

  function normalizePoint(point) {
    const area = screen.getDisplayNearestPoint(point).workArea;
    return {
      x: clamp(Math.round(point.x), area.x + VISIBLE_MARGIN, area.x + area.width - orbSize - VISIBLE_MARGIN),
      y: clamp(Math.round(point.y), area.y + VISIBLE_MARGIN, area.y + area.height - orbSize - VISIBLE_MARGIN)
    };
  }

  function loadPoint() {
    try {
      const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
      if (Number.isFinite(raw?.x) && Number.isFinite(raw?.y)) {
        return normalizePoint({ x: raw.x, y: raw.y });
      }
    } catch {
      /* 首次启动或文件损坏时使用默认位置 */
    }
    const area = screen.getPrimaryDisplay().workArea;
    return normalizePoint({
      x: area.x + area.width - orbSize - 40,
      y: area.y + area.height - orbSize - 56
    });
  }

  function savePoint() {
    if (!win || win.isDestroyed() || !orbPoint) return;
    try {
      mkdirSync(path.dirname(stateFile), { recursive: true });
      writeFileSync(stateFile, JSON.stringify({ x: orbPoint.x, y: orbPoint.y }), 'utf8');
    } catch (error) {
      console.warn('[PS 悬浮球] 保存位置失败', error);
    }
  }

  function collapsedBounds() {
    return {
      x: orbPoint.x - PAD,
      y: orbPoint.y - PAD,
      width: orbSize + PAD * 2,
      height: orbSize + PAD * 2
    };
  }

  function expandedBounds() {
    const center = { x: orbPoint.x + orbSize / 2, y: orbPoint.y + orbSize / 2 };
    const area = screen.getDisplayNearestPoint(center).workArea;
    const width = PAD * 2 + PANEL_W + GAP + orbSize;
    const aboveHeight = PAD * 2 + PANEL_H;
    const belowHeight = PAD * 2 + orbSize + GAP + PANEL_H;
    const sideLeft = orbPoint.x - (PANEL_W + GAP + PAD) >= area.x + VISIBLE_MARGIN;
    const aboveFits = orbPoint.y + orbSize - area.y >= aboveHeight + VISIBLE_MARGIN;
    const vertical = aboveFits ? 'above' : 'below';
    const height = aboveFits ? aboveHeight : belowHeight;
    let x = sideLeft ? orbPoint.x - (width - PAD - orbSize) : orbPoint.x - PAD;
    let y = aboveFits ? orbPoint.y + orbSize - (height - PAD) : orbPoint.y - PAD;
    x = clamp(x, area.x + VISIBLE_MARGIN, area.x + area.width - width - VISIBLE_MARGIN);
    y = clamp(y, area.y + VISIBLE_MARGIN, area.y + area.height - height - VISIBLE_MARGIN);
    return {
      x: Math.round(x),
      y: Math.round(y),
      width,
      height,
      side: sideLeft ? 'left' : 'right',
      vertical
    };
  }

  function layoutPayload(extra) {
    return {
      pad: PAD,
      panelWidth: PANEL_W,
      panelHeight: PANEL_H,
      orbSize,
      accent,
      ...extra
    };
  }

  function send(channel, payload) {
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
  }

  function findVniteWindow() {
    return BrowserWindow.getAllWindows().find(candidate => {
      if (candidate === win || candidate.isDestroyed()) return false;
      try {
        return new URL(candidate.webContents.getURL()).pathname.endsWith('/out/renderer/index.html');
      } catch {
        return false;
      }
    }) || null;
  }

  function projectGames(documents, settings) {
    const nsfwMode = Number(settings?.nsfwFilterMode ?? 0);
    const blurLevel = Number(settings?.nsfwBlurLevel ?? 0);
    const list = [];
    for (const game of Object.values(documents || {})) {
      if (!game?._id || game._id.startsWith('_') || game._deleted || !game.metadata?.name) continue;
      const nsfw = Boolean(game.apperance?.nsfw);
      if (nsfwMode === 1 && nsfw) continue;
      const record = game.record ?? {};
      const lastRunDate = typeof record.lastRunDate === 'string' ? record.lastRunDate : '';
      const conceal = nsfw && blurLevel >= 2;
      list.push({
        id: game._id,
        name: conceal ? '已隐藏的游戏' : game.metadata.name,
        playTime: Number.isFinite(record.playTime) ? Math.max(0, record.playTime) : 0,
        lastRunDate: conceal ? '' : lastRunDate,
        blurCover: nsfw && blurLevel >= 1,
        played: Boolean(lastRunDate)
      });
    }
    list.sort((left, right) => {
      const diff = (Date.parse(right.lastRunDate) || 0) - (Date.parse(left.lastRunDate) || 0);
      return diff || left.name.localeCompare(right.name, 'zh-CN');
    });
    return {
      games: list.filter(game => game.played).slice(0, 4),
      total: list.length
    };
  }

  async function gameSnapshot() {
    const [settings, documents] = await Promise.all([
      api.ConfigDB.getConfigValue('appearances').catch(() => ({})),
      api.GameDB.getAllGames()
    ]);
    return projectGames(documents, settings ?? {});
  }

  function createWindow() {
    orbPoint = loadPoint();
    const bounds = collapsedBounds();
    win = new BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      show: false,
      alwaysOnTop: true,
      acceptFirstMouse: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        devTools: false
      }
    });
    win.setAlwaysOnTop(true, 'floating');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch {
      /* Windows 上该调用可能被忽略，不影响置顶 */
    }
    win.loadFile(path.join(__dirname, 'orb.html'));
    win.once('ready-to-show', () => {
      if (win && !win.isDestroyed()) win.showInactive();
    });
    // ready-to-show 在个别透明窗口上不触发，did-finish-load 兜底显示。
    win.webContents.once('did-finish-load', () => {
      if (win && !win.isDestroyed() && !win.isVisible()) win.showInactive();
    });
    win.on('blur', () => {
      if (expanded) send(CHANNELS.blur);
    });
    win.on('closed', () => {
      win = null;
    });
    win.webContents.on('render-process-gone', () => {
      if (win && !win.isDestroyed()) win.reload();
    });
  }

  function ensureWindow() {
    if (!win || win.isDestroyed()) createWindow();
    return win;
  }

  const initialPreferences = await readPreferences();
  applyOptions(initialPreferences);
  createWindow();

  function checkSender(event) {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('The orb channel is available only inside the floating orb window.');
    }
  }

  function setCollapsedBounds() {
    if (!win || win.isDestroyed()) return;
    orbPoint = normalizePoint(orbPoint);
    const bounds = collapsedBounds();
    win.setBounds(bounds, false);
    expanded = false;
    savePoint();
  }

  ipcMain.handle(CHANNELS.bootstrap, async event => {
    checkSender(event);
    const preferences = await readPreferences();
    applyOptions(preferences);
    const snapshot = await gameSnapshot();
    return layoutPayload({ ...snapshot, sound });
  });

  ipcMain.handle(CHANNELS.games, async event => {
    checkSender(event);
    const preferences = await readPreferences();
    const previousSize = orbSize;
    applyOptions(preferences);
    if (previousSize !== orbSize) {
      if (expanded) setCollapsedBounds();
      else {
        orbPoint = normalizePoint(orbPoint);
        win.setBounds(collapsedBounds(), false);
      }
    }
    const snapshot = await gameSnapshot();
    return layoutPayload({ ...snapshot, sound });
  });

  ipcMain.on(CHANNELS.dragStart, event => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents || expanded) return;
    drag = { origin: win.getBounds(), cursor: screen.getCursorScreenPoint() };
  });

  ipcMain.on(CHANNELS.dragMove, event => {
    if (!drag || !win || win.isDestroyed() || event.sender !== win.webContents || expanded) return;
    const point = screen.getCursorScreenPoint();
    win.setPosition(
      Math.round(drag.origin.x + point.x - drag.cursor.x),
      Math.round(drag.origin.y + point.y - drag.cursor.y)
    );
  });

  ipcMain.on(CHANNELS.dragEnd, event => {
    if (!drag || !win || win.isDestroyed() || event.sender !== win.webContents) return;
    drag = null;
    const bounds = win.getBounds();
    orbPoint = normalizePoint({ x: bounds.x + PAD, y: bounds.y + PAD });
    win.setBounds(collapsedBounds(), false);
    savePoint();
  });

  ipcMain.handle(CHANNELS.expand, event => {
    checkSender(event);
    if (!win || win.isDestroyed()) return layoutPayload({});
    const bounds = win.getBounds();
    orbPoint = { x: bounds.x + PAD, y: bounds.y + PAD };
    const laidOut = expandedBounds();
    win.setBounds({ x: laidOut.x, y: laidOut.y, width: laidOut.width, height: laidOut.height }, false);
    expanded = true;
    // 聚焦窗口，点击桌面其它位置时才能收到 blur 并自动收起。
    win.focus();
    return layoutPayload(laidOut);
  });

  ipcMain.handle(CHANNELS.collapse, event => {
    checkSender(event);
    setCollapsedBounds();
    return layoutPayload(collapsedBounds());
  });

  ipcMain.handle(CHANNELS.launch, (event, id) => {
    checkSender(event);
    if (typeof id !== 'string' || !id) {
      throw new Error('Invalid game id.');
    }
    const target = findVniteWindow();
    if (!target) return { ok: false, reason: 'vnite-window' };
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    if (typeof api.ipc?.sendTo === 'function') {
      api.ipc.sendTo(target.webContents, 'game:start-from-url', id);
    } else {
      target.webContents.send('game:start-from-url', id);
    }
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.openVnite, event => {
    checkSender(event);
    const target = findVniteWindow();
    if (!target) return false;
    if (target.isMinimized()) target.restore();
    target.show();
    target.focus();
    return true;
  });

  ipcMain.handle(CHANNELS.hide, event => {
    checkSender(event);
    setCollapsedBounds();
    if (win && !win.isDestroyed()) win.hide();
    return true;
  });

  function toggleVisible() {
    const target = ensureWindow();
    if (target.isVisible()) {
      send(CHANNELS.forceCollapse);
      setCollapsedBounds();
      target.hide();
    } else {
      target.showInactive();
    }
  }

  const hotkeyEnabled = initialPreferences?.hotkey !== false;
  if (hotkeyEnabled) {
    let registered = false;
    try {
      registered = globalShortcut.register('Control+Alt+P', () => {
        if (!win || win.isDestroyed()) return;
        toggleVisible();
      });
    } catch (error) {
      console.warn('[PS 悬浮球] 注册快捷键失败', error);
    }
    if (!registered) console.warn('[PS 悬浮球] Ctrl+Alt+P 已被其他程序占用');
  }

  const onDisplayChange = () => {
    if (!win || win.isDestroyed()) return;
    orbPoint = normalizePoint(orbPoint);
    if (!expanded) win.setBounds(collapsedBounds(), false);
    savePoint();
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  dispose = async () => {
    screen.removeListener('display-metrics-changed', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
    globalShortcut.unregister('Control+Alt+P');
    Object.entries(CHANNELS).forEach(([key, channel]) => {
      if (key === 'blur' || key === 'forceCollapse') return;
      if (channel.endsWith(':drag-start') || channel.endsWith(':drag-move') || channel.endsWith(':drag-end')) {
        ipcMain.removeAllListeners(channel);
      } else {
        ipcMain.removeHandler(channel);
      }
    });
    if (win && !win.isDestroyed()) {
      win.removeAllListeners('blur');
      win.destroy();
    }
    win = null;
    drag = null;
    orbPoint = null;
  };
}

async function deactivate() {
  if (!dispose) return;
  const cleanup = dispose;
  dispose = undefined;
  await cleanup();
}

module.exports = { activate, deactivate };
