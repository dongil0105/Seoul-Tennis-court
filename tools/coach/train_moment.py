#!/usr/bin/env python3
"""'치는 순간'까지 배운 모델을 전체 자료로 만들어 JSON 으로 내보낸다(종류 5 + '스윙 아님').

  python -u tools/coach/train_moment.py cands.jsonl out.json [--extra extra.jsonl] [--hidden 96] [--iters 3]
  (cands.jsonl 은 build_moment_cands.mjs 로 만든다)

실제 영상(THETIS)은 영상마다 진짜 스윙이 어느 후보인지 모른다 → '정답 종류일 확률이 가장 높은 후보'를 진짜로 삼아 되풀이해 배운다.
--extra: 친 순간을 사람이 표시한 자료(후보마다 pos=1/0, label)를 더한다.
"""
import argparse
import collections
import json
import warnings

import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")
TARGET = {"fh": "forehand", "fhslice": "forehand", "bh1": "backhand", "bh2": "backhand", "bhslice": "backhand",
          "serve": "overhead", "smash": "overhead", "fvolley": "fvolley", "bvolley": "bvolley",
          "forehand": "forehand", "backhand": "backhand", "overhead": "overhead"}
G3 = {"forehand": "F", "fvolley": "F", "backhand": "B", "bvolley": "B", "overhead": "O"}
CLASSES = np.array(["backhand", "bvolley", "forehand", "fvolley", "none", "overhead"])

ap = argparse.ArgumentParser()
ap.add_argument("cands"); ap.add_argument("out")
ap.add_argument("--extra", default="")
ap.add_argument("--hidden", type=int, default=96)
ap.add_argument("--iters", type=int, default=3)
ap.add_argument("--alpha", type=float, default=1.0)
ap.add_argument("--extra-weight", type=int, default=1)
a = ap.parse_args()

rows = [json.loads(l) for l in open(a.cands, encoding="utf-8") if l.strip()]
X = np.array([r.pop("x") for r in rows], dtype=np.float32)
src = np.array([r["src"] for r in rows]); clip = np.array([r["clip"] for r in rows])
lab = np.array([TARGET[r["label"]] for r in rows]); t = np.array([r["t"] for r in rows])
T, M = src == "thetis", src == "mocap"
eng = np.array([bool(r.get("eng")) for r in rows]); pos = np.array([r.get("pos", -1) for r in rows])
yM = np.where(pos == 1, lab, "none")
by_clip = collections.defaultdict(list)
for i in np.where(T)[0]:
    by_clip[clip[i]].append(i)
clip_lab = {c: lab[v[0]] for c, v in by_clip.items()}
Xe = np.zeros((0, X.shape[1]), dtype=np.float32); ye = np.array([], dtype=object)
if a.extra:
    er = [json.loads(l) for l in open(a.extra, encoding="utf-8") if l.strip()]
    er = [r for r in er if r.get("pos", -1) >= 0]
    Xe = np.array([r["x"] for r in er], dtype=np.float32)
    ye = np.array([TARGET[r["label"]] if r["pos"] == 1 else "none" for r in er], dtype=object)
    Xe, ye = np.repeat(Xe, a.extra_weight, axis=0), np.repeat(ye, a.extra_weight)
    print(f"더한 자료: {len(er)}개(스윙 {sum(r['pos'] == 1 for r in er)}) × {a.extra_weight}", flush=True)


def fit(Xa, ya, seed=0):
    sc = StandardScaler().fit(Xa)
    m = MLPClassifier(hidden_layer_sizes=(a.hidden,), alpha=a.alpha, max_iter=200, random_state=seed).fit(sc.transform(Xa), ya)
    return sc, m


def proba(model, Xb):
    sc, m = model
    P = np.zeros((len(Xb), len(CLASSES)))
    P[:, [list(CLASSES).index(c) for c in m.classes_]] = m.predict_proba(sc.transform(Xb))
    return P


def labels_for(chosen):
    ii, yy = [], []
    for c, ids in by_clip.items():
        j = chosen.get(c)
        if j is None:
            continue
        for i in ids:
            if i == j:
                ii.append(i); yy.append(clip_lab[c])
            elif abs(t[i] - t[j]) > 0.5:
                ii.append(i); yy.append("none")
    return np.array(ii, dtype=int), np.array(yy)


def train(chosen):
    ii, yy = labels_for(chosen)
    return fit(np.vstack([X[ii], X[M], Xe]), np.concatenate([yy, yM[M], ye]))


chosen = {c: next((i for i in ids if eng[i]), None) for c, ids in by_clip.items()}
for it in range(a.iters):
    model = train(chosen)
    changed = 0
    for c, ids in by_clip.items():
        P = proba(model, X[ids])
        col = [k for k, name in enumerate(CLASSES) if name != "none" and G3[name] == G3[clip_lab[c]]]
        score = P[:, col].sum(axis=1)
        j = ids[int(np.argmax(score))]
        if score.max() >= 0.3 and chosen.get(c) != j:
            chosen[c] = j; changed += 1
    print(f"되풀이 {it}: 진짜로 삼은 후보가 바뀐 영상 {changed}개 · 진짜를 정한 영상 {sum(v is not None for v in chosen.values())}/{len(by_clip)}", flush=True)
model = train(chosen)
sc, clf = model
r = lambda v, n=4: [round(float(x), n) for x in v]
out = {"kind": "moment-mlp", "v": 1, "classes": [str(c) for c in clf.classes_], "n_feat": int(sc.mean_.shape[0]),
       "mean": r(sc.mean_, 5), "scale": r(sc.scale_, 5), "W1": [r(row) for row in clf.coefs_[0].T], "b1": r(clf.intercepts_[0]),
       "W2": [r(row) for row in clf.coefs_[1].T], "b2": r(clf.intercepts_[1])}
json.dump(out, open(a.out, "w", encoding="utf-8"), separators=(",", ":"))
json.dump({c: float(t[j]) for c, j in chosen.items() if j is not None}, open(a.out.replace(".json", "_chosen.json"), "w"))
print(f"저장: {a.out}", flush=True)
