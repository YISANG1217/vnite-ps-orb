// PaddleOCR（RapidOCR 的 ONNX 模型）推理子进程。
// 只在「实时翻译」开启且引擎选 paddle 时由 translator.cjs 拉起；崩溃/缺模型都不会影响主进程。
//   node ocr-paddle.cjs --image <path>     离线识别一张图，打印 JSON
//   stdin 逐行收 {"image":"<path>"}，每行输出一条 JSON 结果
// 流程：PP-OCRv5 det 找文本行 → 裁剪 → japan_PP-OCRv4 rec 识别 → CTC 贪心解码。
const fs = require('node:fs');
const path = require('node:path');

const MODEL_DIR = path.join(__dirname, 'models');
const DET_LIMIT = 960;
const DET_BINARY_THRESHOLD = 0.3;
const DET_BOX_THRESHOLD = 0.45;
const UNCLIP_RATIO = 1.5;
const REC_HEIGHT = 48;

let ort = null;
let detSession = null;
let recSession = null;
let dict = null;

function loadOrt() {
  if (!ort) ort = require('onnxruntime-node');
  return ort;
}

async function ensureSessions() {
  if (detSession && recSession && dict) return;
  loadOrt();
  const detPath = path.join(MODEL_DIR, 'det.onnx');
  const recPath = path.join(MODEL_DIR, 'rec.onnx');
  const dictPath = path.join(MODEL_DIR, 'dict.txt');
  for (const file of [detPath, recPath, dictPath]) {
    if (!fs.existsSync(file)) throw new Error(`missing-model:${path.basename(file)}`);
  }
  if (!detSession) detSession = await ort.InferenceSession.create(detPath);
  if (!recSession) recSession = await ort.InferenceSession.create(recPath);
  if (!dict) {
    dict = fs.readFileSync(dictPath, 'utf8').split(/\r?\n/);
    if (dict.length && dict[dict.length - 1] === '') dict.pop();
    // PaddleOCR 的识别字典在文件末尾追加一个空格字符，CTC 索引要减一
    dict.push(' ');
  }
}

// ————— 位图 —————
// ovr.ps1 存的是 GDI 的 BMP（24/32bpp 未压缩），只解这一种，省掉一个解码依赖。
function decodeBmp(buf) {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) throw new Error('unsupported-image');
  const dataOffset = buf.readUInt32LE(10);
  const headerSize = buf.readUInt32LE(14);
  if (headerSize < 40) throw new Error('unsupported-bmp');
  const width = buf.readInt32LE(18);
  const rawHeight = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  if (buf.readUInt32LE(30) !== 0) throw new Error('unsupported-bmp-compression');
  if (bpp !== 24 && bpp !== 32) throw new Error('unsupported-bmp-bpp');
  if (width <= 0 || rawHeight === 0) throw new Error('bad-bmp-size');
  const height = Math.abs(rawHeight);
  const topDown = rawHeight < 0;
  const step = bpp === 32 ? 4 : 3;
  const stride = Math.floor((width * step + 3) / 4) * 4;
  if (dataOffset + stride * height > buf.length) throw new Error('truncated-bmp');
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    const src = dataOffset + (topDown ? y : height - 1 - y) * stride;
    let dst = y * width * 3;
    for (let x = 0; x < width; x += 1) {
      const i = src + x * step;
      rgb[dst] = buf[i + 2];
      rgb[dst + 1] = buf[i + 1];
      rgb[dst + 2] = buf[i];
      dst += 3;
    }
  }
  return { width, height, rgb };
}

function cropImage(img, x, y, w, h) {
  const rgb = new Uint8Array(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * img.width + x) * 3;
    rgb.set(img.rgb.subarray(from, from + w * 3), row * w * 3);
  }
  return { width: w, height: h, rgb };
}

