// 持续屏幕画面流：只建立一次系统级捕获会话（DXGI / WGC），之后靠 GPU 出帧，
// 不再像以前那样每隔一秒做一次全屏截屏 → 读回 CPU，避免周期性打断合成导致鼠标卡顿。
// 画面有变化时才裁剪出框选区域，压缩后交给主进程做 OCR。
(() => {
  const api = window.psOrb;
  const video = document.getElementById('src');
  if (!api || !api.onCaptureStart || !video) return;

  const DETECT_WIDTH = 64;
  const DIFF_THRESHOLD = 0.02;
  const SEND_COOLDOWN = 320;
  const TICK = 260;
  const HEARTBEAT = 2000;

  const detector = document.createElement('canvas');
  const grabber = document.createElement('canvas');

  let config = null;
  let stream = null;
  let timer = null;
  let lastSignature = null;
  let lastSentAt = 0;
  let lastBeatAt = 0;
  let sending = false;

  function fail(reason) {
    api.captureFailed(reason);
    if (timer) clearInterval(timer);
    timer = null;
  }

  // region 是 DIP 屏幕坐标，换算成视频里的像素矩形
  function regionRect() {
    const width = video.videoWidth || Math.round(config.displayWidth * config.scale);
    const height = video.videoHeight || Math.round(config.displayHeight * config.scale);
    const ratioX = width / Math.max(1, config.displayWidth);
    const ratioY = height / Math.max(1, config.displayHeight);
    const region = config.region;
    const x = Math.max(0, Math.round((region.x - config.origin.x) * ratioX));
    const y = Math.max(0, Math.round((region.y - config.origin.y) * ratioY));
    const w = Math.min(width - x, Math.max(8, Math.round(region.width * ratioX)));
    const h = Math.min(height - y, Math.max(8, Math.round(region.height * ratioY)));
    return { x, y, width: w, height: h };
  }

  function signature(rect) {
    const height = Math.max(4, Math.round((rect.height / Math.max(1, rect.width)) * DETECT_WIDTH));
    detector.width = DETECT_WIDTH;
    detector.height = height;
    const ctx = detector.getContext('2d', { alpha: false, willReadFrequently: true });
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, DETECT_WIDTH, height);
    return ctx.getImageData(0, 0, DETECT_WIDTH, height).data;
  }

  function diffRatio(previous, next) {
    if (!previous || !next || previous.length !== next.length) return 1;
    const pixels = next.length / 4;
    let changed = 0;
    for (let index = 0; index < next.length; index += 4) {
      const delta =
        Math.abs(next[index] - previous[index]) +
        Math.abs(next[index + 1] - previous[index + 1]) +
        Math.abs(next[index + 2] - previous[index + 2]);
      if (delta > 36) changed += 1;
    }
    return changed / pixels;
  }

  async function send(rect) {
    grabber.width = rect.width;
    grabber.height = rect.height;
    const ctx = grabber.getContext('2d', { alpha: false });
    ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, rect.width, rect.height);
    const blob = await new Promise(resolve => grabber.toBlob(resolve, 'image/jpeg', 0.92));
    if (!blob) return;
    const buffer = new Uint8Array(await blob.arrayBuffer());
    api.pushCaptureFrame(buffer);
  }

  async function tick() {
    if (!config || sending || video.readyState < 2) return;
    const now = Date.now();
    // 心跳：画面静止时也要告诉主进程“流还活着”，避免被判定为失效
    if (now - lastBeatAt > HEARTBEAT) {
      lastBeatAt = now;
      api.pushCaptureFrame(new Uint8Array(0));
    }

    let rect;
    let signatureNow;
    try {
      rect = regionRect();
      signatureNow = signature(rect);
    } catch {
      return;
    }
    // 变化太小：不更新基准，让缓慢变化累积
    if (diffRatio(lastSignature, signatureNow) < DIFF_THRESHOLD) return;
    if (now - lastSentAt < SEND_COOLDOWN) return;
    lastSignature = signatureNow;
    lastSentAt = now;
    sending = true;
    try {
      await send(rect);
    } catch {
      /* 单帧失败忽略，下一帧继续 */
    } finally {
      sending = false;
    }
  }

  async function start(payload) {
    if (!payload || !payload.sourceId) {
      fail('no-source');
      return;
    }
    const reuse = Boolean(stream) && config?.sourceId === payload.sourceId;
    config = payload;
    lastSignature = null;
    lastSentAt = 0;
    if (reuse) {
      // 只是换了框选范围：复用现有捕获流，避免重新初始化
      if (timer) clearInterval(timer);
      timer = setInterval(tick, sampleTick(payload.interval));
      return;
    }
    if (timer) clearInterval(timer);
    try {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
      }
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: payload.sourceId,
            maxWidth: Math.round(payload.displayWidth * payload.scale),
            maxHeight: Math.round(payload.displayHeight * payload.scale),
            maxFrameRate: 15
          }
        }
      });
    } catch (error) {
      fail(`getUserMedia:${error?.message || error}`);
      return;
    }
    video.srcObject = stream;
    try {
      await video.play();
    } catch (error) {
      fail(`play:${error?.message || error}`);
      return;
    }
    timer = setInterval(tick, sampleTick(payload.interval));
    tick();
  }

  // 每帧只做很轻的差异检测，取样频率约为识别间隔的 1/3，换台词时反应更快
  function sampleTick(interval) {
    const value = Number(interval);
    if (!Number.isFinite(value) || value <= 0) return TICK;
    return Math.min(800, Math.max(200, Math.round(value / 3)));
  }

  api.onCaptureStart(start);
})();
