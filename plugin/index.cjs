const { app, BrowserWindow, ipcMain, screen, globalShortcut, MenuItem, Tray } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');
const { id: pluginId, configuration } = require('./manifest.json');

// 窗口始终保持展开后的尺寸：展开/收起只切换面板显隐，不再改变窗口大小，
// 这是点击悬浮球时闪动的根因。透明区域通过 setIgnoreMouseEvents 让鼠标穿透。
const PAD = 22;
const GAP = 16;
const PANEL_W = 344;
const PANEL_H = 452;
const EDGE = 8;
const TRAY_ITEM_ID = `${pluginId}:tray-toggle`;

const CHANNELS = {
  bootstrap: `${pluginId}:bootstrap`,
  games: `${pluginId}:games`,
  dragStart: `${pluginId}:drag-start`,
  dragMove: `${pluginId}:drag-move`,
  dragEnd: `${pluginId}:drag-end`,
  expand: `${pluginId}:expand`,
  collapse: `${pluginId}:collapse`,
  setIgnore: `${pluginId}:set-ignore`,
  layout: `${pluginId}:layout`,
  launch: `${pluginId}:launch`,
  openVnite: `${pluginId}:open-vnite`,
  hide: `${pluginId}:hide`,
  blur: `${pluginId}:blur`,
  forceCollapse: `${pluginId}:force-collapse`
};

const INVOKE_CHANNELS = ['bootstrap', 'games', 'expand', 'collapse', 'launch', 'openVnite', 'hide'];
const LISTEN_CHANNELS = ['dragStart', 'dragMove', 'dragEnd', 'setIgnore'];

const OPTION_DEFAULTS = Object.fromEntries(
  (configuration || []).map(option => [option.id, option.default])
);

const SIZES = new Set([64, 76, 88]);
const ACCENTS = new Set(['blue', 'violet', 'cyan']);

let dispose;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