// 双线性缩放：det 输入尺寸和 rec 高度都要改，保持比例即可，运算量比双三次小很多
function resizeRgb(img, dstW, dstH) {
  if (img.width === dstW && img.height === dstH) return img;
  const out = new Uint8Array(dstW * dstH * 3);
  const xScale = img.width / dstW;
  const yScale = img.height / dstH;
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(img.height - 1, Math.max(0, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(img.height - 1, y0 + 1);
    const wy = sy - y0;
    const row0 = y0 * img.width * 3;
    const row1 = y1 * img.width * 3;
    let dst = y * dstW * 3;
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(img.width - 1, Math.max(0, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(img.width - 1, x0 + 1);
      const wx = sx - x0;
      for (let c = 0; c < 3; c += 1) {
        const p00 = img.rgb[row0 + x0 * 3 + c];
        const p01 = img.rgb[row0 + x1 * 3 + c];
        const p10 = img.rgb[row1 + x0 * 3 + c];
        const p11 = img.rgb[row1 + x1 * 3 + c];
        out[dst + c] =
          (p00 * (1 - wx) * (1 - wy) + p01 * wx * (1 - wy) + p10 * (1 - wx) * wy + p11 * wx * wy) | 0;
      }
      dst += 3;
    }
  }
  return { width: dstW, height: dstH, rgb: out };
}

// NCHW、(x/255-mean)/std。BGR 顺序与检测模型的训练一致（PaddleOCR 侧是 cv2 读图），
// 识别模型三项均值方差都是 0.5，所以同一套预处理也能直接用。
const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

function toTensor(img) {
  const size = img.width * img.height;
  const data = new Float32Array(size * 3);
  for (let i = 0; i < size; i += 1) {
    data[i] = (img.rgb[i * 3 + 2] / 255 - DET_MEAN[0]) / DET_STD[0];
    data[size + i] = (img.rgb[i * 3 + 1] / 255 - DET_MEAN[1]) / DET_STD[1];
    data[size * 2 + i] = (img.rgb[i * 3] / 255 - DET_MEAN[2]) / DET_STD[2];
  }
  return new ort.Tensor('float32', data, [1, 3, img.height, img.width]);
}

// ————— 检测 —————
// 概率图 → 连通域 → 文本框（坐标以概率图为准）
function boxesFromProbability(prob, pw, ph) {
  const mask = new Uint8Array(pw * ph);
  let hits = 0;
  for (let i = 0; i < mask.length; i += 1) {
    if (prob[i] >= DET_BINARY_THRESHOLD) {
      mask[i] = 1;
      hits += 1;
    }
  }
  if (!hits) return [];
  const seen = new Uint8Array(pw * ph);
  const stack = new Int32Array(pw * ph);
  const boxes = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let top = ph;
    let left = pw;
    let bottom = -1;
    let right = -1;
    let count = 0;
    let sum = 0;
    let sp = 0;
    stack[sp] = start;
    sp += 1;
    seen[start] = 1;
    while (sp > 0) {
      sp -= 1;
      const index = stack[sp];
      const x = index % pw;
      const y = (index - x) / pw;
      count += 1;
      sum += prob[index];
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x < left) left = x;
      if (x > right) right = x;
      if (x > 0 && mask[index - 1] && !seen[index - 1]) {
        seen[index - 1] = 1;
        stack[sp] = index - 1;
        sp += 1;
      }
      if (x + 1 < pw && mask[index + 1] && !seen[index + 1]) {
        seen[index + 1] = 1;
        stack[sp] = index + 1;
        sp += 1;
      }
      if (y > 0 && mask[index - pw] && !seen[index - pw]) {
        seen[index - pw] = 1;
        stack[sp] = index - pw;
        sp += 1;
      }
      if (y + 1 < ph && mask[index + pw] && !seen[index + pw]) {
        seen[index + pw] = 1;
        stack[sp] = index + pw;
        sp += 1;
      }
    }
    if (count < 8) continue;
    const score = sum / count;
    if (score < DET_BOX_THRESHOLD) continue;
    boxes.push({ left, top, right: right + 1, bottom: bottom + 1, score });
  }
  return boxes;
}

