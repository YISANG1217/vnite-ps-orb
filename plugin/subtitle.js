(() => {
  const api = window.psOrb;
  const bar = document.getElementById('bar');
  const originalEl = document.getElementById('original');
  const translatedEl = document.getElementById('translated');

  if (!api) return;

  let pendingHeight = 0;

  // 内容变化后把实际高度回传给主进程，字幕窗底边保持不动。
  function reportHeight() {
    const rect = bar.getBoundingClientRect();
    const height = Math.ceil(rect.height + 22);
    if (Math.abs(height - pendingHeight) < 2) return;
    pendingHeight = height;
    api.resizeSubtitle(height);
  }

  function render({ original, translated }) {
    if (!original && !translated) {
      bar.hidden = true;
      reportHeight();
      return;
    }
    bar.hidden = false;
    originalEl.textContent = original || '';
    originalEl.hidden = !original;
    translatedEl.textContent = translated || '';
    requestAnimationFrame(reportHeight);
  }

  function applyStyle({ fontSize, showOriginal }) {
    if (Number.isFinite(fontSize)) {
      document.documentElement.style.setProperty('--font-size', `${fontSize}px`);
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
