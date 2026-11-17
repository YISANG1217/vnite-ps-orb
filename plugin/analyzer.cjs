// 离线日语分析：kuromoji 分词 + 读音 + 词性，再按助词做句节切分与语法点提示。
const path = require('node:path');

const POS_LABEL = {
  名詞: '名词',
  動詞: '动词',
  形容詞: '形容词',
  形容動詞: '形容动词',
  副詞: '副词',
  連体詞: '连体词',
  接続詞: '接续词',
  感動詞: '感叹词',
  助詞: '助词',
  助動詞: '助动词',
  接頭詞: '前缀',
  記号: '符号',
  フィラー: '填充词',
  その他: '其他'
};

// 句节成分：按句尾助词判断
const PARTICLE_ROLE = {
  は: '主题',
  が: '主语',
  を: '宾语',
  に: '补语·对象',
  で: '补语·场所',
  へ: '补语·方向',
  と: '补语·对象',
  から: '补语·起点',
  まで: '补语·终点',
  より: '补语·比较',
  も: '主题·兼',
  の: '连体修饰',
  や: '并列',
  か: '疑问'
};

const CONTINUE_PARTICLES = new Set(['の', 'て', 'で']);

const GRAMMAR_NOTES = [
  { match: ['て', 'いる'], text: '〜ている：动作正在进行，或状态的持续' },
  { match: ['で', 'いる'], text: '〜でいる：状态的持续' },
  { match: ['て', 'おく'], text: '〜ておく：事先做好某事' },
  { match: ['て', 'しまう'], text: '〜てしまう：做完，或表示遗憾' },
  { match: ['て', 'みる'], text: '〜てみる：试着做某事' },
  { match: ['て', 'も'], text: '〜ても：即使…也…' },
  { match: ['て', 'は'], text: '〜ては：如果…就…／反复做' },
  { match: ['たい'], text: '〜たい：表达说话人的愿望' },
  { match: ['ない'], text: '〜ない：否定形' },
  { match: ['なけれ'], text: '〜なければ：必须…' },
  { match: ['ながら'], text: '〜ながら：一边…一边…' },
  { match: ['そう'], text: '〜そう：看起来…／听说…' },
  { match: ['らしい'], text: '〜らしい：似乎…（推测）' },
  { match: ['よう'], text: '〜よう：好像…／为了…' },
  { match: ['ください'], text: '〜ください：请…' },
  { match: ['ので'], text: '〜ので：因为…（客观原因）' },
  { match: ['から'], text: '〜から：因为…／从…开始' },
  { match: ['が', '、'], text: '〜が、：转折，但…' },
  { match: ['れる'], text: '〜れる：被动／可能' },
  { match: ['られる'], text: '〜られる：被动／可能／敬语' },
  { match: ['させる'], text: '〜させる：使役，让某人做…' }
];

function katakanaToHiragana(text) {
  return Array.from(text || '')
    .map(char => {
      const code = char.charCodeAt(0);
      return code >= 0x30a1 && code <= 0x30f6 ? String.fromCharCode(code - 0x60) : char;
    })
    .join('');
}

const KANJI = /[\u4e00-\u9fff\u3005]/;

