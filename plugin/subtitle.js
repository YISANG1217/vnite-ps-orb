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

  // 人名标签：兼容【】〔〕［］，以及 OCR 把 】 认成台词引号 」』 的情况
  const NAME_RE = /^[【〔［]([^】〕］」』]{1,10})[】〕］」』]([\s\S]*)$/;
  // OCR 也常把开头的【认成「：只有后面还紧跟一个「台词引号时才敢当成名字标签，
  // 否则正常的「这是台词」会被误当成人名
  const QUOTE_NAME_RE = /^[「『]([^】〕］」』]{1,4})[】〕］」』]([「『][\s\S]*)$/;
  // 名字里必须至少有一个假名或汉字，避免把符号当成角色
  const NAME_OK = /[\u3040-\u30ff\u4e00-\u9fff々〆ヵヶ]/;

  // 拆出「说话人 + 台词」。允许【】前面混进 0~2 个杂字符（OCR 偶尔多认一个标点），
  // 但只在杂字符不是英文数字时才认，免得把正文里的 [注] 之类误当人名。
  function splitSpeaker(raw) {
    const head = String(raw || '').replace(/^[\s\u3000\u200b\ufeff]+/, '');
    const direct = NAME_RE.exec(head);
    if (direct && NAME_OK.test(direct[1])) {
      return { name: direct[1].trim(), rest: direct[2] };
    }
    const quoted = QUOTE_NAME_RE.exec(head);
    if (quoted && NAME_OK.test(quoted[1])) {
      return { name: quoted[1].trim(), rest: quoted[2] };
    }
    const loose = /^([\s\S]{1,2}?)[【〔［]([^】〕］」』]{1,10})[】〕］」』]([\s\S]*)$/.exec(head);
    if (loose && !/[A-Za-z0-9]/.test(loose[1]) && NAME_OK.test(loose[2])) {
      return { name: loose[2].trim(), rest: loose[3] };
    }
    return null;
  }

  // 把一段原文渲染进指定元素：说话人渲染成「首字圆形徽章 + 名字」的角色标签
  function fillOriginal(el, text) {
    el.textContent = '';
    const raw = String(text || '');
    if (!raw.trim()) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    const parts = splitSpeaker(raw);
    if (!parts) {
      el.textContent = raw;
      return;
    }
    const speaker = document.createElement('span');
    speaker.className = 'speaker';
    speaker.style.setProperty('--hue', String(speakerHue(parts.name)));
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = [...parts.name][0];
    const label = document.createElement('span');
    label.className = 'speaker-name';
    label.textContent = parts.name;
    speaker.append(avatar, label);
    el.append(speaker, document.createTextNode(parts.rest));
  }

  function renderOriginal(text) {
    fillOriginal(originalEl, text);
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
    const changed = !shown || translatedEl.dataset.text !== next;
    showBar();
    renderOriginal(original || '');
    if (changed) {
      translatedEl.dataset.text = next;
      translatedEl.textContent = next;
      translatedEl.classList.toggle('is-loading', next === PLACEHOLDER);
      fitFont(next);
      replay(translatedEl);
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
