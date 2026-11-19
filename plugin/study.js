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

  // 只列实词，一般一句 3–8 个；上限留一点余量，避免长定语句把面板撑爆
  const MAX_WORDS = 12;
  const MAX_CHUNKS = 8;
  const MAX_NOTES = 4;

  // 只有实词值得记：助词、助动词只是语法零件，逐条标意思反而全是噪声
  const CONTENT_POS = new Set(['名詞', '動詞', '形容詞', '形容動詞', '副詞', '連体詞', '接続詞', '感動詞', '接頭詞']);
  // 每次渲染递增，异步查到的释义只往当前这一屏里填
  let renderSeq = 0;

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
      // 同一个语法角色永远同一个色相，扫一眼就能看出句子骨架
      role.style.setProperty('--hue', String(hueOf(chunk.role)));
      const text = document.createElement('span');
      text.textContent = chunk.text;
      item.append(role, text);
      chunksEl.appendChild(item);
    });
  }

  function renderWords(tokens) {
    wordsEl.textContent = '';
    const entries = [];
    const seen = new Set();
    tokens.forEach(token => {
      if (entries.length >= MAX_WORDS) return;
      if (!CONTENT_POS.has(token.pos)) return;
      const key = token.base || token.surface;
      // 同一句里重复出现的词只列一次
      if (!key || seen.has(key)) return;
      seen.add(key);
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
      entries.push({ item, token });
    });
    if (!entries.length) {
      wordsEl.appendChild(empty('本句没有需要记的实词'));
      return [];
    }
    return entries;
  }

  // 逐词补中文释义：走和字幕同一套翻译接口，结果在主进程里按词缓存，
  // 常用词第一次查过之后就不再发请求了。并发 3，避免一次涌出十几个请求。
  async function fillMeanings(entries, seq) {
    const queue = entries.slice();
    if (!queue.length) return;
    const worker = async () => {
      while (queue.length) {
        if (seq !== renderSeq) return;
        const entry = queue.shift();
        const result = await api
          .lookupWord({
            surface: entry.token.surface,
            base: entry.token.base,
            reading: entry.token.reading,
            pos: entry.token.label
          })
          .catch(() => null);
        if (seq !== renderSeq) return;
        const meaning = String(result?.meaning || '').trim();
        if (!meaning) continue;
        const span = document.createElement('span');
        span.className = 'meaning';
        span.textContent = meaning;
        entry.item.appendChild(span);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, entries.length) }, worker));
  }

  function render(payload) {
    renderSeq += 1;
    const seq = renderSeq;
    if (bodyEl) bodyEl.scrollTop = 0;
    closeDetail();
    renderSentence(payload.tokens || []);
    renderChunks(payload.chunks || []);
    const entries = renderWords(payload.tokens || []);
    fillMeanings(entries, seq);

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
    document.documentElement.classList.remove('is-dragging');
    cardEl?.classList.remove('is-dragging');
    api.studyDragEnd();
  }

  cardEl?.addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    // 点单词 / 点详情卡 / 点抽屉和按钮不要触发拖动，否则会把点击吃掉
    if (event.target.closest('.word, .word-detail, .drawer, .tool')) return;
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
    document.documentElement.classList.add('is-dragging');
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
    wordsEl.querySelectorAll('.word.is-active').forEach(node => node.classList.remove('is-active'));
  }

  // 词典词条 → 详情卡正文：义项逐条编号，后面附日汉对照例句
  function formatEntry(detail, surface) {
    if (!detail) return '';
    const lines = [];
    const kanji = detail.kanji && detail.kanji !== surface ? `汉字写法 ${detail.kanji}` : '';
    if (kanji) lines.push(kanji);
    (detail.senses || []).forEach((sense, index) => {
      const pos = sense.pos ? `[${sense.pos}] ` : '';
      lines.push(`${index + 1}. ${pos}${sense.text}`);
    });
    const examples = detail.examples || [];
    if (examples.length) {
      lines.push('');
      lines.push('例文');
      examples.forEach(example => {
        lines.push(example.ja);
        lines.push(example.zh);
      });
    }
    return lines.join('\n');
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
    // 点开就算想学：顺手收进生词本，重复收录由主进程按原形去重
    item.classList.add('is-saved');
    api
      .wordbookAdd({
        surface: data.surface,
        base: data.base,
        reading: data.reading,
        pos: data.label
      })
      .catch(() => {});
    // 只在当前词上留高亮，方便和浮动详情卡对上
    wordsEl.querySelectorAll('.word.is-active').forEach(node => node.classList.remove('is-active'));
    item.classList.add('is-active');
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
    const detail = result?.detail;
    // 词典查到了就补上音调、罗马字、JLPT 等级，比 kuromoji 给的更全
    const head = [];
    if (detail?.reading) head.push(detail.reading + (detail.tone ? ` ${detail.tone}` : ''));
    if (detail?.romaji) head.push(detail.romaji);
    if (data.base && data.base !== data.surface) head.push(`原形 ${data.base}`);
    if (head.length) {
      detailReadingEl.textContent = head.join(' · ');
      detailReadingEl.hidden = false;
    }
    const pos = [data.label, detail?.exam].filter(Boolean).join(' · ');
    if (pos) {
      detailPosEl.textContent = pos;
      detailPosEl.hidden = false;
    }
    detailMeaningEl.classList.remove('is-loading');
    detailMeaningEl.textContent = formatEntry(detail, data.surface) || result?.meaning || '未查到释义';
    if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight;
  });

  document.getElementById('detailClose')?.addEventListener('click', closeDetail);

  // ————— 生词本 / 字幕历史抽屉 —————
  const drawerEl = document.getElementById('drawer');
  const drawerTitleEl = document.getElementById('drawerTitle');
  const drawerHintEl = document.getElementById('drawerHint');
  const drawerListEl = document.getElementById('drawerList');
  const drawerExportEl = document.getElementById('drawerExport');
  const drawerMaskEl = document.getElementById('drawerMask');
  let drawerMode = '';

  function span(className, text) {
    const node = document.createElement('span');
    node.className = className;
    node.textContent = text;
    return node;
  }

  // 把任意标签映射成固定色相：同一个词性/语法角色永远同一个颜色
  function hueOf(text) {
    let hash = 0;
    for (const ch of String(text || '')) hash = (hash * 31 + ch.codePointAt(0)) % 360;
    return hash;
  }

  function closeDrawer() {
    drawerMode = '';
    drawerEl.hidden = true;
  }

  function drawerRow(className = 'drawer-item') {
    const item = document.createElement('li');
    item.className = className;
    return item;
  }

  let maskMeanings = false;

  function renderWordbook(items) {
    items.forEach(entry => {
      const item = drawerRow();
      const head = document.createElement('div');
      head.className = 'drawer-item-head';
      head.appendChild(span('surface', entry.word || ''));
      if (entry.reading && entry.reading !== entry.word) {
        head.appendChild(span('reading', entry.reading));
      }
      if (entry.pos) head.appendChild(span('pos', entry.pos));
      // 单条删除：平时隐藏，鼠标移到这一行才出现
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'wb-remove';
      remove.textContent = '×';
      remove.title = '从生词本删除';
      remove.addEventListener('click', async event => {
        event.stopPropagation();
        const list = await api.wordbookRemove(entry.key).catch(() => null);
        item.remove();
        if (Array.isArray(list)) {
          drawerHintEl.textContent = list.length ? `共 ${list.length} 个词 · 点单词自动收录` : '';
          if (!list.length) drawerListEl.appendChild(empty('生词本已清空'));
        }
      });
      head.appendChild(remove);
      item.appendChild(head);
      if (entry.meaning) {
        const meaning = span('meaning wb-meaning', entry.meaning);
        meaning.title = '点一下显示或遮住释义';
        meaning.addEventListener('click', () => meaning.classList.toggle('is-revealed'));
        item.appendChild(meaning);
      }
      drawerListEl.appendChild(item);
    });
    // 复习模式：释义先糊住，自己回想完再点开
    drawerListEl.classList.toggle('is-masked', maskMeanings);
  }

  function renderHistory(items) {
    items.forEach(line => {
      const item = drawerRow('drawer-item history-item');
      if (line.speaker) item.appendChild(span('speaker', line.speaker));
      item.appendChild(span('ja', line.ja || ''));
      item.appendChild(span('zh', line.zh || '（无译文）'));
      drawerListEl.appendChild(item);
    });
  }

  function renderNames(items) {
    items.forEach(entry => {
      const item = drawerRow('drawer-item name-item');
      const head = document.createElement('div');
      head.className = 'drawer-item-head';
      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'name-edit';
      nameBtn.textContent = entry.name;
      nameBtn.title = 'OCR 认错了？点一下改成正确写法';
      head.appendChild(nameBtn);
      if (entry.zh) head.appendChild(span('zh-name', entry.zh));
      head.appendChild(span('pos', `${entry.count} 次`));
      item.appendChild(head);
      drawerListEl.appendChild(item);
      nameBtn.addEventListener('click', () => startRename(head, entry));
    });
  }

  // 就地改成一个输入框，回车保存；保存后主进程会给新写法加权重，后续帧自动归到它
  function startRename(head, entry) {
    head.textContent = '';
    const input = document.createElement('input');
    input.className = 'name-input';
    input.value = entry.name;
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tool';
    save.textContent = '保存';
    head.append(input, save);
    input.focus();
    input.select();
    const commit = async () => {
      const next = input.value.trim();
      if (!next || next === entry.name) {
        refreshDrawer();
        return;
      }
      await api.renameName(entry.name, next).catch(() => null);
      refreshDrawer();
    };
    save.addEventListener('click', commit);
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') commit();
      if (event.key === 'Escape') refreshDrawer();
    });
  }

  // 重新拉一遍当前抽屉，不触发「再点一次就关掉」的开关逻辑
  function refreshDrawer() {
    const mode = drawerMode;
    drawerMode = '';
    openDrawer(mode);
  }

  async function openDrawer(mode) {
    if (!mode) return;
    if (drawerMode === mode && !drawerEl.hidden) {
      closeDrawer();
      return;
    }
    drawerMode = mode;
    drawerEl.hidden = false;
    drawerTitleEl.textContent =
      mode === 'wordbook' ? '生词本' : mode === 'history' ? '最近字幕' : '人名';
    drawerExportEl.hidden = mode !== 'wordbook';
    if (drawerMaskEl) {
      drawerMaskEl.hidden = mode !== 'wordbook';
      drawerMaskEl.textContent = maskMeanings ? '显示释义' : '遮住释义';
    }
    drawerListEl.textContent = '';
    const items = await (
      mode === 'wordbook' ? api.wordbookList() : mode === 'history' ? api.history() : api.names()
    ).catch(() => []);
    if (drawerMode !== mode) return;
    if (mode === 'wordbook') {
      drawerHintEl.textContent = items.length ? `共 ${items.length} 个词 · 点单词自动收录` : '';
      if (!items.length) {
        drawerListEl.appendChild(empty('还没有收录单词，点面板里的单词就会自动记下来'));
        return;
      }
      renderWordbook(items);
      return;
    }
    if (mode === 'names') {
      drawerHintEl.textContent = items.length ? `共 ${items.length} 个 · 点名字可改正` : '';
      if (!items.length) {
        drawerListEl.appendChild(empty('还没遇到带【人名】的台词'));
        return;
      }
      renderNames(items);
      return;
    }
    drawerHintEl.textContent = items.length ? `最近 ${items.length} 句` : '';
    if (!items.length) {
      drawerListEl.appendChild(empty('还没有字幕记录'));
      return;
    }
    renderHistory(items);
  }

  document.getElementById('wordbookBtn')?.addEventListener('click', () => openDrawer('wordbook'));
  document.getElementById('namesBtn')?.addEventListener('click', () => openDrawer('names'));
  document.getElementById('historyBtn')?.addEventListener('click', () => openDrawer('history'));
  document.getElementById('drawerClose')?.addEventListener('click', closeDrawer);
  drawerExportEl?.addEventListener('click', async () => {
    const result = await api.wordbookExport().catch(() => null);
    drawerHintEl.textContent = result?.file ? `已导出到 ${result.file}` : '导出失败';
  });

  // 复习模式：只切换显示方式，不重新请求数据
  drawerMaskEl?.addEventListener('click', () => {
    maskMeanings = !maskMeanings;
    drawerMaskEl.textContent = maskMeanings ? '显示释义' : '遮住释义';
    drawerListEl.classList.toggle('is-masked', maskMeanings);
    drawerListEl.querySelectorAll('.wb-meaning.is-revealed').forEach(node => node.classList.remove('is-revealed'));
  });

  api.onStudy(render);
})();
