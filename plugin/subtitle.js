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

  // 说话人标签【武】单独着色，和台词正文区分开
  function renderOriginal(text) {
    originalEl.textContent = '';
    if (!text) {
      originalEl.hidden = true;
      return;
    }
    originalEl.hidden = false;
    const match = /^【([^】]{1,10})】([\s\S]*)$/.exec(text);
    if (!match) {
      originalEl.textContent = text;
      return;
    }
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.textContent = `【${match[1]}】`;
    originalEl.append(speaker, document.createTextNode(match[2]));
  }

  // 同一个动画要在连续换句时重播，先摘掉类再强制回流一次
  function replay(node) {
    node.classList.remove('is-fresh');
    void node.offsetWidth;
    node.classList.add('is-fresh');
  }

  function render({ original, translated }) {
    if (!original && !translated) {
      bar.hidden = true;
      reportHeight();
      return;
    }
    const next = translated || '';
    const changed = bar.hidden || translatedEl.textContent !== next;
    bar.hidden = false;
    renderOriginal(original || '');
    translatedEl.textContent = next;
    translatedEl.classList.toggle('is-loading', next === PLACEHOLDER);
    fitFont(next);
    if (changed) replay(translatedEl);
    requestAnimationFrame(reportHeight);
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

  // 首次加载时按当前 CSS 变量上报一次高度，避免字幕窗初始过高。
  requestAnimationFrame(() => {
    if (!bar.hidden) reportHeight();
  });
})();
