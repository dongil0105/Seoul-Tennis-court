#!/usr/bin/env node
// 사진(또는 영상에서 뽑은 프레임)에서 자세 랜드마크를 뽑는 도구 — 앱과 똑같은 MediaPipe(브라우저 wasm)를 헤드리스 크롬으로 돌린다.
// 기준 자세 데이터(선수 사진)를 만들 때와 테스트에 같이 쓴다. 결과는 한 줄에 사진 한 장(JSONL).
//
//   node tools/coach/pose_extract.mjs --in list.txt --out poses.jsonl [--model full|lite|/abs/path.task] [--poses 2]
//   list.txt: 한 줄에 파일 경로 하나(뒤에 탭으로 아무 메모나 붙여도 된다 — 그대로 결과의 meta 로 간다)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COACH = path.resolve(HERE, '../../app/static/coach');
const MIME = { '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.task': 'application/octet-stream',
  '.html': 'text/html', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.json': 'application/json' };

function args() {
  const a = { model: 'full', poses: 1, conf: 0.5 };
  const v = process.argv.slice(2);
  for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
  if (!a.in || !a.out) { console.error('usage: pose_extract.mjs --in list.txt --out out.jsonl [--model full|lite|path] [--poses n]'); process.exit(2); }
  return a;
}

const PAGE = `<!doctype html><meta charset="utf-8"><script type="module">
import { FilesetResolver, PoseLandmarker } from '/coach/vendor/tasks-vision/vision_bundle.mjs';
const q = new URLSearchParams(location.search);
const fileset = await FilesetResolver.forVisionTasks('/coach/vendor/tasks-vision/wasm');
const pl = await PoseLandmarker.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: q.get('model'), delegate: 'CPU' },
  runningMode: 'IMAGE', numPoses: Number(q.get('poses') || 1),
  minPoseDetectionConfidence: Number(q.get('conf') || 0.5), minPosePresenceConfidence: 0.5,
});
const r4 = (x) => Math.round(x * 1e4) / 1e4;
const pack = (ps) => ps.map((p) => p.map((k) => [r4(k.x), r4(k.y), r4(k.z), r4(k.visibility ?? 0)]));
window.detect = async (url) => {
  const img = new Image(); img.src = url; await img.decode();
  const r = pl.detect(img);
  return { w: img.naturalWidth, h: img.naturalHeight, lm: pack(r.landmarks), world: pack(r.worldLandmarks) };
};
window.ready = true;
</script>`;

const a = args();
const modelPath = a.model === 'full' || a.model === 'lite'
  ? path.join(COACH, 'vendor/models', `pose_landmarker_${a.model}.task`) : path.resolve(a.model);
const items = fs.readFileSync(a.in, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { const [p, ...m] = l.split('\t'); return { file: path.resolve(p), meta: m.join('\t') }; });

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  let file = null;
  if (u.pathname === '/harness') { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(PAGE); return; }
  if (u.pathname === '/model') file = modelPath;
  else if (u.pathname === '/img') file = items[Number(u.searchParams.get('i'))]?.file;
  else if (u.pathname.startsWith('/coach/')) {
    file = path.join(COACH, decodeURIComponent(u.pathname.slice(7)));
    if (!file.startsWith(COACH)) file = null;
  }
  if (!file || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('page error:', e.message));
await page.goto(`${base}/harness?model=/model&poses=${a.poses}&conf=${a.conf}`);
await page.waitForFunction('window.ready === true', null, { timeout: 120000 });

const out = fs.createWriteStream(a.out);
let ok = 0, none = 0, bad = 0;
const t0 = Date.now();
for (let i = 0; i < items.length; i++) {
  let rec;
  try {
    const r = await page.evaluate((u) => window.detect(u), `${base}/img?i=${i}`);
    rec = { file: items[i].file, meta: items[i].meta, ...r };
    if (r.lm.length) ok++; else none++;
  } catch (e) { rec = { file: items[i].file, meta: items[i].meta, error: String(e.message || e).slice(0, 200) }; bad++; }
  out.write(JSON.stringify(rec) + '\n');
  if ((i + 1) % 50 === 0) console.error(`${i + 1}/${items.length}  사람 찾음 ${ok} · 못 찾음 ${none} · 오류 ${bad}`);
}
await new Promise((r) => out.end(r));
await browser.close(); server.close();
console.error(`끝: ${items.length}장 · 사람 찾음 ${ok} · 못 찾음 ${none} · 오류 ${bad} · ${((Date.now() - t0) / 1000).toFixed(1)}초`);
