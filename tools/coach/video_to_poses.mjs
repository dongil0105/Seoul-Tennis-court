#!/usr/bin/env node
// 영상 → 프레임마다 자세(가장 크게 나온 사람 한 명) → JSON 한 파일. 기준 '움직임' 데이터와 엔진 시험에 쓴다.
//   node tools/coach/video_to_poses.mjs --video clip.webm --out seq.json [--fps 30] [--model full|lite|path] [--height 720]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const a = { fps: '30', model: 'full', height: '720', poses: '1' };
const v = process.argv.slice(2);
for (let i = 0; i < v.length; i += 2) a[v[i].replace(/^--/, '')] = v[i + 1];
if (!a.video || !a.out) { console.error('usage: video_to_poses.mjs --video x --out seq.json [--fps 30] [--model full] [--height 720]'); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poses-'));
try {
  execFileSync('ffmpeg', ['-v', 'error', '-i', a.video, '-vf', `fps=${a.fps},scale=-2:'min(${a.height},ih)'`, '-q:v', '3', path.join(tmp, 'f_%06d.jpg')]);
  const files = fs.readdirSync(tmp).filter((f) => f.endsWith('.jpg')).sort();
  fs.writeFileSync(path.join(tmp, 'list.txt'), files.map((f) => path.join(tmp, f)).join('\n'));
  execFileSync('node', [path.join(HERE, 'pose_extract.mjs'), '--in', path.join(tmp, 'list.txt'), '--out', path.join(tmp, 'out.jsonl'),
    '--model', a.model, '--poses', a.poses, '--mode', 'video', '--fps', a.fps], { stdio: ['ignore', 'ignore', 'inherit'] });
  const fps = Number(a.fps);
  const frames = [];
  let W = 0, H = 0;
  fs.readFileSync(path.join(tmp, 'out.jsonl'), 'utf8').split('\n').filter(Boolean).forEach((line, i) => {
    const r = JSON.parse(line);
    W = r.w || W; H = r.h || H;
    if (!r.lm || !r.lm.length) return;
    let best = 0, bestH = -1;                                  // 가장 크게 나온 사람
    r.lm.forEach((p, j) => { const ys = p.map((k) => k[1]); const hh = Math.max(...ys) - Math.min(...ys); if (hh > bestH) { bestH = hh; best = j; } });
    frames.push({ t: i / fps, lm: r.lm[best], w: r.world[best] });
  });
  fs.writeFileSync(a.out, JSON.stringify({ video: path.basename(a.video), width: W, height: H, fps, frames }));
  console.error(`${path.basename(a.video)}: ${files.length}프레임 중 ${frames.length}프레임에서 사람을 찾음 → ${a.out}`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
