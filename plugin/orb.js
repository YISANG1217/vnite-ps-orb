(() => {
  const demoMode = !window.psOrb && /^https?:$/.test(window.location.protocol);
  if (!window.psOrb && !demoMode) {
    document.body.innerHTML = '<p class="fatal">悬浮球需要在 Vnite 中运行</p>';
    return;
  }
  const api = window.psOrb || createDemoApi();
  const root = document.getElementById('app');
  const orb = root.querySelector('.orb');
  const panel = root.querySelector('.panel');
  const panelClose = root.querySelector('.panel-close');
  const statusEl = root.querySelector('.panel-status');
  const statusText = root.querySelector('.panel-status-text');
  const hero = root.querySelector('.hero');
  const heroArt = root.querySelector('.hero-art');
  const heroCover = root.querySelector('.hero-cover');
  const heroFallback = root.querySelector('.hero-fallback');
  const heroTitle = root.querySelector('.hero-title');
  const heroMeta = root.querySelector('.hero-meta');
  const heroPlay = root.querySelector('.hero-play');
  const emptyEl = root.querySelector('.panel-empty');
  const listHead = root.querySelector('.list-head');
  const listEl = root.querySelector('.list');
  const launchLayer = root.querySelector('.launch');
  const settingsEl = root.querySelector('.settings');
  const openButton = root.querySelector('[data-act="open"]');
  const hideButton = root.querySelector('[data-act="hide"]');

  const state = {
    expanded: false,
    closing: false,
    launching: false,
    dragging: false,
    size: 64,
    pad: 26,
    gap: 16,
    panelW: 344,
    panelH: 452,
    sound: true,
    translate: false,
    study: false,
    fontSize: 22,
    hero: null,
    games: []
  };

  // ————— 音效 —————
  let ctx = null;
  let master = null;

  function ensureAudio() {
    if (!state.sound) return null;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    if (!ctx) {
      ctx = new AudioCtor();
      master = ctx.createGain();
      master.gain.value = 0.5;
      master.connect(ctx.destination);
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }

  function tone({ freq, end, type = 'sine', dur = 0.12, gain = 0.1, delay = 0 }) {
    if (!ctx || !master) return;
    const start = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const amp = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (end) osc.frequency.exponentialRampToValueAtTime(Math.max(20, end), start + dur);
    amp.gain.setValueAtTime(0.0002, start);
    amp.gain.exponentialRampToValueAtTime(gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0002, start + dur);
    osc.connect(amp).connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.03);
  }

  function play(name) {
    if (!state.sound) return;
    if (!ensureAudio()) return;
    if (name === 'tap') {
      tone({ freq: 1174.66, end: 1567.98, type: 'triangle', dur: 0.05, gain: 0.12 });
    } else if (name === 'open') {
      tone({ freq: 392, end: 880, type: 'sine', dur: 0.17, gain: 0.08 });
    } else if (name === 'close') {
      tone({ freq: 784, end: 330, type: 'sine', dur: 0.14, gain: 0.07 });
    } else if (name === 'launch') {
      [587.33, 880, 1174.66].forEach((freq, index) => {
        tone({ freq, type: 'triangle', dur: 0.7 - index * 0.1, gain: 0.06, delay: index * 0.09 });
      });
    } else if (name === 'error') {
      tone({ freq: 207.65, type: 'square', dur: 0.12, gain: 0.1 });
    }
  }

  // ————— 布局 —————
  function applyLayout(payload) {
    if (!payload) return;
    if (Number(payload.pad)) state.pad = Number(payload.pad);
    if (Number(payload.gap)) state.gap = Number(payload.gap);
    if (Number(payload.orbSize)) state.size = Number(payload.orbSize);
    if (Number(payload.panelWidth)) state.panelW = Number(payload.panelWidth);
    if (Number(payload.panelHeight)) state.panelH = Number(payload.panelHeight);
    root.style.setProperty('--pad', `${state.pad}px`);
    root.style.setProperty('--gap', `${state.gap}px`);
    root.style.setProperty('--orb-size', `${state.size}px`);
    root.style.setProperty('--panel-w', `${state.panelW}px`);
    root.style.setProperty('--panel-h', `${state.panelH}px`);
    if (payload.accent) root.dataset.accent = payload.accent;
    if (payload.side) root.dataset.side = payload.side;
    if (payload.anchor) root.dataset.anchor = payload.anchor;
    if (typeof payload.sound === 'boolean') state.sound = payload.sound;
    if (typeof payload.translateEnabled === 'boolean') state.translate = payload.translateEnabled;
    if (typeof payload.studyEnabled === 'boolean') state.study = payload.studyEnabled;
    if (Number(payload.translateFontSize)) state.fontSize = Number(payload.translateFontSize);
    syncTranslateToggle();
  }

  // 透明窗口固定为展开尺寸，只有悬浮球与面板区域接收鼠标，其余区域穿透到桌面。
  let ignoring = null;
  const pointer = { x: -1, y: -1 };

  function setIgnore(next) {
    if (ignoring === next) return;
    ignoring = next;
    api.setIgnore(next);
  }

  function inside(el, x, y, grow = 0) {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return false;
    return x >= rect.left - grow && x <= rect.right + grow && y >= rect.top - grow && y <= rect.bottom + grow;
  }

  function interactiveAt(x, y) {
    if (inside(orb, x, y, 4)) return true;
    return !panel.hidden && inside(panel, x, y);
  }

  function syncIgnore() {
    if (state.dragging || press) return;
    if (pointer.x < 0) {
      setIgnore(true);
      return;
    }
    setIgnore(!interactiveAt(pointer.x, pointer.y));
  }

  let ignoreFrame = 0;

  window.addEventListener('mousemove', event => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    if (ignoreFrame) return;
    ignoreFrame = window.requestAnimationFrame(() => {
      ignoreFrame = 0;
      syncIgnore();
    });
  });

  window.addEventListener('mouseleave', () => {
    pointer.x = -1;
    pointer.y = -1;
    syncIgnore();
  });

  // ————— 数据 —————
  function relative(iso) {
    const time = Date.parse(iso);
    if (!time) return '尚未游玩';
    const diff = Date.now() - time;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 172_800_000) return '昨天';
    if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const date = new Date(time);
    return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
  }

  function coverUrl(game) {
    if (!game?.id || String(game.id).startsWith('demo-')) return '';
    return `attachment://game/${encodeURIComponent(game.id)}/images/cover.webp`;
  }

  function hueOf(id) {
    let hue = 0;
    for (const char of String(id)) hue = (hue * 31 + char.charCodeAt(0)) % 360;
    return hue;
  }

  function firstChar(name) {
    return (String(name || 'PS').trim().slice(0, 1) || 'P').toUpperCase();
  }

  function setStatus(text, tone) {
    statusText.textContent = text;
    statusEl.classList.toggle('is-warn', tone === 'warn');
    statusEl.classList.toggle('is-error', tone === 'error');
  }

  function loadCover(image, fallback, game) {
    const url = coverUrl(game);
    fallback.textContent = firstChar(game.name);
    fallback.hidden = false;
    image.hidden = !url;
    if (!url) {
      image.removeAttribute('src');
      return;
    }
    image.onload = () => {
      image.hidden = false;
      fallback.hidden = true;
    };
    image.onerror = () => {
      image.hidden = true;
      fallback.hidden = false;
    };
    image.src = url;
    if (image.complete && image.naturalWidth) {
      image.hidden = false;
      fallback.hidden = true;
    }
  }

  function fillHero(game) {
    heroTitle.textContent = game.name;
    heroMeta.textContent = `上次游玩 · ${relative(game.lastRunDate)}`;
    hero.classList.toggle('is-blur', Boolean(game.blurCover));
    heroArt.style.background = `linear-gradient(158deg, hsl(${hueOf(game.id)} 34% 25%), #0a1322)`;
    loadCover(heroCover, heroFallback, game);
  }

  function createRow(game) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `list-row${game.blurCover ? ' is-blur' : ''}`;

    const cover = document.createElement('span');
    cover.className = 'list-cover';
    cover.style.background = `linear-gradient(158deg, hsl(${hueOf(game.id)} 34% 25%), #0a1322)`;
    const image = document.createElement('img');
    image.alt = '';
    image.draggable = false;
    const fallback = document.createElement('span');
    fallback.className = 'list-fallback';
    cover.append(image, fallback);
    loadCover(image, fallback, game);

    const info = document.createElement('span');
    info.className = 'list-info';
    const name = document.createElement('span');
    name.className = 'list-name';
    name.textContent = game.name;
    const meta = document.createElement('span');
    meta.className = 'list-meta';
    meta.textContent = `上次游玩 · ${relative(game.lastRunDate)}`;
    info.append(name, meta);

    const go = document.createElement('span');
    go.className = 'list-go';
    go.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.4v9.2L12.5 8z" fill="currentColor"/></svg>';

    button.append(cover, info, go);
    button.addEventListener('click', () => launch(game));
    item.append(button);
    return item;
  }

  function render({ games = [], total = 0 } = {}) {
    state.games = games;
    state.hero = games[0] || null;
    setStatus(`已连接 Vnite · ${total} 款游戏`);
    hero.hidden = games.length === 0;
    emptyEl.hidden = games.length > 0;
    listHead.hidden = games.length <= 1;
    listEl.hidden = games.length <= 1;
    listEl.textContent = '';
    games.slice(1, 4).forEach(game => listEl.append(createRow(game)));
    if (state.hero) fillHero(state.hero);
    heroPlay.disabled = !state.hero;
  }

  async function refresh() {
    try {
      const data = await api.games();
      applyLayout(data);
      render(data);
    } catch (error) {
      setStatus('读取游戏库失败', 'error');
    }
  }

  // ————— 展开 / 收起 —————
  async function expand() {
    if (state.expanded || state.closing) return;
    state.expanded = true;
    play('open');
    try {
      applyLayout(await api.expand());
    } catch (error) {
      setStatus('无法展开菜单', 'error');
    }
    panel.hidden = false;
    window.requestAnimationFrame(() => panel.classList.add('is-open'));
    syncIgnore();
    await refresh();
  }

  function collapse({ silent = false } = {}) {
    if (!state.expanded || state.closing) return;
    state.closing = true;
    state.launching = false;
    if (!silent) play('close');
    panel.classList.remove('is-open');
    state.expanded = false;
    Promise.resolve(api.collapse()).then(applyLayout).catch(() => {});
    window.setTimeout(() => {
      panel.hidden = true;
      panel.dataset.view = 'games';
      launchLayer.hidden = true;
      state.closing = false;
      syncIgnore();
    }, 180);
  }

  function hardCollapse() {
    state.expanded = false;
    state.closing = false;
    state.launching = false;
    panel.classList.remove('is-open');
    panel.hidden = true;
    panel.dataset.view = 'games';
    launchLayer.hidden = true;
    syncIgnore();
  }

  // ————— 设置视图 —————
  function showView(view) {
    panel.dataset.view = view;
    if (view === 'settings') syncSettings();
  }

  function syncSettings() {
    settingsEl.querySelectorAll('[data-key="size"] button').forEach(button => {
      button.classList.toggle('is-on', Number(button.dataset.value) === state.size);
    });
    settingsEl.querySelectorAll('[data-key="accent"] button').forEach(button => {
      button.classList.toggle('is-on', button.dataset.value === root.dataset.accent);
    });
    const soundSwitch = settingsEl.querySelector('[data-key="sound"]');
    soundSwitch.classList.toggle('is-on', state.sound);
    soundSwitch.setAttribute('aria-checked', String(state.sound));
    settingsEl.querySelectorAll('[data-key="fontSize"] button').forEach(button => {
      button.classList.toggle('is-on', Number(button.dataset.value) === state.fontSize);
    });
    syncTranslateToggle();
  }

  function syncTranslateToggle() {
    const pairs = [
      ['translate', state.translate],
      ['study', state.study]
    ];
    pairs.forEach(([key, value]) => {
      root.querySelectorAll(`[data-key="${key}"]`).forEach(toggle => {
        toggle.classList.toggle('is-on', value);
        toggle.setAttribute('aria-checked', String(value));
      });
    });
  }

  async function setOption(key, value) {
    try {
      const payload = await api.setOption(key, value);
      if (payload) applyLayout(payload);
    } catch (error) {
      setStatus('设置保存失败', 'error');
    }
    syncSettings();
  }

  async function openSettings() {
    if (!state.expanded) await expand();
    showView('settings');
  }

  settingsEl.addEventListener('click', event => {
    if (event.target.closest('.settings-back')) {
      play('back');
      showView('games');
      return;
    }
    const sizeButton = event.target.closest('[data-key="size"] button');
    if (sizeButton) {
      const size = Number(sizeButton.dataset.value);
      if (size !== state.size) {
        play('tap');
        setOption('size', size);
      }
      return;
    }
    const accentButton = event.target.closest('[data-key="accent"] button');
    if (accentButton) {
      play('tap');
      setOption('accent', accentButton.dataset.value);
      return;
    }
    if (event.target.closest('[data-key="sound"]')) {
      const next = !state.sound;
      if (next) {
        state.sound = true;
        play('tap');
      }
      setOption('sound', next);
      return;
    }
    const fontButton = event.target.closest('[data-key="fontSize"] button');
    if (fontButton) {
      const size = Number(fontButton.dataset.value);
      if (size !== state.fontSize) {
        play('tap');
        setOption('translateFontSize', size);
      }
    }
  });

  // 面板底部的实时翻译开关与框选入口
  panel.addEventListener('click', event => {
    if (event.target.closest('[data-key="translate"]')) {
      const next = !state.translate;
      if (next) play('tap');
      setOption('translateEnabled', next);
      return;
    }
    if (event.target.closest('[data-key="study"]')) {
      const next = !state.study;
      if (next) play('tap');
      setOption('translateStudy', next);
      return;
    }
    if (event.target.closest('[data-act="region"]')) {
      play('tap');
      api.openTranslateRegion();
    }
  });

  // ————— 操作 —————
  async function launch(game) {
    if (!game || state.launching) return;
    state.launching = true;
    play('launch');
    launchLayer.hidden = false;
    try {
      const result = await api.launch(game.id);
      if (!result?.ok) {
        state.launching = false;
        launchLayer.hidden = true;
        setStatus(result?.reason === 'vnite-window' ? '未找到 Vnite 窗口' : '启动失败', 'error');
        play('error');
        return;
      }
      window.setTimeout(() => {
        launchLayer.hidden = true;
        collapse({ silent: true });
      }, 460);
    } catch (error) {
      state.launching = false;
      launchLayer.hidden = true;
      setStatus('启动失败', 'error');
    }
  }

  async function openVnite() {
    try {
      const ok = await api.openVnite();
      if (ok) collapse({ silent: true });
      else {
        setStatus('未找到 Vnite 窗口', 'error');
        play('error');
      }
    } catch (error) {
      setStatus('无法打开 Vnite', 'error');
    }
  }

  async function hideOrb() {
    play('close');
    hardCollapse();
    try {
      await api.hide();
    } catch (error) {
      /* 忽略 */
    }
  }

  // ————— 悬浮球拖动与点击 —————
  let press = null;
  let moveFrame = 0;

  function flushDrag() {
    moveFrame = 0;
    api.dragMove();
  }

  orb.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    orb.setPointerCapture(event.pointerId);
    press = { x: event.clientX, y: event.clientY, moved: false, pointerId: event.pointerId };
    orb.classList.add('is-press');
  });

  orb.addEventListener('pointermove', event => {
    if (!press) return;
    if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 4) {
      press.moved = true;
      state.dragging = true;
      orb.classList.add('is-dragging');
      api.dragStart();
    }
    if (state.dragging && !moveFrame) moveFrame = window.requestAnimationFrame(flushDrag);
  });

  function endPress(event) {
    if (!press) return;
    const moved = press.moved;
    const dragged = state.dragging;
    press = null;
    state.dragging = false;
    if (moveFrame) {
      window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    orb.classList.remove('is-press', 'is-dragging');
    if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
    if (dragged) {
      api.dragEnd();
      // 松手时指针就在球上，保持在可点击状态，等下一次移动再重新判定。
      setIgnore(false);
      return;
    }
    if (moved) return;
    play('tap');
    if (state.expanded) collapse();
    else expand();
  }

  orb.addEventListener('pointerup', endPress);
  orb.addEventListener('pointercancel', event => {
    if (!press) return;
    const dragged = state.dragging;
    press = null;
    state.dragging = false;
    orb.classList.remove('is-press', 'is-dragging');
    if (event.pointerId !== undefined && orb.hasPointerCapture(event.pointerId)) {
      orb.releasePointerCapture(event.pointerId);
    }
    if (dragged) api.dragEnd();
  });
  orb.addEventListener('contextmenu', event => {
    event.preventDefault();
    api.contextMenu();
  });
  orb.addEventListener('keydown', event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (state.expanded) collapse();
    else expand();
  });

  panelClose.addEventListener('click', () => collapse());
  hero.addEventListener('click', () => launch(state.hero));
  hero.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      launch(state.hero);
    }
  });
  hero.tabIndex = 0;
  hero.setAttribute('role', 'button');
  openButton.addEventListener('click', openVnite);
  hideButton.addEventListener('click', hideOrb);

  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && state.expanded) collapse();
  });

  api.onLayout(payload => applyLayout(payload));
  api.onBlur(() => collapse({ silent: true }));
  api.onForceCollapse(() => hardCollapse());
  api.onForceExpand(() => {
    if (!state.expanded) expand();
  });
  api.onOpenSettings(() => {
    openSettings();
  });

  async function init() {
    try {
      const data = await api.bootstrap();
      state.sound = data.sound !== false;
      applyLayout(data);
      render(data);
      setIgnore(true);
      if (window.__PS_ORB_DEMO__) {
        await new Promise(resolve => window.setTimeout(resolve, 320));
        await expand();
      }
    } catch (error) {
      setStatus('悬浮球加载失败', 'error');
    }
  }

  init();

  // ————— 浏览器预览用的假数据 —————
  function createDemoApi() {
    window.__PS_ORB_DEMO__ = true;
    const now = Date.now();
    const games = [
      { id: 'demo-1', name: '家族计划', lastRunDate: new Date(now - 2 * 3600e3).toISOString(), blurCover: false },
      { id: 'demo-2', name: 'CROSS†CHANNEL', lastRunDate: new Date(now - 26 * 3600e3).toISOString(), blurCover: false },
      { id: 'demo-3', name: '空の向こう側', lastRunDate: new Date(now - 3 * 86400e3).toISOString(), blurCover: false },
      { id: 'demo-4', name: '夏空のペルセウス', lastRunDate: new Date(now - 9 * 86400e3).toISOString(), blurCover: false }
    ];
    const base = {
      games,
      total: 27,
      orbSize: 64,
      pad: 26,
      gap: 16,
      panelWidth: 344,
      panelHeight: 452,
      accent: 'blue',
      side: 'left',
      anchor: 'bottom',
      sound: false,
      translateEnabled: false,
      translateFontSize: 22
    };
    return {
      bootstrap: async () => base,
      games: async () => base,
      expand: async () => base,
      collapse: async () => base,
      dragStart: () => {},
      dragMove: () => {},
      dragEnd: () => {},
      setIgnore: () => {},
      contextMenu: () => {},
      launch: async () => ({ ok: true }),
      openVnite: async () => true,
      hide: async () => true,
      openTranslateRegion: async () => true,
      setOption: async (key, value) => ({ ...base, [key === 'size' ? 'orbSize' : key]: value }),
      onLayout: () => {},
      onBlur: () => {},
      onForceCollapse: () => {},
      onForceExpand: () => {},
      onOpenSettings: () => {}
    };
  }
})();
