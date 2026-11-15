// 本地验证 PaddleOCR：node tools/ocr-test.cjs [样本...]
// 默认跑 %TEMP% 下的三张真实游戏对话框截图，打印识别文本与单帧耗时。
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const paddle = require(path.join(__dirname, '..', 'plugin', 'paddle-ocr.cjs'));

const samples =
  process.argv.length > 2
    ? process.argv.slice(2)
    : ['ocr-sample.png', 'ocr-sample2.png', 'ocr-sample3.png'].map(name => path.join(os.tmpdir(), name));

(async () => {
  const startedAll = Date.now();
  await paddle.load();
  console.log(`模型加载 ${Date.now() - startedAll}ms`);
  for (const file of samples) {
    if (!fs.existsSync(file)) {
      console.log(`${file} 不存在，跳过`);
      continue;
    }
    // 第一帧包含推理图初始化，第二帧才是真实单帧耗时
    await paddle.recognizeFile(file);
    const times = [];
    let result = null;
    for (let i = 0; i < 3; i += 1) {
      const started = process.hrtime.bigint();
      result = await paddle.recognizeFile(file);
      times.push(Number(process.hrtime.bigint() - started) / 1e6);
    }
    times.sort((a, b) => a - b);
    console.log(`\n=== ${path.basename(file)} ===`);
    console.log(result.lines.map((line, index) => `L${index + 1}: ${line}`).join('\n'));
    console.log(`耗时 ${times.map(value => value.toFixed(0)).join(' / ')} ms（中位 ${times[1].toFixed(0)}ms）`);
  }
})().catch(error => {
  console.error('失败：', error);
  process.exit(1);
});
