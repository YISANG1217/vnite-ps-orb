(() => {
  const api = window.psOrb;
  const sentenceEl = document.getElementById('sentence');
  const chunksEl = document.getElementById('chunks');
  const wordsEl = document.getElementById('words');
  const notesEl = document.getElementById('notes');
  const notesBlock = document.getElementById('notesBlock');
  const transBlock = document.getElementById('transBlock');
  const translationEl = document.getElementById('translation');

  if (!api) return;

  const MAX_WORDS = 28;
  const MAX_CHUNKS = 8;
  const MAX_NOTES = 4;

  function empty(text) {
    const item = document.createElement('li');
    item.className = 'empty';
    item.textContent = text;
    return item;
  }

  // 带振假名的原文
  function renderSentence(tokens) {
    sentenceEl.textContent = '';
    tokens.slice(0, 60).forEach(token => {
      if (!token.ruby) {
        sentenceEl.appendChild(document.createTextNode(token.surface));
        return;
      }
      const ruby = document.createElement('ruby');
      ruby.appendChild(document.createTextNode(token.surface));
      const rt = document.createElement('rt');
      rt.textContent = token.ruby;
      ruby.appendChild(rt);
      sentenceEl.appendChild(ruby);
    });
  }

  function renderChunks(chunks) {
    chunksEl.textContent = '';
    if (!chunks.length) {
      chunksEl.appendChild(empty('未识别到句节'));
      return;
    }
    chunks.slice(0, MAX_CHUNKS).forEach(chunk => {
      const item = document.createElement('li');
      item.className = 'chunk';
      const role = document.createElement('span');
      role.className = 'role';
      role.textContent = chunk.role;
      const text = document.createElement('span');
      text.textContent = chunk.text;
      item.append(role, text);
      chunksEl.appendChild(item);
    });
  }

  function renderWords(tokens) {
    wordsEl.textContent = '';
    const words = tokens.filter(token => token.pos !== '記号');
    if (!words.length) {
      wordsEl.appendChild(empty('未识别到单词'));
      return;
    }
    words.slice(0, MAX_WORDS).forEach(token => {
      const item = document.createElement('li');
      item.className = 'word';
      item.dataset.surface = token.surface || '';
      item.dataset.base = token.base || '';
      item.dataset.reading = token.reading || '';
      item.dataset.label = token.label || '';
      const surface = document.createElement('span');
      surface.className = 'surface';
      surface.textContent = token.surface;
      item.appendChild(surface);
      if (token.reading && token.reading !== token.surface) {
        const reading = document.createElement('span');
        reading.className = 'reading';
        reading.textContent = token.reading;
        item.appendChild(reading);
      }
      const pos = document.createElement('span');
      pos.className = 'pos';
      pos.textContent = token.label;
      item.appendChild(pos);
      wordsEl.appendChild(item);
    });
  }

  function render(payload) {
    if (bodyEl) bodyEl.scrollTop = 0;
    closeDetail();
    renderSentence(payload.tokens || []);
    renderChunks(payload.chunks || []);
    renderWords(payload.tokens || []);

    notesEl.textContent = '';
    const notes = (payload.notes || []).slice(0, MAX_NOTES);
    notesBlock.hidden = !notes.length;
    notes.forEach(note => {
      const item = document.createElement('li');
      item.textContent = note;
      notesEl.appendChild(item);
    });

    const translation = payload.translation || '';
    transBlock.hidden = !translation;
    translationEl.textContent = translation;
  }

  // ————— 拖动 / 缩放 —————
  // 整个面板按住就能拖；右下角折角用来缩放；内容区可以滚动
  const cardEl = document.querySelector('.card');
  const bodyEl = document.getElementById('body');
  const gripEl = document.getElementById('grip');

  let dragging = false;
  let resizing = null;

  function inside(el, x, y) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  function endDrag() {
    if (!dragging) return;
    dragging = false;
    cardEl?.classList.remove('is-dragging');
    api.studyDragEnd();
  }

  cardEl?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // 点单词 / 点详情卡不要触发拖动，否则会把点击吃掉
    if (event.target.closest('.word, .word-detail')) return;
    if (inside(gripEl, event.clientX, event.clientY)) {
      resizing = {
        x: event.screenX,
        y: event.screenY,
        width: window.innerWidth,
        height: window.innerHeight
      };
      cardEl.setPointerCapture(event.pointerId);
      return;
    }
    // 贴着内容区右边缘的那条是滚动条，不要当成拖动
    if (bodyEl) {
      const rect = bodyEl.getBoundingClientRect();
      if (event.clientX > rect.right - 14) return;
    }
    dragging = true;
    cardEl.classList.add('is-dragging');
    cardEl.setPointerCapture(event.pointerId);
    api.studyDragStart();
  });

  window.addEventListener('pointermove', event => {
    if (!resizing) return;
    api.studyResize({
      width: resizing.width + (event.screenX - resizing.x),
      height: resizing.height + (event.screenY - resizing.y)
    });
  });

  window.addEventListener('pointerup', () => {
    endDrag();
    resizing = null;
  });

  window.addEventListener('pointercancel', () => {
    endDrag();
    resizing = null;
  });

  // ————— 单词详情：点单词查释义 —————
  const detailEl = document.getElementById('detail');
  const detailWordEl = document.getElementById('detailWord');
  const detailReadingEl = document.getElementById('detailReading');
  const detailPosEl = document.getElementById('detailPos');
  const detailMeaningEl = document.getElementById('detailMeaning');
  let detailKey = '';

  function closeDetail() {
    if (!detailEl) return;
    detailEl.hidden = true;
    detailKey = '';
  }

  wordsEl.addEventListener('click', async event => {
    const item = event.target.closest('.word');
    if (!item) return;
    const data = item.dataset;
    const key = `${data.surface}|${data.reading}|${data.base}`;
    if (detailKey === key && !detailEl.hidden) {
      closeDetail();
      return;
    }
    detailKey = key;
    detailEl.hidden = false;
    detailWordEl.textContent = data.surface;
    const extra = [
      data.reading,
      data.base && data.base !== data.surface ? `原形 ${data.base}` : ''
    ].filter(Boolean).join(' · ');
    detailReadingEl.textContent = extra;
    detailReadingEl.hidden = !extra;
    detailPosEl.textContent = data.label || '';
    detailPosEl.hidden = !data.label;
    detailMeaningEl.textContent = '查询中…';
    detailMeaningEl.classList.add('is-loading');
    const result = await api
      .lookupWord({
        surface: data.surface,
        base: data.base,
        reading: data.reading,
        pos: data.label
      })
      .catch(() => null);
    if (detailKey !== key) return;
    detailMeaningEl.classList.remove('is-loading');
    detailMeaningEl.textContent = result?.meaning || '未查到释义';
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  });

  document.getElementById('detailClose')?.addEventListener('click', closeDetail);

  api.onStudy(render);
})();