// DB 输出的是「收缩后」的文本区域，直接拿它裁图会把上下边缘切掉，
// 所以按官方 unclip 公式外扩：面积 * 比例 / 周长（比例 1.5 与训练一致）。
function unclipBox(box) {
  const w = Math.max(1, box.right - box.left);
  const h = Math.max(1, box.bottom - box.top);
  const d = Math.min(Math.min(w, h) * 0.6, (UNCLIP_RATIO * w * h) / (2 * (w + h)));
  return {
    left: box.left - d,
    top: box.top - d,
    right: box.right + d,
    bottom: box.bottom + d
  };
}

async function detect(img) {
  const maxSide = Math.max(img.width, img.height);
  let ratio = 1;
  if (maxSide > DET_LIMIT) ratio = DET_LIMIT / maxSide;
  else if (maxSide < 480) ratio = 2;
  const dstW = Math.max(32, Math.round((img.width * ratio) / 32) * 32);
  const dstH = Math.max(32, Math.round((img.height * ratio) / 32) * 32);
  const resized = resizeRgb(img, dstW, dstH);
  const feeds = { [detSession.inputNames[0]]: toTensor(resized) };
  const output = await detSession.run(feeds);
  const map = output[detSession.outputNames[0]];
  const dims = map.dims;
  const ph = dims[dims.length - 2];
  const pw = dims[dims.length - 1];
  const scaleX = img.width / pw;
  const scaleY = img.height / ph;
  // 先按收缩后的框并成行，再做 unclip：否则相邻两行外扩后会粘在一起
  const boxes = mergeSameRow(boxesFromProbability(map.data, pw, ph))
    // 方形小色块（光标、按钮图标）不是台词
    .filter(box => box.right - box.left > (box.bottom - box.top) * 1.2)
    .map(unclipBox)
    .map(box => ({
      left: box.left * scaleX,
      top: box.top * scaleY,
      right: box.right * scaleX,
      bottom: box.bottom * scaleY
    }));
  if (process.env.PSD_DEBUG) {
    console.error(`det input=${dstW}x${dstH} map=${pw}x${ph} boxes=${JSON.stringify(boxes)}`);
  }
  return boxes;
}

// 同一行的碎片（假名被拆成多个连通域）合并成一条；行高差异超过 60% 的分开
function mergeSameRow(boxes) {
  const sorted = boxes.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const rows = [];
  for (const box of sorted) {
    const height = box.bottom - box.top;
    const center = (box.top + box.bottom) / 2;
    let target = null;
    for (const row of rows) {
      const overlap = Math.min(row.bottom, box.bottom) - Math.max(row.top, box.top);
      const rowCenter = (row.top + row.bottom) / 2;
      if (overlap > 0.45 * Math.min(row.bottom - row.top, height) && Math.abs(center - rowCenter) < height * 0.6) {
        target = row;
        break;
      }
    }
    if (target) {
      target.left = Math.min(target.left, box.left);
      target.right = Math.max(target.right, box.right);
      target.top = Math.min(target.top, box.top);
      target.bottom = Math.max(target.bottom, box.bottom);
    } else {
      rows.push({ ...box });
    }
  }
  return rows.sort((a, b) => a.top - b.top || a.left - b.left);
}

// ————— 识别 —————
function decodeCtc(data, steps, classes) {
  const chars = [];
  let prev = -1;
  let confidence = 0;
  let picked = 0;
  for (let s = 0; s < steps; s += 1) {
    const offset = s * classes;
    let best = 0;
    let bestIndex = 0;
    for (let c = 0; c < classes; c += 1) {
      const value = data[offset + c];
      if (value > best) {
        best = value;
        bestIndex = c;
      }
    }
    if (bestIndex !== 0 && bestIndex !== prev) {
      const char = dict[bestIndex - 1];
      if (char !== undefined) {
        chars.push(char);
        confidence += best;
        picked += 1;
      }
    }
    prev = bestIndex;
  }
  return { text: chars.join(''), score: picked ? confidence / picked : 0 };
}

