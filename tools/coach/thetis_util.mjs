// THETIS 자료를 다루는 공통 함수(학습 자료 만들기·재기에서 같이 쓴다).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const JS = path.join(HERE, '..', '..', 'app', 'static', 'coach', 'js');

// 12종류 → 학습에 쓰는 이름
export const THETIS_LABEL = { backhand: 'bh1', backhand2hands: 'bh2', backhand_slice: 'bhslice', backhand_volley: 'bvolley', forehand_flat: 'fh', forehand_openstands: 'fh',
  forehand_slice: 'fhslice', forehand_volley: 'fvolley', flat_service: 'serve', kick_service: 'serve', slice_service: 'serve', smash: 'smash' };
// 12종류 → 앱이 부르는 [종류, 세부 종류]
export const THETIS_WANT = { backhand: ['backhand', null], backhand2hands: ['backhand', null], backhand_slice: ['backhand', null], backhand_volley: ['backhand', 'volley'],
  forehand_flat: ['forehand', null], forehand_openstands: ['forehand', null], forehand_slice: ['forehand', null], forehand_volley: ['forehand', 'volley'],
  flat_service: ['serve', null], kick_service: ['serve', null], slice_service: ['serve', null], smash: ['serve', null] };

/** <폴더>/<종류>__<사람>_<...>_s<회차>.json 목록 */
export function listClips(dir) {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => { const [cls, name] = f.replace(/\.json$/, '').split('__'); return { f, cls, who: name.split('_')[0] }; })
    .filter((c) => THETIS_LABEL[c.cls]).sort((a, b) => (a.f < b.f ? -1 : 1));
}

export function loadClip(c, dir, { cleanFrames, G }) {
  if (!c.frames) { const d = JSON.parse(fs.readFileSync(path.join(dir, c.f), 'utf8')); c.frames = cleanFrames(d.frames.filter(G.validPose), d.width / d.height); }
  return c.frames;
}

/**
 * 사람별 치는 손(영상 기준). THETIS 영상은 좌우가 거울처럼 뒤집혀 있어(대부분 왼손잡이처럼 보인다) 자료에 적힌 손이 없다.
 * 세 가지를 모아 투표한다: ① 한 손으로 치는 영상에서 화면에서 더 많이 움직인 손목 ② 서브·스매시에서 손목이 코보다 위에 있는 동안 더 빨랐던 손목
 * ③ 포핸드(플랫·오픈)에서 3차원 손목 최고 속도가 더 큰 쪽. 프레임을 직접 보고 확인한 사람(p2·p9·p31)도 이 투표와 맞았다.
 * 돌려주는 것: { p1: { hand: 'L'|'R', votes: [L, R] }, … }
 */
export function inferHands(clips, dir, { cleanFrames, wristSpeed, G }) {
  const P = {};
  for (const c of clips) {
    const fr = loadClip(c, dir, { cleanFrames, G });
    if (fr.length < 20) continue;
    const v = (P[c.who] ||= [0, 0]);
    if (c.cls !== 'backhand2hands') {
      const mv = [0, 0];
      for (let i = 1; i < fr.length; i++) for (const [k, j] of [[0, 15], [1, 16]]) mv[k] += Math.hypot(fr[i].lm[j][0] - fr[i - 1].lm[j][0], fr[i].lm[j][1] - fr[i - 1].lm[j][1]);
      if (Math.max(...mv) > 1.25 * Math.min(...mv)) v[mv[1] >= mv[0] ? 1 : 0]++;
    }
    const vL = wristSpeed(fr, 'L'), vR = wristSpeed(fr, 'R');
    if (/service|smash/.test(c.cls)) {
      const hi = [0, 0];
      for (let i = 0; i < fr.length; i++) { if (fr[i].w[15][1] < fr[i].w[0][1]) hi[0] = Math.max(hi[0], vL[i]); if (fr[i].w[16][1] < fr[i].w[0][1]) hi[1] = Math.max(hi[1], vR[i]); }
      if (Math.max(...hi) > 1.3 * Math.min(...hi) && Math.max(...hi) > 2) v[hi[1] >= hi[0] ? 1 : 0]++;
    }
    if (/forehand_flat|forehand_openstands/.test(c.cls)) { const a = Math.max(...vL), b = Math.max(...vR); if (Math.max(a, b) > 1.3 * Math.min(a, b)) v[b >= a ? 1 : 0]++; }
  }
  return Object.fromEntries(Object.entries(P).map(([w, v]) => [w, { hand: v[1] > v[0] ? 'R' : 'L', votes: v }]));
}
