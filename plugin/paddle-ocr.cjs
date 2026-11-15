// PaddleOCR（PP-OCR）离线识别：ch_PP-OCRv4_det 找文本框 + japan_PP-OCRv3 识别日文。
// 纯 JS 做预处理/后处理，不依赖 opencv；推理走 onnxruntime-node（N-API）。
// 对外结构与 Windows OCR 一致：{ text, lines }，lines 已按从上到下、从左到右排序。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const MODEL_DIR = path.join(__dirname, 'models');
const DET_MODEL = path.join(MODEL_DIR, 'ch_PP-OCRv4_det_infer.onnx');
const REC_MODEL = path.join(MODEL_DIR, 'japan_PP-OCRv4_rec_infer.onnx');
const DICT_FILE = path.join(MODEL_DIR, 'japan_dict.txt');

// det：长边缩放上限与缩放倍数上限（小图放大识别更准，但太快会拖慢单帧）
const DET_SIDE_LIMIT = 960;
const DET_MAX_SCALE = 2;
// 概率图二值化阈值：0.3 是 PP-OCR 的默认值
const DET_PIXEL_THRESHOLD = 0.3;
// 框内平均概率，用来滤掉零星噪点
const DET_SCORE_THRESHOLD = 0.5;
// rec：固定高 48，宽按比例。上限取 2048：640 会把长行横向压扁，
// 切成小段又会在字中间断开，长句正确率明显变差（实测单帧仍在 100ms 内）
const REC_HEIGHT = 48;
const REC_MAX_WIDTH = 2048;
// det 输出是 DB 收缩后的文字主体，实际只有字高的四成左右，纵向要放大约 2.8 倍裁回来
const BOX_HEIGHT_FACTOR = 2.8;

const DET_MEAN = [0.485, 0.456, 0.406];
const DET_STD = [0.229, 0.224, 0.225];

let context = null;
let loading = null;

function load() {
  if (context) return Promise.resolve(context);
  if (loading) return loading;
  loading = (async () => {
    if (!fs.existsSync(DET_MODEL) || !fs.existsSync(REC_MODEL) || !fs.existsSync(DICT_FILE)) {
      throw new Error('paddle-model-missing');
    }
    // 延迟 require：onnxruntime 加载失败时只影响 OCR，插件其余功能照常
    const ort = require('onnxruntime-node');
    const { PNG } = require('pngjs');
    const options = {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: Math.max(1, Math.min(4, os.cpus().length - 1)),
      interOpNumThreads: 1
    };
    const [det, rec] = await Promise.all([
      ort.InferenceSession.create(DET_MODEL, options),
      ort.InferenceSession.create(REC_MODEL, options)
    ]);
    const dict = fs
      .readFileSync(DICT_FILE, 'utf8')
      .split(/\r?\n/);
    // 文件末尾的换行会多出一个空串
    while (dict.length && dict[dict.length - 1] === '') dict.pop();
    // 词典第一个字符对应 CTC 的第 1 类，第 0 类是 blank
    context = { ort, PNG, det, rec, dict };
    return context;
  })();
  // 失败结果也缓存：调用方（translator）只需要知道不可用，不必每帧重试
  return loading;
}

function channelOffsets(image) {
  // PNG 解码出来是 RGBA；nativeImage.toBitmap() 给的是 BGRA
  return image.bgra ? [2, 1, 0] : [0, 1, 2];
}

