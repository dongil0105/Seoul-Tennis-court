// 스윙 코치 — 브라우저에서 영상을 읽어 프레임마다 자세를 뽑는다(MediaPipe Pose, 기기 안에서만 돈다. 영상은 어디에도 올리지 않는다).
import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs?v=1.2.3-1';   // 엔진·모델과 같은 버전 표시(아래 VER)

const BASE = new URL('../vendor/', import.meta.url).href;
const VER = '1.2.3-1';            // vendor 파일을 바꾸면 이 값도 바꾼다(휴대폰이 오래 보관한 옛 파일을 쓰지 않게)
const cache = new Map();

let delegate = null;          // 한 번 정하면 계속 쓴다: 'GPU' | 'CPU'

/**
 * 자세 인식기. model 'full'(정밀) | 'lite'(빠름), poses = 한 화면에서 찾을 사람 수.
 * probe(사람이 보이는 화면의 <video>)를 주면 그래픽 가속(GPU)과 CPU 를 실제로 몇 번 돌려 보고 빠른 쪽을 고른다.
 * (휴대폰은 대개 GPU 가 빠르지만, 가속이 흉내만 내는 기기에서는 CPU 가 몇 배 빠르다.)
 */
export async function getPose({ model = 'full', poses = 1, probe = null } = {}) {
  const key = `${model}:${poses}`;
  if (cache.has(key)) return cache.get(key);
  void FilesetResolver;
  const fileset = { wasmLoaderPath: `${BASE}tasks-vision/wasm/vision_wasm_internal.js?v=${VER}`, wasmBinaryPath: `${BASE}tasks-vision/wasm/vision_wasm_internal.wasm?v=${VER}` };
  const make = (d) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task?v=${VER}`, delegate: d },
    runningMode: 'VIDEO', numPoses: poses,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  const time = (pl) => {
    try {
      detect(pl, probe);                                          // 첫 번째는 준비 시간이 섞여 있어 버린다
      const t0 = performance.now();
      detect(pl, probe); detect(pl, probe);
      return (performance.now() - t0) / 2;
    } catch (_) { return Infinity; }
  };
  let pl = null;
  if (delegate === 'CPU') pl = await make('CPU');
  else {
    try { pl = await make('GPU'); } catch (_) { pl = null; }
    if (!pl) { pl = await make('CPU'); delegate = 'CPU'; }
    else if (!delegate && probe && probe.readyState >= 2) {
      const g = time(pl);
      if (g > 80) {                                               // 느리면 CPU 와 겨뤄 본다
        let c = null, ct = Infinity;
        try { c = await make('CPU'); ct = time(c); } catch (_) { c = null; }
        if (c && ct < g * 0.8) { try { pl.close(); } catch (_) { /* 닫기 실패는 무시 */ } pl = c; delegate = 'CPU'; }
        else { if (c) { try { c.close(); } catch (_) { /* 무시 */ } } delegate = 'GPU'; }
      } else delegate = 'GPU';
    }
  }
  cache.set(key, pl);
  return pl;
}
export const usedDelegate = () => delegate;

const pack = (ps) => ps.map((p) => p.map((k) => [k.x, k.y, k.z, k.visibility ?? 0]));
let lastTs = 0;
/** 지금 화면(영상·캔버스)의 자세들. 돌려주는 것: [{lm, w}] (사람마다). 시각은 늘 앞으로만 가야 해서 안에서 맞춘다. */
export function detect(pl, source) {
  lastTs = Math.max(lastTs + 1, Math.round(performance.now()));
  const r = pl.detectForVideo(source, lastTs);
  const lm = pack(r.landmarks), w = pack(r.worldLandmarks);
  return lm.map((p, i) => ({ lm: p, w: w[i] }));
}

let openToken = 0;
/**
 * 영상 파일(또는 이미 만들어 둔 주소)을 <video> 로 열어 길이·크기를 안다. 열 수 없는 형식이거나 20초 안에 준비되지 않으면 오류.
 * 연달아 고르면 앞의 것은 '취소됨'으로 끝난다(뒤의 영상 이벤트를 앞의 것이 가로채지 않게).
 */
export function openVideo(video, file) {
  const token = ++openToken;
  return new Promise((resolve, reject) => {
    const own = typeof file !== 'string';                        // 문자열이면 이미 만들어 둔 주소(여러 영상을 오갈 때)
    const url = own ? URL.createObjectURL(file) : file;
    let settled = false;
    const end = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearInterval(poll);
      for (const ev of ['loadeddata', 'canplay', 'loadedmetadata']) video.removeEventListener(ev, check);
      video.removeEventListener('error', onErr);
      if (err) { if (own) URL.revokeObjectURL(url); reject(err); return; }
      const info = { url, duration: video.duration, width: video.videoWidth, height: video.videoHeight };
      // 아이폰 사파리는 한 번도 재생하지 않은 영상을 캔버스에 그리지 못할 때가 있다 → 소리 없이 잠깐 재생했다 멈춘다(실패해도 그대로 진행)
      let done = false;
      const go = () => { if (done) return; done = true; try { video.pause(); } catch (_) { /* 무시 */ } resolve(info); };
      try { const pr = video.play(); if (pr && pr.then) pr.then(go, go); else go(); } catch (_) { go(); }
      setTimeout(go, 800);
    };
    const check = () => {
      if (token !== openToken) { end(new DOMException('다른 영상을 골랐습니다', 'AbortError')); return; }
      if (video.readyState >= 2 && video.videoWidth > 0 && Number.isFinite(video.duration)) end();
    };
    const onErr = () => end(new Error('이 영상은 이 브라우저에서 열 수 없어요. 다른 영상으로 해 보세요.'));
    const timer = setTimeout(() => end(new Error('영상을 여는 데 너무 오래 걸려요. 더 짧은 영상으로 해 보세요.')), 20000);
    const poll = setInterval(check, 250);                      // 어떤 휴대폰은 loadeddata 를 안 보낸다
    const kick = () => {                                       // 아이폰은 재생 전에는 첫 화면을 읽지 않을 때가 있다 → 살짝 옮기고 재생을 걸어 깨운다
      try { if (video.currentTime === 0) video.currentTime = 0.001; } catch (_) { /* 무시 */ }
      try { const pr = video.play(); if (pr && pr.then) pr.then(() => video.pause(), () => {}); } catch (_) { /* 무시 */ }
    };
    video.addEventListener('loadedmetadata', kick, { once: true });
    for (const ev of ['loadeddata', 'canplay', 'loadedmetadata']) video.addEventListener(ev, check);
    video.addEventListener('error', onErr);
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = url;
    video.load();
  });
}

// 영상 위치 옮기기는 한 번에 하나씩만 한다. 화면 여러 곳이 같은 <video> 를 쓰므로, 겹치면 서로의 화면을 덮어쓴다.
let seekChain = Promise.resolve();
function seekNow(video, t) {
  return new Promise((resolve) => {
    const tt = Math.min(Math.max(0, t), Math.max(0, (video.duration || 0) - 0.001));
    if (Math.abs(video.currentTime - tt) < 1e-4 && video.readyState >= 2 && !video.seeking) { resolve(true); return; }
    let finished = false;
    const done = (ok) => { if (finished) return; finished = true; video.removeEventListener('seeked', onSeeked); clearTimeout(timer); resolve(ok); };
    const onSeeked = () => done(Math.abs(video.currentTime - tt) < 0.25);
    const timer = setTimeout(() => done(!video.seeking && Math.abs(video.currentTime - tt) < 0.25), 2500);   // seeked 를 안 보내는 기기
    video.addEventListener('seeked', onSeeked);
    try { video.currentTime = tt; } catch (_) { done(false); }
  });
}
/** 영상의 한 시각으로 옮기고 그 화면이 준비될 때까지 기다린다. 돌려주는 값: 그 화면이 맞게 준비됐으면 true. */
export function seek(video, t) {
  const run = seekChain.then(() => seekNow(video, t));
  seekChain = run.catch(() => false);
  return run;
}

/**
 * 초당 프레임 수를 어림한다: 잠깐 재생해 보며 화면이 바뀌는 간격을 잰다. 못 재면 30.
 * (화면 주사율보다 촘촘한 영상은 주사율까지만 잡힌다 — 그 간격으로 읽으면 충분하다.)
 */
export async function measureFps(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  const times = [];
  await seek(video, Math.min(0.2, (video.duration || 1) / 4));
  await new Promise((resolve) => {
    let stopped = false, handle = 0;
    const stop = () => {
      if (stopped) return;
      stopped = true; clearTimeout(timer);
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      video.pause(); resolve();
    };
    const tick = (_now, meta) => { if (stopped) return; times.push(meta.mediaTime); if (times.length >= 14) stop(); else handle = video.requestVideoFrameCallback(tick); };
    const timer = setTimeout(stop, 1500);
    handle = video.requestVideoFrameCallback(tick);
    video.play().catch(stop);
  });
  const d = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (d.length < 4) return 30;
  d.sort((a, b) => a - b);
  return Math.min(120, Math.max(15, Math.round(1 / d[d.length >> 1])));
}

/**
 * 구간 [t0,t1] 을 step 초 간격으로 한 장씩 옮겨 가며 자세를 뽑는다(스윙 한 번을 정밀하게 볼 때).
 * pick(poses, t) 로 여러 사람 중 누구를 쓸지 고른다(안 주면 가장 크게 나온 사람). 돌려주는 것: [{t, lm, w}]
 */
export async function extract(video, pl, { t0 = 0, t1 = video.duration, step = 1 / 30, pick, onProgress, signal } = {}) {
  const frames = [];
  const n = Math.max(1, Math.floor((t1 - t0) / step) + 1);
  for (let i = 0; i < n; i++) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const t = t0 + i * step;
    if (!(await seek(video, t))) continue;                     // 그 화면이 준비되지 않았으면 건너뛴다(다른 순간의 자세를 붙이지 않는다)
    const poses = detect(pl, video);
    const j = poses.length ? (pick ? pick(poses, t) : biggest(poses)) : -1;
    if (j >= 0) frames.push({ t, lm: poses[j].lm, w: poses[j].w });
    if (onProgress && (i % 3 === 0 || i === n - 1)) onProgress((i + 1) / n, frames.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));   // 화면이 멈춘 것처럼 보이지 않게 숨을 돌린다
  }
  return frames;
}

/**
 * 긴 영상을 빠르게 훑는다: 재생하면서 화면이 바뀔 때마다 자세를 뽑아 sink(frame) 으로 넘긴다(배열로 쌓아 두지 않는다 — 긴 영상의 메모리).
 * minGap 초보다 촘촘한 화면은 건너뛴다. 재생 중 화면 콜백을 못 쓰는 브라우저에서는 일정 간격으로 옮겨 가며 뽑는다.
 * 취소·추론 오류·재생이 멈춘 경우 모두 한 곳(finish)에서 정리한다.
 */
export async function scan(video, pl, { t0 = 0, t1 = video.duration, rate = 2, pick, sink, onProgress, signal, minGap = 1 / 15 } = {}) {
  const push = (t, poses) => {
    const j = poses.length ? (pick ? pick(poses, t) : biggest(poses)) : -1;
    if (j >= 0) sink({ t, lm: poses[j].lm, w: poses[j].w });
  };
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    for (let t = t0; t <= t1; t += Math.max(minGap, 1 / 12)) {
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      if (await seek(video, t)) push(t, detect(pl, video));
      if (onProgress) onProgress(Math.min(1, (t - t0) / Math.max(0.01, t1 - t0)));
      await new Promise((r) => setTimeout(r, 0));
    }
    return t1;
  }
  await seek(video, t0);
  let reached = t0;                                            // 실제로 읽은 마지막 시각(중간에 멈췄는지 알려 주려고)
  await new Promise((resolve, reject) => {
    let ended = false, handle = 0, last = -1, lastTick = performance.now(), cost = 0.03;
    const finish = (err) => {
      if (ended) return;
      ended = true;
      clearInterval(watch);
      if (handle && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      if (signal) signal.removeEventListener('abort', onAbort);
      video.removeEventListener('ended', onEnded);
      video.pause(); video.playbackRate = 1;
      if (err) reject(err); else resolve();
    };
    const onAbort = () => finish(new DOMException('aborted', 'AbortError'));
    const onEnded = () => { reached = t1; finish(); };
    // 화면 콜백이 5초 넘게 안 오면(재생이 멈춘 기기) 다시 재생을 걸어 보고, 그래도 안 오면 거기까지로 끝낸다
    let nudged = false;
    const watch = setInterval(() => {
      if (performance.now() - lastTick < 5000) return;
      if (!nudged) { nudged = true; lastTick = performance.now(); video.play().catch(() => finish()); } else finish();
    }, 1000);
    const tick = (_now, meta) => {
      if (ended) return;
      lastTick = performance.now(); nudged = false;
      try {
        const t = meta.mediaTime;
        reached = Math.max(reached, t);
        if (t >= t1 || video.ended) { reached = t1; finish(); return; }
        if (t - last >= minGap) {
          last = t;
          const c0 = performance.now();
          push(t, detect(pl, video));
          cost = cost * 0.8 + ((performance.now() - c0) / 1000) * 0.2;        // 한 장 읽는 데 걸리는 시간(이동 평균)
          // 느린 기기에서는 천천히 재생해 촘촘히 읽고, 빠른 기기에서는 최대 3배속까지
          const want = Math.min(Math.max(rate, 3), Math.max(0.5, 0.07 / Math.max(cost, 0.005)));
          if (Math.abs(video.playbackRate - want) > 0.2) video.playbackRate = Math.round(want * 4) / 4;
        }
        if (onProgress) onProgress(Math.min(1, (t - t0) / Math.max(0.01, t1 - t0)));
        handle = video.requestVideoFrameCallback(tick);
      } catch (e) { finish(e); }
    };
    if (signal) { if (signal.aborted) { onAbort(); return; } signal.addEventListener('abort', onAbort); }
    video.addEventListener('ended', onEnded);
    video.playbackRate = rate;
    handle = video.requestVideoFrameCallback(tick);
    video.play().catch((e) => finish(e));
  });
  return reached;
}

/**
 * 한 사람을 계속 따라가는 고르개: 처음에는 가장 크게 나온 사람, 그다음부터는 방금 그 사람과 가장 가까운 사람.
 * (프레임마다 '가장 큰 사람'을 새로 고르면 크기가 비슷한 두 사람이 번갈아 잡혀 가짜 스윙이 생긴다.)
 */
export function sticky() {
  let prev = null;
  const center = (lm) => [(lm[11][0] + lm[12][0] + lm[23][0] + lm[24][0]) / 4, (lm[11][1] + lm[12][1] + lm[23][1] + lm[24][1]) / 4];
  return (poses) => {
    let j = -1;
    if (prev) { let bd = 0.22; poses.forEach((p, i) => { const c = center(p.lm), d = Math.hypot(c[0] - prev[0], c[1] - prev[1]); if (d < bd) { bd = d; j = i; } }); }
    if (j < 0) j = biggest(poses);
    if (j >= 0) prev = center(poses[j].lm);
    return j;
  };
}

/** 화면에서 가장 크게 나온 사람의 번호 */
export function biggest(poses) {
  let best = -1, bh = -1;
  poses.forEach((p, j) => {
    let lo = 9, hi = -9;
    for (const k of p.lm) { if (k[1] < lo) lo = k[1]; if (k[1] > hi) hi = k[1]; }
    if (hi - lo > bh) { bh = hi - lo; best = j; }
  });
  return best;
}
