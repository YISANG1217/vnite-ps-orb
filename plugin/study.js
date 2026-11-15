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

  // ————— 拖动 / 缩放 / 鼠标穿透 —————
  // 面板正文保持穿透给游戏，只有标题栏和右下角手柄接收鼠标
  const headEl = document.getElementById('head');
  const gripEl = document.getElementById('grip');

  let ignoreState = null;
  let dragging = false;
  let resizing = null;

  function setIgnore(next) {
    if (ignoreState === next) return;
    ignoreState = next;
    api.setStudyIgnore(next);
  }

  function inside(el, x, y) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  window.addEventListener('mousemove', event => {
    if (dragging || resizing) return;
    setIgnore(!(inside(headEl, event.clientX, event.clientY) || inside(gripEl, event.clientX, event.clientY)));
  });

  window.addEventListener('mouseleave', () => {
    if (dragging || resizing) return;
    setIgnore(true);
  });

  headEl?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    dragging = true;
    headEl.classList.add('is-dragging');
    headEl.setPointerCapture?.(event.pointerId);
    api.studyDragStart();
  });

  gripEl?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizing = {
      x: event.screenX,
      y: event.screenY,
      width: window.innerWidth,
      height: window.innerHeight
    };
    gripEl.setPointerCapture?.(event.pointerId);
    setIgnore(false);
  });

  window.addEventListener('pointermove', event => {
    if (!resizing) return;
    api.studyResize({
      width: resizing.width + (event.screenX - resizing.x),
      height: resizing.height + (event.screenY - resizing.y)
    });
  });

  window.addEventListener('pointerup', () => {
    if (dragging) {
      dragging = false;
      headEl.classList.remove('is-dragging');
      api.studyDragEnd();
    }
    if (resizing) {
      resizing = null;
      setIgnore(true);
    }
  });

  api.onStudy(render);
})();