// 双线性缩放成 CHW 的 float32（det 用 ImageNet 归一化）
function detTensor(image, rw, rh) {
  const total = rw * rh;
  const output = new Float32Array(total * 3);
  const [ro, go, bo] = channelOffsets(image);
  const sx = image.width / rw;
  const sy = image.height / rh;
  const x0 = new Int32Array(rw);
  const x1 = new Int32Array(rw);
  const xw = new Float32Array(rw);
  for (let x = 0; x < rw; x += 1) {
    const fx = Math.min(image.width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
    const ix = Math.floor(fx);
    x0[x] = ix;
    x1[x] = Math.min(image.width - 1, ix + 1);
    xw[x] = fx - ix;
  }
  for (let y = 0; y < rh; y += 1) {
    const fy = Math.min(image.height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const iy = Math.floor(fy);
    const y1 = Math.min(image.height - 1, iy + 1);
    const wy = fy - iy;
    const rowA = iy * image.width;
    const rowB = y1 * image.width;
    for (let x = 0; x < rw; x += 1) {
      const a = (rowA + x0[x]) * 4;
      const b = (rowA + x1[x]) * 4;
      const c = (rowB + x0[x]) * 4;
      const d = (rowB + x1[x]) * 4;
      const w00 = (1 - xw[x]) * (1 - wy);
      const w10 = xw[x] * (1 - wy);
      const w01 = (1 - xw[x]) * wy;
      const w11 = xw[x] * wy;
      const r = image.data[a + ro] * w00 + image.data[b + ro] * w10 + image.data[c + ro] * w01 + image.data[d + ro] * w11;
      const g = image.data[a + go] * w00 + image.data[b + go] * w10 + image.data[c + go] * w01 + image.data[d + go] * w11;
      const bl = image.data[a + bo] * w00 + image.data[b + bo] * w10 + image.data[c + bo] * w01 + image.data[d + bo] * w11;
      const offset = y * rw + x;
      output[offset] = (r / 255 - DET_MEAN[0]) / DET_STD[0];
      output[total + offset] = (g / 255 - DET_MEAN[1]) / DET_STD[1];
      output[total * 2 + offset] = (bl / 255 - DET_MEAN[2]) / DET_STD[2];
    }
  }
  return output;
}

// 连通域：直接对概率图按阈值连通，得到字符/词块
function findBoxes(mask, prob, width, height) {
  const visited = new Uint8Array(width * height);
  const stack = new Int32Array(width * height);
  const boxes = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    let top = height;
    let left = width;
    let right = -1;
    let bottom = -1;
    let area = 0;
    let score = 0;
    let sp = 0;
    stack[sp++] = start;
    visited[start] = 1;
    while (sp) {
      const index = stack[--sp];
      const x = index % width;
      const y = (index / width) | 0;
      area += 1;
      score += prob[index];
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
      if (x > 0 && mask[index - 1] && !visited[index - 1]) {
        visited[index - 1] = 1;
        stack[sp++] = index - 1;
      }
      if (x + 1 < width && mask[index + 1] && !visited[index + 1]) {
        visited[index + 1] = 1;
        stack[sp++] = index + 1;
      }
      if (y > 0 && mask[index - width] && !visited[index - width]) {
        visited[index - width] = 1;
        stack[sp++] = index - width;
      }
      if (y + 1 < height && mask[index + width] && !visited[index + width]) {
        visited[index + width] = 1;
        stack[sp++] = index + width;
      }
    }
    const w = right - left + 1;
    const h = bottom - top + 1;
    if (h < 4 || w < 3 || area < 8) continue;
    if (score / area < DET_SCORE_THRESHOLD) continue;
    boxes.push({ left, top, right, bottom, width: w, height: h });
  }
  return boxes;
}

// 把同一视觉行、水平间距很小的字符块并成一行
function mergeBoxes(boxes) {
  const sorted = boxes.slice().sort((a, b) => a.top - b.top || a.left - b.left);
  const lines = [];
  sorted.forEach(box => {
    let target = null;
    for (const line of lines) {
      const overlap = Math.min(line.bottom, box.bottom) - Math.max(line.top, box.top);
      const minHeight = Math.min(line.height, box.height);
      if (overlap <= 0.4 * minHeight) continue;
      const gap = Math.max(line.left, box.left) - Math.min(line.right, box.right);
      if (gap > 0.8 * Math.max(line.height, box.height)) continue;
      target = line;
      break;
    }
    if (!target) {
      lines.push({ ...box });
      return;
    }
    target.left = Math.min(target.left, box.left);
    target.right = Math.max(target.right, box.right);
    target.top = Math.min(target.top, box.top);
    target.bottom = Math.max(target.bottom, box.bottom);
    target.width = target.right - target.left + 1;
    target.height = target.bottom - target.top + 1;
  });
  return lines;
}

// 按「行」分组后再排序：y 从上到下，组内 x 从左到右
function orderLines(lines) {
  const rows = [];
  lines
    .slice()
    .sort((a, b) => a.top - b.top || a.left - b.left)
    .forEach(line => {
      let row = null;
      for (const candidate of rows) {
        const overlap = Math.min(candidate.bottom, line.bottom) - Math.max(candidate.top, line.top);
        const minHeight = Math.min(candidate.bottom - candidate.top, line.bottom - line.top);
        if (overlap > 0.5 * minHeight) {
          row = candidate;
          break;
        }
      }
      if (!row) {
        rows.push({ top: line.top, bottom: line.bottom, items: [line] });
        return;
      }
      row.items.push(line);
      row.top = Math.min(row.top, line.top);
      row.bottom = Math.max(row.bottom, line.bottom);
    });
  const ordered = [];
  rows
    .sort((a, b) => a.top - b.top)
    .forEach(row => {
      row.items.sort((a, b) => a.left - b.left).forEach(line => ordered.push(line));
    });
  return ordered;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

// 文本框恢复：det 只框到文字主体（行尾的「ー」「～」「……」常被漏掉），
// 所以纵向按高度外扩，横向沿这一行找连续墨迹，补回行尾但不会把远处的 UI 吞进来。
function expandBox(image, box) {
  const padY = box.height * (BOX_HEIGHT_FACTOR - 1) / 2;
  const top = clamp(Math.floor(box.top - padY), 0, image.height - 2);
  const bottom = clamp(Math.ceil(box.bottom + padY), top + 1, image.height);
  const row = { left: 0, top, width: image.width, height: bottom - top };
  const energy = columnEnergy(image, row);
  let sum = 0;
  let max = 0;
  for (let x = 0; x < energy.length; x += 1) {
    sum += energy[x];
    if (energy[x] > max) max = energy[x];
  }
  const threshold = Math.max((sum / Math.max(1, energy.length)) * 0.45, max * 0.04);
  // 连续的墨迹列 → 用不超过一个字高的间隙合并成组
  const groups = [];
  let start = -1;
  for (let x = 0; x <= energy.length; x += 1) {
    const active = x < energy.length && energy[x] > threshold;
    if (active && start < 0) start = x;
    if (!active && start >= 0) {
      const previous = groups[groups.length - 1];
      if (previous && start - previous[1] <= row.height) previous[1] = x - 1;
      else groups.push([start, x - 1]);
      start = -1;
    }
  }
  const center = (box.left + box.right) / 2;
  const group = groups.find(item => center >= item[0] - row.height && center <= item[1] + row.height);
  const left = clamp((group ? group[0] : box.left) - 2, 0, image.width - 2);
  const right = clamp((group ? group[1] : box.right) + 2, left + 1, image.width);
  return { left, top, width: right - left, height: bottom - top };
}

// 列方向墨量（相邻像素亮度差），用来在字与字之间找切分点
function columnEnergy(image, box) {
  const energy = new Float32Array(box.width);
  const [ro, go, bo] = channelOffsets(image);
  for (let y = box.top; y < box.top + box.height; y += 1) {
    const row = y * image.width;
    let previous = -1;
    for (let x = box.left; x < box.left + box.width; x += 1) {
      const index = (row + x) * 4;
      const luminance = image.data[index + ro] * 0.299 + image.data[index + go] * 0.587 + image.data[index + bo] * 0.114;
      if (previous >= 0) {
        const delta = Math.abs(luminance - previous);
        energy[x - box.left] += delta;
      }
      previous = luminance;
    }
  }
  return energy;
}

// 长行按墨量最小处切段，避免 rec 宽度超过上限后横向被压扁
function splitChunks(image, box) {
  const scale = REC_HEIGHT / box.height;
  const maxWidth = Math.max(32, Math.floor(REC_MAX_WIDTH / scale));
  if (box.width <= maxWidth) return [box];
  const energy = columnEnergy(image, box);
  const chunks = [];
  let start = 0;
  while (start < box.width) {
    if (box.width - start <= maxWidth) {
      chunks.push({ ...box, left: box.left + start, width: box.width - start });
      break;
    }
    // 在 [start+60%*max, start+max] 里找最安静的一列
    const from = start + Math.floor(maxWidth * 0.6);
    const to = start + maxWidth;
    let cut = to;
    let best = Infinity;
    for (let x = from; x < to; x += 1) {
      const value = energy[x] + energy[x + 1];
      if (value < best) {
        best = value;
        cut = x + 1;
      }
    }
    chunks.push({ ...box, left: box.left + start, width: cut - start });
    start = cut;
  }
  return chunks;
}

// 裁剪 + 缩放成 rec 输入（高 48，宽按比例；归一化到 -1..1）
function recTensor(image, box) {
  const rw = Math.max(8, Math.min(REC_MAX_WIDTH, Math.round((box.width * REC_HEIGHT) / box.height)));
  const rh = REC_HEIGHT;
  const [ro, go, bo] = channelOffsets(image);
  const sx = box.width / rw;
  const sy = box.height / rh;
  const total = rw * rh;
  const output = new Float32Array(total * 3);
  const x0 = new Int32Array(rw);
  const x1 = new Int32Array(rw);
  const xw = new Float32Array(rw);
  for (let x = 0; x < rw; x += 1) {
    const fx = clamp((x + 0.5) * sx - 0.5, 0, box.width - 1);
    const ix = Math.floor(fx);
    x0[x] = box.left + ix;
    x1[x] = box.left + Math.min(box.width - 1, ix + 1);
    xw[x] = fx - ix;
  }
  for (let y = 0; y < rh; y += 1) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, box.height - 1);
    const iy = box.top + Math.floor(fy);
    const iy1 = box.top + Math.min(box.height - 1, Math.floor(fy) + 1);
    const wy = fy - Math.floor(fy);
    const rowA = iy * image.width;
    const rowB = iy1 * image.width;
    for (let x = 0; x < rw; x += 1) {
      const a = (rowA + x0[x]) * 4;
      const b = (rowA + x1[x]) * 4;
      const c = (rowB + x0[x]) * 4;
      const d = (rowB + x1[x]) * 4;
      const w00 = (1 - xw[x]) * (1 - wy);
      const w10 = xw[x] * (1 - wy);
      const w01 = (1 - xw[x]) * wy;
      const w11 = xw[x] * wy;
      const r = image.data[a + ro] * w00 + image.data[b + ro] * w10 + image.data[c + ro] * w01 + image.data[d + ro] * w11;
      const g = image.data[a + go] * w00 + image.data[b + go] * w10 + image.data[c + go] * w01 + image.data[d + go] * w11;
      const bl = image.data[a + bo] * w00 + image.data[b + bo] * w10 + image.data[c + bo] * w01 + image.data[d + bo] * w11;
      const offset = y * rw + x;
      output[offset] = (r / 255 - 0.5) / 0.5;
      output[total + offset] = (g / 255 - 0.5) / 0.5;
      output[total * 2 + offset] = (bl / 255 - 0.5) / 0.5;
    }
  }
  return { data: output, width: rw, height: rh };
}

