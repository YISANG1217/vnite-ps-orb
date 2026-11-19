(() => {
  const api = window.psOrb;
  const bar = document.getElementById('bar');
  const originalEl = document.getElementById('original');
  const translatedEl = document.getElementById('translated');

  if (!api) return;

  let pendingHeight = 0;
  let baseFont = 22;
  let showOriginalEnabled = true;
  const PLACEHOLDER = '翻译中…';

  // 内容变化后把实际高度回传给主进程，字幕窗底边保持不动。
  function reportHeight() {
    const rect = bar.getBoundingClientRect();
    const height = Math.ceil(rect.height + 22);
    if (Math.abs(height - pendingHeight) < 2) return;
    pendingHeight = height;
    api.resizeSubtitle(height);
  }

  // 长句自动收一点字号，避免两三行译文把画面下半截整个盖住
  function fitFont(text) {
    const length = String(text || '').length;
    const scale = length > 52 ? 0.8 : length > 34 ? 0.9 : 1;
    translatedEl.style.fontSize = `${Math.round(baseFont * scale)}px`;
  }

  // 同一个角色固定同一个色相，多角色对话一眼分出谁在说话
  function speakerHue(name) {
    let hash = 0;
    for (const ch of name) hash = (hash * 31 + ch.codePointAt(0)) % 360;
    return hash;
  }

  // 上一句原文渐隐后保留 3 秒，方便对照上下文
  const ghostEl = document.createElement('p');
  ghostEl.className = 'original ghost';
  ghostEl.hidden = true;
  originalEl.before(ghostEl);
  let ghostTimer = 0;

  // 允许前面混进空格/全角空格：OCR 有时会把缩进一起带出来
  const NAME_RE = /^[\s\u3000]*【([^】]{1,10})】([\s\S]*)$/;

  // 把一段原文渲染进指定元素：说话人渲染成「首字圆形徽章 + 名字」的角色标签
  function fillOriginal(el, text) {
    el.textContent = '';
    const raw = String(text || '');
    if (!raw.trim()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const match = NAME_RE.exec(raw);
    if (!match) {
      el.textContent = raw;
      return;
    }
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.style.setProperty('--hue', String(speakerHue(match[1])));
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = [...match[1]][0];
    const label = document.createElement('span');
    label.className = 'speaker-name';
    label.textContent = match[1];
    speaker.append(avatar, label);
    el.append(speaker, document.createTextNode(match[2]));
  }

  function showGhost(text) {
    if (!showOriginalEnabled) return;
    fillOriginal(ghostEl, text);
    ghostEl.hidden = false;
    clearTimeout(ghostTimer);
    ghostTimer = setTimeout(() => {
      ghostEl.hidden = true;
      ghostEl.textContent = '';
      requestAnimationFrame(reportHeight);
    }, 3000);
  }

  function renderOriginal(text) {
    const raw = String(text || '');
    const prev = originalEl.dataset.text || '';
    if (prev && raw && raw !== prev) showGhost(prev);
    originalEl.dataset.text = raw;
    fillOriginal(originalEl, raw);
  }

  let hideTimer = 0;
  let shown = false;

  function showBar() {
    clearTimeout(hideTimer);
    if (bar.hidden) {
      bar.hidden = false;
      bar.classList.add('is-hidden');
      // 先让浏览器认下处于隐藏态的这一帧，下一帧再过渡出来
      void bar.offsetWidth;
    }
    if (!shown) {
      shown = true;
      requestAnimationFrame(() => bar.classList.remove('is-hidden'));
    }
  }

  // 先淡出再收起：窗口尺寸保持不变，避免每句都改一次透明窗口的交换链
  function hideBar() {
    if (!shown) {
      bar.hidden = true;
      ghostEl.hidden = true;
      ghostEl.textContent = '';
      return;
    }
    shown = false;
    bar.classList.add('is-hidden');
    clearTimeout(ghostTimer);
    ghostEl.hidden = true;
    ghostEl.textContent = '';
    originalEl.dataset.text = '';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (shown) return;
      bar.hidden = true;
    }, 180);
  }

  // 译文按标点切成小段错峰淡入：不是打字机，只是给长句一点阅读节奏
  function paintTranslated(text) {
    translatedEl.textContent = '';
    if (!text) return;
    if (text === PLACEHOLDER) {
      translatedEl.textContent = text;
      return;
    }
    const parts = String(text).match(/[^、。，！？…；：,.!?;:]+[、。，！？…；：,.!?;:]*/g) || [text];
    // 段数太多就合并，保证淡入总时长不超过 0.3 秒
    const step = Math.max(1, Math.ceil(parts.length / 5));
    let index = 0;
    for (let i = 0; i < parts.length; i += step) {
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.textContent = parts.slice(i, i + step).join('');
      seg.style.animationDelay = `${Math.min(280, index * 60)}ms`;
      translatedEl.append(seg);
      index += 1;
    }
  }

  function render({ original, translated }) {
    if (!original && !translated) {
      hideBar();
      return;
    }
    const next = translated || '';
    const changed = !shown || translatedEl.dataset.text !== next;
    showBar();
    renderOriginal(original || '');
    if (changed) {
      translatedEl.dataset.text = next;
      paintTranslated(next);
      translatedEl.classList.toggle('is-loading', next === PLACEHOLDER);
      fitFont(next);
    }
    // 同步量一次高度：窗口跟着内容长矮，底部贴边，字幕不会跳一下
    reportHeight();
  }

  function applyStyle({ fontSize, showOriginal }) {
    if (Number.isFinite(fontSize)) {
      baseFont = fontSize;
      document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
      fitFont(translatedEl.textContent);
    }
    showOriginalEnabled = showOriginal !== false;
    if (!showOriginalEnabled) {
      originalEl.hidden = true;
      ghostEl.hidden = true;
      ghostEl.textContent = '';
      clearTimeout(ghostTimer);
    }
    requestAnimationFrame(reportHeight);
  }

  api.onSubtitle(render);
  api.onSubtitleStyle(applyStyle);
  api.onAccent(hex => {
    if (!/^#[0-9a-f]{6}$/i.test(hex)) return;
    // 主题色跟着画面走；胶囊的色相是每个角色固定的，这里只改整体强调色
    document.documentElement.style.setProperty('--accent', hex);
  });

  // 首次加载时按当前 CSS 变量上报一次高度，避免字幕窗初始过高。
  requestAnimationFrame(() => {
    if (!bar.hidden) reportHeight();
  });
})();