function createAnalyzer(kuromojiDir) {
  let tokenizer = null;
  let pending = null;

  function load() {
    if (tokenizer) return Promise.resolve(tokenizer);
    if (pending) return pending;
    pending = new Promise((resolve, reject) => {
      try {
        // 延迟 require：没装词典时不影响插件其余功能
        const kuromoji = require(kuromojiDir);
        kuromoji.builder({ dicPath: path.join(kuromojiDir, 'dict') }).build((error, instance) => {
          if (error) {
            pending = null;
            reject(error);
            return;
          }
          tokenizer = instance;
          resolve(instance);
        });
      } catch (error) {
        pending = null;
        reject(error);
      }
    });
    return pending;
  }

  function normalize(token) {
    const surface = token.surface_form || '';
    const reading = katakanaToHiragana(token.reading && token.reading !== '*' ? token.reading : '');
    const base = token.basic_form && token.basic_form !== '*' ? token.basic_form : '';
    const pos = token.pos || 'その他';
    const detail = token.pos_detail_1 && token.pos_detail_1 !== '*' ? token.pos_detail_1 : '';
    return {
      surface,
      reading,
      base: base && base !== surface ? base : '',
      pos,
      detail,
      label: POS_LABEL[pos] || pos,
      ruby: KANJI.test(surface) ? reading : ''
    };
  }

  // 句节：以助词、标点或谓语动词收尾
  function buildChunks(tokens) {
    const chunks = [];
    let buffer = [];

    const hasPredicate = () => buffer.some(token => token.pos === '動詞' || token.pos === '形容詞' || token.pos === '形容動詞');
    const flush = role => {
      if (!buffer.length) return;
      const text = buffer.map(token => token.surface).join('');
      const fallback = hasPredicate() ? '谓语' : '修饰语';
      chunks.push({ text, role: role || fallback, tokens: buffer.slice() });
      buffer = [];
    };

    tokens.forEach(token => {
      if (token.pos === '記号') {
        flush('');
        return;
      }
      buffer.push(token);
      if (token.pos !== '助詞') return;
      if (token.detail === '連体化' || token.detail === '終助詞') return;
      if (CONTINUE_PARTICLES.has(token.surface) && token.detail === '接続助詞') return;
      const previous = buffer[buffer.length - 2];
      // ても / でも：接续助词后面跟係助詞，整体仍算接续
      if (token.detail === '係助詞' && previous && previous.detail === '接続助詞') {
        flush('谓语·接续');
        return;
      }
      // 接续助词收尾（言われても / 待っているから）才标注为谓语·接续，
      // 格助词收尾（忘れてしまったことを）仍按宾格等成分标注。
      const role = token.detail === '接続助詞' ? '谓语·接续' : PARTICLE_ROLE[token.surface] || '接续';
      flush(role);
    });
    flush('');

    // 只剩终助词/助动词的碎片并回上一句节（…から + ね）
    const merged = [];
    chunks.forEach(chunk => {
      const previous = merged[merged.length - 1];
      const fragment = chunk.tokens.every(token => token.pos === '助詞' || token.pos === '助動詞');
      if (previous && fragment) {
        previous.text += chunk.text;
        return;
      }
      merged.push(chunk);
    });
    return merged.filter(chunk => chunk.text.trim());
  }

  function buildNotes(tokens) {
    // 用原形拼接，才能匹配 てしまった / 待っている 这类活用形
    const joined = tokens.map(token => token.base || token.surface).join('');
    const notes = [];
    GRAMMAR_NOTES.forEach(rule => {
      if (notes.length >= 4) return;
      const needle = rule.match.join('');
      if (!joined.includes(needle)) return;
      if (notes.some(note => note === rule.text)) return;
      notes.push(rule.text);
    });
    if (!notes.length && tokens.some(token => token.pos === '動詞')) {
      notes.push('动词位于句末，日语常用「谓语放最后」的语序');
    }
    return notes;
  }

  // OCR 常把长音符「ー」认成「一 / エ / 工」，夹在假名中间时直接改回来
  async function correct(text) {
    if (!text) return text;
    return text.replace(
      /([\u3041-\u3096\u30a1-\u30fa])[一エ工](?=[\u3041-\u3096\u30a1-\u30fa、。！？…」])/g,
      '$1ー'
    );
  }

  // OCR 自检：正常台词基本都能被词典切出来，乱码时会出现大段未登录词。
  // 只统计实词/假名，符号和数字不算，避免「……」「！」把比例冲淡。
  async function check(text) {
    if (!text) return { oov: 1, unknown: 0, total: 0, bad: true };
    const instance = await load();
    const tokens = instance.tokenize(text).filter(token => token.pos !== '記号');
    if (!tokens.length) return { oov: 1, unknown: 0, total: 0, bad: true };
    const unknown = tokens.filter(token => token.word_type === 'UNKNOWN').length;
    const oov = unknown / tokens.length;
    return { oov, unknown, total: tokens.length, bad: tokens.length >= 4 && oov > 0.45 };
  }

  return {
    async analyze(text) {
      if (!text) return null;
      const instance = await load();
      const tokens = instance.tokenize(text).map(normalize);
      return {
        tokens,
        chunks: buildChunks(tokens).map(chunk => ({ text: chunk.text, role: chunk.role })),
        notes: buildNotes(tokens)
      };
    },
    correct,
    check,
    warmup() {
      load().catch(() => {});
    }
  };
}

module.exports = { createAnalyzer };