async function activate(api) {
  if (dispose) return;
  await api.PluginDB.getValue('#all', {});

  const stateFile = path.join(app.getPath('userData'), 'plugins', pluginId, 'state.json');
  let orbSize = 76;
  let accent = 'blue';
  let sound = true;
  let expanded = false;
  let orbPoint = null;
  let anchorX = 'left';
  let anchorY = 'bottom';
  let drag = null;
  let win = null;

  function readPreferences() {
    return api.PluginDB.getValue('#all', {}).catch(() => ({}));
  }

  function applyOptions(preferences) {
    const size = Number.parseInt(preferences?.size, 10);
    orbSize = SIZES.has(size) ? size : Number.parseInt(OPTION_DEFAULTS.size, 10) || 76;
    accent = ACCENTS.has(preferences?.accent) ? preferences.accent : 'blue';
    sound = preferences?.sound ?? true;
  }

  function normalizePoint(point) {
    const area = screen.getDisplayNearestPoint(point).workArea;
    return {
      x: clamp(Math.round(point.x), area.x + EDGE, area.x + area.width - orbSize - EDGE),
      y: clamp(Math.round(point.y), area.y + EDGE, area.y + area.height - orbSize - EDGE)
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

  // 面板朝屏幕内侧展开：悬浮球在左半屏时面板放右侧，在上半屏时面板放下方。
  function updateAnchors() {
    const center = { x: orbPoint.x + orbSize / 2, y: orbPoint.y + orbSize / 2 };
    const area = screen.getDisplayNearestPoint(center).workArea;
    anchorX = center.x < area.x + area.width / 2 ? 'right' : 'left';
    anchorY = center.y < area.y + area.height / 2 ? 'top' : 'bottom';
  }

  // 悬浮球在窗口内的偏移由锚点决定，渲染层的 CSS 用同一套公式。
  function orbOffset() {
    return {
      x: anchorX === 'left' ? PAD + PANEL_W + GAP : PAD,
      y: anchorY === 'bottom' ? PAD + PANEL_H - orbSize : PAD
    };
  }

  function windowBounds() {
    const offset = orbOffset();
    return {
      x: Math.round(orbPoint.x - offset.x),
      y: Math.round(orbPoint.y - offset.y),
      width: PAD * 2 + PANEL_W + GAP + orbSize,
      height: PAD * 2 + PANEL_H
    };
  }

  function cursorOverOrb() {
    const bounds = win.getBounds();
    const offset = orbOffset();
    const point = screen.getCursorScreenPoint();
    return point.x >= bounds.x + offset.x - 4 &&
      point.x <= bounds.x + offset.x + orbSize + 4 &&
      point.y >= bounds.y + offset.y - 4 &&
      point.y <= bounds.y + offset.y + orbSize + 4;
  }

  function placeWindow({ persist = false } = {}) {
    if (!win || win.isDestroyed()) return;
    orbPoint = normalizePoint(orbPoint);
    updateAnchors();
    win.setBounds(windowBounds(), false);
    if (persist) savePoint();
  }

  function layoutPayload(extra) {
    return {
      pad: PAD,
      gap: GAP,
      panelWidth: PANEL_W,
      panelHeight: PANEL_H,
      orbSize,
      accent,
      side: anchorX,
      anchor: anchorY,
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
      api.GameDB.getAllGames().catch(() => ({}))
    ]);
    return projectGames(documents, settings ?? {});
  }

  function revealWindow() {
    if (!win || win.isDestroyed()) return;
    // 鼠标正好停在球上时保持可点击，其余情况让整个透明窗口穿透。
    win.setIgnoreMouseEvents(!cursorOverOrb(), { forward: true });
    win.showInactive();
  }

  function createWindow() {
    orbPoint = loadPoint();
    updateAnchors();
    win = new BrowserWindow({
      ...windowBounds(),
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
    win.once('ready-to-show', revealWindow);
    // ready-to-show 在个别透明窗口上不触发，did-finish-load 兜底显示。
    win.webContents.once('did-finish-load', () => {
      if (win && !win.isDestroyed() && !win.isVisible()) revealWindow();
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
      if (expanded) {
        expanded = false;
        send(CHANNELS.forceCollapse);
      }
      placeWindow({ persist: true });
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
    const offset = orbOffset();
    orbPoint = normalizePoint({ x: bounds.x + offset.x, y: bounds.y + offset.y });
    updateAnchors();
    // 先把新的锚点告诉渲染层，再移动窗口，避免两者不同帧导致的跳动。
    send(CHANNELS.layout, layoutPayload({ sound }));
    win.setBounds(windowBounds(), false);
    savePoint();
  });

  ipcMain.on(CHANNELS.setIgnore, (event, ignore) => {
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
    win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });

  ipcMain.handle(CHANNELS.expand, event => {
    checkSender(event);
    if (!win || win.isDestroyed()) return layoutPayload({});
    expanded = true;
    // 聚焦窗口，点击桌面其它位置时才能收到 blur 并自动收起。
    win.focus();
    return layoutPayload({});
  });

  ipcMain.handle(CHANNELS.collapse, event => {
    checkSender(event);
    expanded = false;
    return layoutPayload({});
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
    expanded = false;
    if (win && !win.isDestroyed()) {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.hide();
    }
    refreshTrayMenu();
    return true;
  });

  function toggleVisible() {
    const target = ensureWindow();
    if (target.isVisible()) {
      expanded = false;
      send(CHANNELS.forceCollapse);
      target.hide();
    } else {
      revealWindow();
    }
    refreshTrayMenu();
  }

  // ————— Vnite 托盘菜单入口 —————
  // 悬浮球隐藏后没有窗口可点，除了 Ctrl+Alt+P，还在 Vnite 托盘菜单里挂一项「显示/隐藏悬浮球」。
  // 托盘菜单由 Vnite 每次重建，这里钩住 Tray.setContextMenu 在菜单末尾插一项。
  let trayRetry = null;
  let trayRetries = 0;

  function trayLabel() {
    return win && !win.isDestroyed() && win.isVisible() ? '隐藏悬浮球' : '显示悬浮球';
  }

  function findTrayManager() {
    try {
      for (const mod of Object.values(require.cache)) {
        const manager = mod?.exports?.trayManager;
        if (manager && manager.tray) return manager;
      }
    } catch {
      /* 读取模块缓存失败时退化为等待 Vnite 自己重建菜单 */
    }
    return null;
  }

  function refreshTrayMenu() {
    const manager = findTrayManager();
    if (!manager || typeof manager.setTrayMenu !== 'function') return false;
    Promise.resolve(manager.setTrayMenu()).catch(() => {});
    return true;
  }

  function decorateTrayMenu(menu) {
    if (!menu || !Array.isArray(menu.items)) return;
    if (menu.items.some(item => item.id === TRAY_ITEM_ID)) return;
    const item = new MenuItem({
      id: TRAY_ITEM_ID,
      label: trayLabel(),
      // 延后一拍：避免在原生菜单点击回调里立刻重建托盘菜单
      click: () => setTimeout(toggleVisible, 0)
    });
    // 放在最后一条分隔线之前：设置 → 显示悬浮球 ── 退出
    let insertAt = menu.items.length;
    for (let index = menu.items.length - 1; index >= 0; index -= 1) {
      if (menu.items[index].type === 'separator') {
        insertAt = index;
        break;
      }
    }
    menu.insert(insertAt, item);
  }

  function installTrayEntry() {
    try {
      const proto = Tray.prototype;
      if (!proto.__psOrbSetContextMenu) {
        const original = proto.setContextMenu;
        proto.__psOrbSetContextMenu = original;
        proto.setContextMenu = function patchedSetContextMenu(menu) {
          try {
            decorateTrayMenu(menu);
          } catch (error) {
            console.warn('[PS 悬浮球] 注入托盘菜单失败', error);
          }
          return original.call(this, menu);
        };
      }
    } catch (error) {
      console.warn('[PS 悬浮球] 托盘菜单不可用', error);
      return;
    }
    // 托盘在插件启用前就已创建，主动重建一次让入口立刻出现。
    if (!refreshTrayMenu() && trayRetries < 3) {
      trayRetries += 1;
      trayRetry = setTimeout(installTrayEntry, trayRetries * 1500);
    }
  }

  function removeTrayEntry() {
    if (trayRetry) clearTimeout(trayRetry);
    trayRetry = null;
    try {
      const proto = Tray.prototype;
      const original = proto.__psOrbSetContextMenu;
      if (original) {
        delete proto.__psOrbSetContextMenu;
        proto.setContextMenu = original;
      }
    } catch {
      /* 忽略 */
    }
    refreshTrayMenu();
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
    placeWindow({ persist: true });
    if (expanded) send(CHANNELS.layout, layoutPayload({ sound }));
  };
  screen.on('display-metrics-changed', onDisplayChange);
  screen.on('display-removed', onDisplayChange);

  installTrayEntry();

  dispose = async () => {
    removeTrayEntry();
    screen.removeListener('display-metrics-changed', onDisplayChange);
    screen.removeListener('display-removed', onDisplayChange);
    globalShortcut.unregister('Control+Alt+P');
    INVOKE_CHANNELS.forEach(key => ipcMain.removeHandler(CHANNELS[key]));
    LISTEN_CHANNELS.forEach(key => ipcMain.removeAllListeners(CHANNELS[key]));
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
