#!/usr/bin/env python3
"""코치의 눈: 숙련자와 초보는 무엇이 다른가 — THETIS 실제 영상, 스트로크·국면별.

  python -u tools/coach/expert_vs_beginner.py cands.jsonl moment_model_chosen.json docs/coach/expert_vs_beginner.json
  (cands.jsonl = build_moment_cands.mjs, moment_model_chosen.json = train_moment.py 가 함께 적는 '영상마다 치는 순간')

영상마다 '치는 순간'으로 정한 후보의 움직임(15곳 × 44값)에서 코치가 보는 지표를 뽑아, 숙련자(p32~p55, 24명)와 초보(p1~p31, 31명)를 견준다.
차이의 크기는 표준화한 차이(d = 평균 차이 / 합친 표준편차). 사람마다 평균을 먼저 낸 뒤 사람 단위로 견준다(한 사람이 여러 번 친 것을 따로 세지 않는다).
"""
import collections
import json
import sys

import numpy as np

rows = []
chosen = json.load(open(sys.argv[2]))
for l in open(sys.argv[1], encoding="utf-8"):
    if '"src":"thetis"' not in l[:40] and '"src": "thetis"' not in l[:40]:
        continue
    r = json.loads(l)
    ct = chosen.get(r["clip"])
    if ct is not None and abs(r["t"] - ct) < 0.01:
        rows.append(r)
