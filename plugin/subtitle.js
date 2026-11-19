(() => {
  const api = window.psOrb;
  const bar = document.getElementById('bar');
  const originalEl = document.getElementById('original');
  const translatedEl = document.getElementById('translated');

  if (!api) return;

  let pendingHeight = 0;
  let baseFont = 22;
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

  // 说话人标签【武】单独着色，和台词正文区分开
  function renderOriginal(text) {
    originalEl.textContent = '';
    const raw = String(text || '');
    if (!raw.trim()) {
      originalEl.hidden = true;
      return;
    }
    originalEl.hidden = false;
    // 允许前面混进空格/全角空格：OCR 有时会把缩进一起带出来
    const match = /^[\s\u3000]*【([^】]{1,10})】([\s\S]*)$/.exec(raw);
    if (!match) {
      originalEl.textContent = raw;
      return;
    }
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = match[1];
    speaker.style.setProperty('--hue', String(speakerHue(match[1])));
    originalEl.append(speaker, document.createTextNode(match[2]));
  }

  // 同一个动画要在连续换句时重播，先摘掉类再强制回流一次
  function replay(node) {
    node.classList.remove('is-fresh');
    void node.offsetWidth;
    node.classList.add('is-fresh');
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
      return;
    }
    shown = false;
    bar.classList.add('is-hidden');
    bar.classList.remove('is-fresh');
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (shown) return;
      bar.hidden = true;
    }, 180);
  }

  function render({ original, translated }) {
    if (!original && !translated) {
      hideBar();
      return;
    }
    const next = translated || '';
    const changed = !shown || translatedEl.textContent !== next;
    showBar();
    renderOriginal(original || '');
    translatedEl.textContent = next;
    translatedEl.classList.toggle('is-loading', next === PLACEHOLDER);
    fitFont(next);
    if (changed) replay(translatedEl);
    // 同步量一次高度：窗口跟着内容长矮，底部贴边，字幕不会跳一下
    reportHeight();
  }

  function applyStyle({ fontSize, showOriginal }) {
    if (Number.isFinite(fontSize)) {
      baseFont = fontSize;
      document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
      fitFont(translatedEl.textContent);
    }
    if (!showOriginal) {
      originalEl.hidden = true;
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
