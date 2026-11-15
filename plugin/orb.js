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
  const openButton = root.querySelector('[data-act="open"]');
  const hideButton = root.querySelector('[data-act="hide"]');

  const state = {
    expanded: false,
    closing: false,
    launching: false,
    dragging: false,
    size: 96,
    pad: 14,
    panelW: 344,
    panelH: 452,
    sound: true,
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
    if (Number(payload.orbSize)) state.size = Number(payload.orbSize);
    if (Number(payload.panelWidth)) state.panelW = Number(payload.panelWidth);
    if (Number(payload.panelHeight)) state.panelH = Number(payload.panelHeight);
    root.style.setProperty('--pad', `${state.pad}px`);
    root.style.setProperty('--orb-size', `${state.size}px`);
    root.style.setProperty('--panel-w', `${state.panelW}px`);
    root.style.setProperty('--panel-h', `${state.panelH}px`);
    if (payload.accent) root.dataset.accent = payload.accent;
    if (payload.side) root.dataset.side = payload.side;
    if (payload.vertical) root.dataset.vertical = payload.vertical;
  }

  function placeOrb({ open, width, height } = {}) {
    const w = width || window.innerWidth;
    const h = height || window.innerHeight;
    const { pad, size, panelW, panelH } = state;
    if (!open) {
      orb.style.left = `${pad}px`;
      orb.style.top = `${pad}px`;
      return;
    }
    orb.style.left = `${root.dataset.side === 'left' ? w - pad - size : pad}px`;
    orb.style.top = `${root.dataset.vertical === 'above' ? h - pad - size : pad}px`;
    panel.style.left = `${root.dataset.side === 'left' ? pad : w - pad - panelW}px`;
    panel.style.top = `${root.dataset.vertical === 'above' ? pad : h - pad - panelH}px`;
  }

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
    play('open');
    let layout;
    try {
      layout = await api.expand();
    } catch (error) {
      setStatus('无法展开菜单', 'error');
      return;
    }
    applyLayout(layout);
    state.expanded = true;
    placeOrb({ open: true, width: layout?.width, height: layout?.height });
    panel.hidden = false;
    window.requestAnimationFrame(() => panel.classList.add('is-open'));
    await refresh();
  }

  async function collapse({ silent = false } = {}) {
    if (!state.expanded || state.closing) return;
    state.closing = true;
    state.launching = false;
    if (!silent) play('close');
    panel.classList.remove('is-open');
    state.expanded = false;
    window.setTimeout(async () => {
      panel.hidden = true;
      launchLayer.hidden = true;
      let layout = null;
      try {
        layout = await api.collapse();
      } catch (error) {
        /* 窗口可能已经隐藏 */
      }
      applyLayout(layout);
      placeOrb({ open: false, width: layout?.width, height: layout?.height });
      state.closing = false;
    }, 170);
  }

  function hardCollapse() {
    state.expanded = false;
    state.closing = false;
    state.launching = false;
    panel.classList.remove('is-open');
    panel.hidden = true;
    launchLayer.hidden = true;
    placeOrb({ open: false });
  }

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
    if (event.button !== 0 || state.expanded) return;
    event.preventDefault();
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
    if (press.moved && !moveFrame) moveFrame = window.requestAnimationFrame(flushDrag);
  });

  function endPress(event) {
    if (!press) return;
    const moved = press.moved;
    press = null;
    state.dragging = false;
    if (moveFrame) {
      window.cancelAnimationFrame(moveFrame);
      moveFrame = 0;
    }
    orb.classList.remove('is-press', 'is-dragging');
    if (orb.hasPointerCapture(event.pointerId)) orb.releasePointerCapture(event.pointerId);
    if (moved) {
      api.dragEnd();
      return;
    }
    play('tap');
    if (state.expanded) collapse();
    else expand();
  }

  orb.addEventListener('pointerup', endPress);
  orb.addEventListener('pointercancel', event => {
    if (!press) return;
    press = null;
    orb.classList.remove('is-press', 'is-dragging');
    if (event.pointerId !== undefined && orb.hasPointerCapture(event.pointerId)) {
      orb.releasePointerCapture(event.pointerId);
    }
    api.dragEnd();
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

  window.addEventListener('resize', () => placeOrb({ open: state.expanded }));
  api.onBlur(() => collapse({ silent: true }));
  api.onForceCollapse(() => hardCollapse());

  async function init() {
    try {
      const data = await api.bootstrap();
      state.sound = data.sound !== false;
      applyLayout(data);
      render(data);
      placeOrb({ open: false });
      if (window.__PS_ORB_DEMO__) {
        await new Promise(resolve => window.setTimeout(resolve, 280));
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
      orbSize: 96,
      pad: 26,
      panelWidth: 344,
      panelHeight: 452,
      accent: 'blue',
      sound: false
    };
    return {
      bootstrap: async () => ({ ...base, width: 148, height: 148 }),
      games: async () => base,
      expand: async () => ({ ...base, width: 508, height: 504, side: 'left', vertical: 'above' }),
      collapse: async () => ({ ...base, width: 148, height: 148 }),
      dragStart: () => {},
      dragMove: () => {},
      dragEnd: () => {},
      launch: async () => ({ ok: true }),
      openVnite: async () => true,
      hide: async () => true,
      onBlur: () => {},
      onForceCollapse: () => {}
    };
  }
})();