print(f"스윙 {len(rows)}개", flush=True)
STEPS = [-0.8, -0.7, -0.6, -0.5, -0.4, -0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
K = {round(s, 1): i for i, s in enumerate(STEPS)}
J = {n: i for i, n in enumerate(["nose", "sh", "el", "wr", "hip", "knee", "ank", "osh", "oel", "owr", "ohip", "oknee", "oank"])}
SIDE, UP, FWD = 0, 1, 2


def metrics(x, back):
    """back = 백핸드 쪽 스트로크(치는 어깨가 네트 쪽으로 돌았다가 풀린다 — 포핸드와 도는 방향이 반대)"""
    A = np.array(x, dtype=float).reshape(15, 44)
    pos = lambda j, c, dt: A[K[dt], J[j] * 3 + c]
    seg = lambda j, c, a, b: A[K[a]:K[b] + 1, J[j] * 3 + c]
    deg = lambda u: np.degrees(np.arcsin(np.clip(u, -1, 1)))
    sg = -1.0 if back else 1.0                                           # 감는 쪽을 +로: 포핸드는 치는 어깨가 뒤로, 백핸드는 앞으로
    sh, hip, v = -sg * deg(A[:, 39]), -sg * deg(A[:, 41]), A[:, 43]      # 감긴 각(도). 클수록 많이 감김
    hipH = -(A[:, J["ank"] * 3 + UP] + A[:, J["oank"] * 3 + UP]) / 2
    pre, T = slice(K[-0.8], K[-0.1] + 1), np.array(STEPS)
    m = {}
    m["테이크백: 어깨를 감은 각도(도)"] = sh[pre].max()
    m["테이크백: 골반을 감은 각도(도)"] = hip[pre].max()
    m["테이크백: 어깨-골반 꼬임(도)"] = (sh - hip)[pre].max()
    m["테이크백: 어깨를 다 감은 시각(초, 임팩트 기준)"] = T[pre][int(np.argmax(sh[pre]))]
    m["테이크백: 손목이 골반보다 뒤로 간 거리"] = -seg("wr", FWD, -0.8, -0.2).min()
    m["테이크백: 손목 높이(가장 높을 때)"] = seg("wr", UP, -0.8, -0.2).max()
    m["테이크백: 반대 손을 뻗은 거리"] = np.hypot(seg("owr", SIDE, -0.6, -0.2), seg("owr", FWD, -0.6, -0.2)).max()
    m["테이크백: 무릎 굽힘(골반이 낮아진 만큼)"] = hipH.max() - hipH[K[-0.6]:K[-0.1] + 1].min()
    m["임팩트: 손목 속도(키/초)"] = v[K[0]]
    m["임팩트: 직전 0.2초에 빨라진 정도"] = v[K[0]] - v[K[-0.2]]
    m["임팩트: 타점이 골반보다 앞에 있는 거리"] = pos("wr", FWD, 0)
    m["임팩트: 타점이 몸에서 옆으로 떨어진 거리"] = abs(pos("wr", SIDE, 0))
    m["임팩트: 타점 높이(골반 기준)"] = pos("wr", UP, 0)
    m["임팩트: 팔을 편 정도(어깨-손목 거리)"] = float(np.linalg.norm(A[K[0], J["wr"] * 3:J["wr"] * 3 + 3] - A[K[0], J["sh"] * 3:J["sh"] * 3 + 3]))
    m["임팩트: 어깨가 아직 감겨 있는 각도(도)"] = sh[K[0]]
    m["임팩트: 풀어 낸 어깨 회전(감은 데서 임팩트까지, 도)"] = sh[pre].max() - sh[K[0]]
    m["임팩트: 다리로 밀어 올림(골반이 올라온 만큼)"] = hipH[K[0]] - hipH[K[-0.6]:K[-0.1] + 1].min()
    m["임팩트: 머리 고정(앞뒤 0.2초 흔들림)"] = float(np.std(seg("nose", SIDE, -0.2, 0.2)) + np.std(seg("nose", FWD, -0.2, 0.2)) + np.std(seg("nose", UP, -0.2, 0.2)))
    m["피니시: 어깨가 돈 전체 폭(도)"] = sh[pre].max() - sh[K[0.1]:].min()
    m["피니시: 골반이 돈 전체 폭(도)"] = hip[pre].max() - hip[K[0.1]:].min()
    m["피니시: 손이 몸을 가로질러 간 거리"] = -seg("wr", SIDE, 0.2, 0.6).min()
    m["피니시: 손 높이(가장 높을 때)"] = seg("wr", UP, 0.2, 0.6).max()
    m["피니시: 스윙이 이어짐(+0.2초의 손목 속도)"] = v[K[0.2]]
    return {k: float(val) for k, val in m.items()}


GROUPS = {"포핸드": ["forehand_flat", "forehand_openstands"], "한손 백핸드": ["backhand"], "양손 백핸드": ["backhand2hands"], "백핸드 슬라이스": ["backhand_slice"],
          "포핸드 발리": ["forehand_volley"], "백핸드 발리": ["backhand_volley"], "서브": ["flat_service", "kick_service", "slice_service"], "스매시": ["smash"]}
per = collections.defaultdict(lambda: collections.defaultdict(list))            # 스트로크 → 사람 → [지표]
for r in rows:
    g = next((k for k, v in GROUPS.items() if r["cls"] in v), None)
    if g:
        per[g][r["who"]].append(metrics(r["x"], "백핸드" in g))
out = {}
for g, people in per.items():
    names = list(next(iter(people.values()))[0].keys())
    E, B = [], []
    for who, ms in people.items():
        vec = [float(np.mean([m[n] for m in ms])) for n in names]
        (E if int(who[2:]) >= 32 else B).append(vec)
    E, B = np.array(E), np.array(B)
    res = []
    for k, n in enumerate(names):
        e, b = E[:, k], B[:, k]
        sp = np.sqrt(((len(e) - 1) * e.var(ddof=1) + (len(b) - 1) * b.var(ddof=1)) / (len(e) + len(b) - 2))
        d = (e.mean() - b.mean()) / sp if sp > 0 else 0.0
        res.append({"metric": n, "d": round(float(d), 2), "expert": round(float(e.mean()), 3), "beginner": round(float(b.mean()), 3)})
    res.sort(key=lambda r: -abs(r["d"]))
    out[g] = {"experts": len(E), "beginners": len(B), "diffs": res}
    print(f"\n[{g}] 숙련자 {len(E)}명 · 초보 {len(B)}명 — 차이가 큰 순서")
    for r in res[:10]:
        print(f"  d={r['d']:+.2f}  {r['metric']}: 숙련자 {r['expert']} · 초보 {r['beginner']}")
json.dump({"note": "THETIS(Gourgari 외 2013) 영상에서 뽑은 자세로 잰 값. 숙련자 = p32~p55, 초보 = p1~p31. d = (숙련자 평균 − 초보 평균) / 합친 표준편차(사람 단위). 길이는 키에 대한 비율, 속도는 키/초. 공 없이 한 스윙이고 정면에서 찍은 영상이라 깊이 방향 값은 덜 정확하다.", "strokes": out}, open(sys.argv[3], "w"), ensure_ascii=False, indent=1)
