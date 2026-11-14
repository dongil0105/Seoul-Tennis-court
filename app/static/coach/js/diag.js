// 스윙 코치 — 진단 파일. 분석이 틀렸을 때 '뼈대 숫자'와 설정만 담아 내보낸다.
// 영상, 얼굴, 파일 이름은 담지 않는다. 사용자가 직접 저장한 파일을 직접 건네줄 때만 밖으로 나간다(서버로 보내지 않는다).
// DOM 을 쓰지 않는다(브라우저·Node 공용).
//
// 담는 관절(19개): 코·두 귀·어깨·팔꿈치·손목·골반·무릎·발목·발뒤꿈치·발끝. 손가락·눈·입은 뺀다(용량).
export const DIAG_KEEP = [0, 7, 8, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
const MAX_SHOTS = 40, MAX_FRAMES = 9000;                 // 파일이 너무 커지지 않게(대략 8MB 안쪽)
const r = (x, n) => (Number.isFinite(x) ? Math.round(x * n) / n : null);

/** 자세 프레임 줄 → 숫자 배열(시각, 화면 좌표·보인 정도, 3차원 좌표) */
export function packFrames(frames) {
  return {
    t: frames.map((f) => r(f.t, 1000)),
    lm: frames.map((f) => DIAG_KEEP.flatMap((j) => [r(f.lm[j][0], 10000), r(f.lm[j][1], 10000), r(f.lm[j][3] ?? 1, 100)])),
    w: frames.map((f) => DIAG_KEEP.flatMap((j) => [r(f.w[j][0], 1000), r(f.w[j][1], 1000), r(f.w[j][2], 1000)])),
  };
}

/** packFrames 의 반대: 엔진이 읽는 33관절 프레임으로 되돌린다(뺀 관절은 가까운 관절로 채운다: 손가락 → 손목, 눈·입 → 코) */
export function unpackFrames(p) {
  const near = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 9: 0, 10: 0, 17: 15, 19: 15, 21: 15, 18: 16, 20: 16, 22: 16 };
  return p.t.map((t, i) => {
    const lm = new Array(33), w = new Array(33);
    DIAG_KEEP.forEach((j, k) => {
      lm[j] = [p.lm[i][3 * k], p.lm[i][3 * k + 1], p.w[i][3 * k + 2], p.lm[i][3 * k + 2]];
      w[j] = [p.w[i][3 * k], p.w[i][3 * k + 1], p.w[i][3 * k + 2], p.lm[i][3 * k + 2]];
    });
    for (const [j, from] of Object.entries(near)) { lm[j] = lm[from].slice(); w[j] = w[from].slice(); }
    return { t, lm, w };
  });
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o && o[k] !== undefined).map((k) => [k, typeof o[k] === 'number' ? r(o[k], 1000) : o[k]]));

/**
 * 진단 파일의 내용을 만든다.
 * o = { profile, opt, vids: [{ meta: {duration,width,height}, t0, t1, single }], shots: [앱의 샷], note(사용자가 적은 말), app(화면 파일 버전) }
 */
export function buildDiag(o) {
  const tracks = [], seen = new Map();
  let total = 0, cut = false;
  const shots = [];
  for (const s of (o.shots || []).slice(0, MAX_SHOTS)) {
    // 짧은 영상은 샷들이 같은 프레임 줄을 함께 쓴다 → 한 번만 담는다
    let track = seen.get(s.frames);
    if (track === undefined) {
      if (total + s.frames.length > MAX_FRAMES) { cut = true; continue; }
      track = tracks.length; seen.set(s.frames, track); tracks.push(packFrames(s.frames)); total += s.frames.length;
    }
    const sw = s.swing || {};
    shots.push({
      track, vid: s.vid,
      stroke: sw.stroke, sub: sw.sub || null, auto: sw.auto, autoSub: sw.autoSub || null,
      fixed: sw.stroke !== sw.auto || (sw.sub || null) !== (sw.autoSub || null),          // fixed = 사용자가 종류를 바로잡았다(= 정답)
      ml: sw.ml ? { pf: r(sw.ml.pf, 1000), pb: r(sw.ml.pb, 1000), po: r(sw.ml.po, 1000), volley: r(sw.ml.volley, 1000), smash: r(sw.ml.smash, 1000) } : null,
      ...pick(sw, ['twoHanded', 'bh', 'by', 'side', 'sweep', 'together', 'upMax', 'fwdChest', 'acrossBody', 'gazeGo', 'suspect', 'uncertain',
        'view', 'tc', 'tcErr', 'peak', 'h', 'sf', 'sfAuto', 'hand', 'i0', 'i1', 'ip', 'ic']),
      keys: sw.keys ? pick(sw.keys, Object.keys(sw.keys)) : null,
      step: r(s.step, 10000), score: s.a ? s.a.score : null, result: s.result || null, serveType: s.serveType || null,
    });
  }
  const p = o.profile || {};
  return {
    kind: 'swing-coach-diag', v: 1, made: new Date().toISOString(), app: String(o.app || ''),
    note: String(o.note || '').slice(0, 600),
    profile: pick(p, ['hand', 'backhand', 'stance', 'heightCm', 'sex', 'level']),
    opt: pick(o.opt || {}, ['speed', 'serveType']),
    videos: (o.vids || []).map((v) => ({ duration: r(v.meta.duration, 100), width: v.meta.width, height: v.meta.height, t0: r(v.t0, 100), t1: r(v.t1, 100), single: !!v.single })),
    keep: DIAG_KEEP, cut, shots, tracks,
  };
}
