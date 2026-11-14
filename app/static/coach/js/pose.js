// 스윙 코치 — 브라우저에서 영상을 읽어 프레임마다 자세를 뽑는다(MediaPipe Pose, 기기 안에서만 돈다. 영상은 어디에도 올리지 않는다).
import { FilesetResolver, PoseLandmarker } from '../vendor/tasks-vision/vision_bundle.mjs';

const BASE = new URL('../vendor/', import.meta.url).href;
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
  const fileset = await FilesetResolver.forVisionTasks(`${BASE}tasks-vision/wasm`);
  const make = (d) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate: d },
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

/** 영상 파일을 <video> 로 열어 길이·크기를 안다. 열 수 없는 형식이면 오류. */
export function openVideo(video, file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const done = () => { cleanup(); resolve({ url, duration: video.duration, width: video.videoWidth, height: video.videoHeight }); };
    const fail = () => { cleanup(); URL.revokeObjectURL(url); reject(new Error('이 영상은 이 브라우저에서 열 수 없어요. 다른 영상으로 해 보세요.')); };
    const cleanup = () => { video.removeEventListener('loadeddata', done); video.removeEventListener('error', fail); };
    video.addEventListener('loadeddata', done);
    video.addEventListener('error', fail);
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    video.src = url;
    video.load();
  });
}

/** 영상의 한 시각으로 옮기고 그 화면이 준비될 때까지 기다린다 */
export function seek(video, t) {
  return new Promise((resolve) => {
    const tt = Math.min(Math.max(0, t), Math.max(0, (video.duration || 0) - 0.001));
    if (Math.abs(video.currentTime - tt) < 1e-4 && video.readyState >= 2) { resolve(); return; }
    let finished = false;
    const done = () => { if (finished) return; finished = true; video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
    const timer = setTimeout(done, 1500);                     // 어떤 기기는 seeked 를 안 보낸다
    video.addEventListener('seeked', done);
    video.currentTime = tt;
  });
}

/** 초당 프레임 수를 어림한다: 잠깐 재생해 보며 화면이 바뀌는 간격을 잰다. 못 재면 30. */
export async function measureFps(video) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) return 30;
  const times = [];
  await seek(video, Math.min(0.2, (video.duration || 1) / 4));
  await new Promise((resolve) => {
    let n = 0;
    const stop = () => { video.pause(); resolve(); };
    const tick = (_now, meta) => { times.push(meta.mediaTime); if (++n >= 12) stop(); else video.requestVideoFrameCallback(tick); };
    video.requestVideoFrameCallback(tick);
    video.play().catch(stop);
    setTimeout(stop, 1500);
  });
  const d = [];
  for (let i = 1; i < times.length; i++) if (times[i] > times[i - 1]) d.push(times[i] - times[i - 1]);
  if (d.length < 4) return 30;
  d.sort((a, b) => a - b);
  const fps = 1 / d[d.length >> 1];
  return Math.min(120, Math.max(15, Math.round(fps)));
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
    await seek(video, t);
    const poses = detect(pl, video);
    const j = poses.length ? (pick ? pick(poses, t) : biggest(poses)) : -1;
    if (j >= 0) frames.push({ t, lm: poses[j].lm, w: poses[j].w });
    if (onProgress && (i % 3 === 0 || i === n - 1)) onProgress((i + 1) / n, frames.length);
    if (i % 8 === 7) await new Promise((r) => setTimeout(r, 0));   // 화면이 멈춘 것처럼 보이지 않게 숨을 돌린다
  }
  return frames;
}

/**
 * 긴 영상을 빠르게 훑는다: 재생하면서 화면이 바뀔 때마다 자세를 뽑는다(인식이 따라가는 만큼만).
 * 재생 중 화면 콜백을 못 쓰는 브라우저에서는 일정 간격으로 옮겨 가며 뽑는다.
 */
export async function scan(video, pl, { t0 = 0, t1 = video.duration, rate = 2, pick, onProgress, signal, fallbackStep = 1 / 12 } = {}) {
  if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)) {
    return extract(video, pl, { t0, t1, step: fallbackStep, pick, onProgress, signal });
  }
  const frames = [];
  await seek(video, t0);
  video.playbackRate = rate;
  await new Promise((resolve, reject) => {
    let ended = false;
    const finish = (err) => { if (ended) return; ended = true; video.pause(); video.playbackRate = 1; err ? reject(err) : resolve(); };
    const tick = (_now, meta) => {
      if (ended) return;
      if (signal && signal.aborted) { finish(new DOMException('aborted', 'AbortError')); return; }
      const t = meta.mediaTime;
      if (t >= t1 || video.ended) { finish(); return; }
      const poses = detect(pl, video);
      const j = poses.length ? (pick ? pick(poses, t) : biggest(poses)) : -1;
      if (j >= 0 && (!frames.length || t > frames[frames.length - 1].t)) frames.push({ t, lm: poses[j].lm, w: poses[j].w });
      if (onProgress) onProgress(Math.min(1, (t - t0) / Math.max(0.01, t1 - t0)), frames.length);
      video.requestVideoFrameCallback(tick);
    };
    video.addEventListener('ended', () => finish(), { once: true });
    video.requestVideoFrameCallback(tick);
    video.play().catch((e) => finish(e));
  });
  return frames;
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