async function recognizeLine(img, box) {
  // unclip 已经留出了背景边距，这里只补 2px 防止描边被切掉
  const x0 = Math.max(0, Math.round(box.left) - 2);
  const y0 = Math.max(0, Math.round(box.top) - 2);
  const x1 = Math.min(img.width, Math.round(box.right) + 2);
  const y1 = Math.min(img.height, Math.round(box.bottom) + 2);
  if (x1 - x0 < 4 || y1 - y0 < 4) return { text: '', score: 0 };
  const crop = cropImage(img, x0, y0, x1 - x0, y1 - y0);
  const ratio = crop.height / REC_HEIGHT;
  const dstW = Math.max(16, Math.min(3600, Math.round(crop.width / ratio)));
  const input = resizeRgb(crop, dstW, REC_HEIGHT);
  const feeds = { [recSession.inputNames[0]]: toTensor(input) };
  const output = await recSession.run(feeds);
  const tensor = output[recSession.outputNames[0]];
  const dims = tensor.dims;
  const classes = dims[dims.length - 1];
  const steps = dims[dims.length - 2];
  return decodeCtc(tensor.data, steps, classes);
}

// 行 → 文本框：竖直方向贴得很近的行算同一个文本框，跨文本框保留换行
function groupBlocks(lines) {
  const blocks = [];
  let current = null;
  for (const line of lines) {
    const height = Math.max(1, line.bottom - line.top);
    if (current) {
      const gap = line.top - current.bottom;
      if (gap < height * 0.7) {
        current.text += line.text;
        current.bottom = line.bottom;
        continue;
      }
    }
    current = { text: line.text, top: line.top, bottom: line.bottom };
    blocks.push(current);
  }
  return blocks.map(block => block.text);
}

// 对话框右下角的「续行箭头」跟着台词行一起被识别，通常认成 ！或 ｜。
// 紧跟在右引号/右括号后面时去掉；台词中间的感叹号不受影响。
function cleanLine(text) {
  return text.replace(/([」』）】])\s*[！!|｜]+$/, '$1');
}

async function recognizeImage(filePath) {
  await ensureSessions();
  const img = decodeBmp(fs.readFileSync(filePath));
  const boxes = await detect(img);
  const lines = [];
  for (const box of boxes) {
    const result = await recognizeLine(img, box);
    const text = cleanLine(result.text.replace(/\s+/g, '').trim());
    if (!text) continue;
    lines.push({ text, top: box.top, bottom: box.bottom, left: box.left, score: result.score });
  }
  lines.sort((a, b) => a.top - b.top || a.left - b.left);
  return {
    lines: lines.map(line => line.text),
    blocks: groupBlocks(lines)
  };
}

async function handleLine(line) {
  let filePath = line;
  if (line.startsWith('{')) {
    const payload = JSON.parse(line);
    filePath = String(payload.image || payload.path || '');
  }
  if (!filePath) return { error: 'bad-command' };
  const result = await recognizeImage(filePath);
  return { ...result, engine: 'paddle' };
}

async function main() {
  const argIndex = process.argv.indexOf('--image');
  if (argIndex !== -1) {
    const file = process.argv[argIndex + 1];
    const result = await handleLine(file);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
  const rl = require('node:readline').createInterface({ input: process.stdin });
  let chain = Promise.resolve();
  rl.on('line', raw => {
    const line = raw.trim();
    if (!line) return;
    chain = chain
      .then(async () => {
        let result;
        try {
          result = await handleLine(line);
        } catch (error) {
          result = { error: String(error?.message || error) };
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
      })
      .catch(() => {});
  });
  rl.on('close', () => {
    chain.finally(() => process.exit(0));
  });
}

main().catch(error => {
  process.stdout.write(`${JSON.stringify({ error: String(error?.message || error) })}\n`);
  process.exit(1);
});