// CTC 贪心解码：argmax → 去连续重复 → 去 blank
function decodeCtc(data, timeSteps, classes, dict) {
  let previous = -1;
  const chars = [];
  let score = 0;
  let count = 0;
  for (let t = 0; t < timeSteps; t += 1) {
    const base = t * classes;
    let best = 0;
    let bestValue = data[base];
    for (let c = 1; c < classes; c += 1) {
      const value = data[base + c];
      if (value > bestValue) {
        bestValue = value;
        best = c;
      }
    }
    if (best !== 0 && best !== previous) {
      chars.push(dict[best - 1] || '');
      score += bestValue;
      count += 1;
    }
    previous = best;
  }
  return { text: chars.join(''), score: count ? score / count : 0 };
}

async function recognizeImage(image) {
  const ctx = await load();
  if (!image || image.width < 8 || image.height < 8) return { text: '', lines: [] };

  // —— det ——
  const ratio = Math.min(DET_MAX_SCALE, DET_SIDE_LIMIT / Math.max(image.width, image.height));
  const rw = Math.max(32, Math.round((image.width * ratio) / 32) * 32);
  const rh = Math.max(32, Math.round((image.height * ratio) / 32) * 32);
  const detInput = new ctx.ort.Tensor('float32', detTensor(image, rw, rh), [1, 3, rh, rw]);
  const detOut = await ctx.det.run({ [ctx.det.inputNames[0]]: detInput });
  const prob = detOut[ctx.det.outputNames[0]].data;
  const mask = new Uint8Array(prob.length);
  let ink = 0;
  for (let i = 0; i < prob.length; i += 1) {
    if (prob[i] > DET_PIXEL_THRESHOLD) {
      mask[i] = 1;
      ink += 1;
    }
  }
  if (!ink) return { text: '', lines: [] };

  const scaleX = image.width / rw;
  const scaleY = image.height / rh;
  const boxes = mergeBoxes(findBoxes(mask, prob, rw, rh)).map(box => ({
    left: box.left * scaleX,
    top: box.top * scaleY,
    right: (box.right + 1) * scaleX - 1,
    bottom: (box.bottom + 1) * scaleY - 1,
    width: (box.right - box.left + 1) * scaleX,
    height: (box.bottom - box.top + 1) * scaleY
  }));

  // —— rec ——
  const lines = [];
  for (const line of orderLines(boxes)) {
    const crop = expandBox(image, line);
    if (crop.width < 8 || crop.height < 6) continue;
    const pieces = [];
    for (const chunk of splitChunks(image, crop)) {
      const input = recTensor(image, chunk);
      const tensor = new ctx.ort.Tensor('float32', input.data, [1, 3, input.height, input.width]);
      const out = await ctx.rec.run({ [ctx.rec.inputNames[0]]: tensor });
      const value = out[ctx.rec.outputNames[0]];
      const dims = value.dims;
      const classes = dims[2];
      const decoded = decodeCtc(value.data, dims[1], classes, ctx.dict);
      if (decoded.text) pieces.push(decoded.text);
    }
    const text = pieces.join('').trim();
    if (text) lines.push(text);
  }

  return { text: lines.join('\n'), lines };
}

async function recognizeFile(file) {
  const ctx = await load();
  const png = ctx.PNG.sync.read(fs.readFileSync(file));
  return recognizeImage({ data: png.data, width: png.width, height: png.height, bgra: false });
}

async function recognizeBitmap(bitmap) {
  if (!bitmap || !bitmap.data || !bitmap.width) return { text: '', lines: [] };
  return recognizeImage({
    data: bitmap.data,
    width: bitmap.width,
    height: bitmap.height,
    bgra: bitmap.format !== 'rgba'
  });
}

module.exports = { recognizeFile, recognizeBitmap, load };
