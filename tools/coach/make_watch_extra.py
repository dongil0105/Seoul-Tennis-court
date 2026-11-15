#!/usr/bin/env python3
"""최종 학습에 더할 자료를 한 파일로: 친 순간을 표시한 자료(시범 영상·경기 영상, 3번씩) + '화면 보고 학습'으로 모은 자료(1번씩).

  python tools/coach/make_watch_extra.py cands_commons.jsonl cands_usopen.jsonl <watch_ingest 가 만든 cands.jsonl> out.jsonl [C|D|E]
  → python -u tools/coach/train_moment.py cands.jsonl out_model.json --extra out.jsonl

화면 보고 모은 것은 '스윙 아님'이 아주 많아 12%만 쓴다. C = 그대로, D = 뼈대가 깨진 스윙은 빼고, E = 깨진 스윙은 '스윙 아님'으로
(어느 것이 나은지는 eval_watch_extra.py 로 잰다).
"""
import json
import sys

import numpy as np

hits_files, watch, out = sys.argv[1:3], sys.argv[3], open(sys.argv[4], "w")
variant = sys.argv[5] if len(sys.argv) > 5 else "C"
n = 0
for f in hits_files:
    for l in open(f, encoding="utf-8"):
        r = json.loads(l)
        if r["pos"] < 0:
            continue
        for _ in range(3):
            out.write(json.dumps({"pos": r["pos"], "label": r["label"], "x": r["x"]}) + "\n"); n += 1
TH = {"jump": 0.464, "nose_up": 0.143, "tratio": 1.485}; SLOW = [0, 1, 7, 4, 10, 5, 11, 6, 12]


def glitchy(x):
    A = np.array(x, dtype=np.float32).reshape(15, 44); P = A[:, :39].reshape(15, 13, 3)
    jump = np.linalg.norm(np.diff(P[:, SLOW, :], axis=0), axis=2).max()
    torso = np.linalg.norm((P[:, 1, :] + P[:, 7, :]) / 2, axis=1)
    return jump > TH["jump"] or P[:, 0, 1].min() < TH["nose_up"] or torso.max() / max(torso.min(), 1e-3) > TH["tratio"]


rng = np.random.default_rng(0); w = {"pos": 0, "neg": 0, "glitch": 0}
for l in open(watch, encoding="utf-8"):
    r = json.loads(l)
    if r["pos"] < 0:
        continue
    if r["pos"] == 0:
        if rng.random() > 0.12:
            continue
        out.write(json.dumps({"pos": 0, "label": "forehand", "x": r["x"]}) + "\n"); w["neg"] += 1; continue
    if variant in "DE" and glitchy(r["x"]):
        w["glitch"] += 1
        if variant == "E":
            out.write(json.dumps({"pos": 0, "label": "forehand", "x": r["x"]}) + "\n")
        continue
    out.write(json.dumps({"pos": 1, "label": r["label"], "x": r["x"]}) + "\n"); w["pos"] += 1
print(f"친 순간을 표시한 자료 {n}줄(3번씩) · 화면 보고 모은 것: 스윙 {w['pos']} · 스윙 아님 {w['neg']} · 뼈대 깨진 스윙 {w['glitch']}({'스윙 아님으로' if variant == 'E' else '뺌' if variant == 'D' else '그대로'})")
