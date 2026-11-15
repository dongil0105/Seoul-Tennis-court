#!/usr/bin/env python3
"""'화면 보고 학습'으로 모은 자료(정답이 약하거나 없음)를 더하면 정답이 있는 자료에서 나아지는가.

  [VARS=AC] [SEED=0] python -u tools/coach/eval_watch_extra.py cands.jsonl models/moment_model_chosen.json \
      cands_commons.jsonl eval_hits_commons.json cands_usopen.jsonl eval_hits_usopen.json <watch_ingest 가 만든 cands.jsonl>

재는 곳(모두 그 자료를 보지 않은 모델로): 경기 영상 = 선수 단위로 빼고 학습, 시범 영상 = 시범 영상을 빼고 학습.
더하는 방법(VARS 에 적은 것만 돌린다):
  A 더하지 않음
  B '○○만' 믿는 구간(모델이 틀린 것을 바로잡은 것 포함) + '○○만' 구간에서 모델도 같은 종류라고 확신한 것 + '스윙 아님' 일부
  C B + 경기처럼 섞여 있는 영상에서 모델이 확신한 것
  D C 에서 뼈대가 깨진 스윙은 빼고      E C 에서 뼈대가 깨진 스윙은 '스윙 아님'으로
시험 자료가 작아(친 순간 98개·30개) 씨앗(SEED)에 따라 3~4%p 는 흔들린다 — 씨앗을 바꿔 여러 번 돌려 본다.
"""
import collections
import json
import os
import sys
import warnings

import numpy as np
from sklearn.neural_network import MLPClassifier
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")
TARGET = {"fh": "forehand", "fhslice": "forehand", "bh1": "backhand", "bh2": "backhand", "bhslice": "backhand",
          "serve": "overhead", "smash": "overhead", "fvolley": "fvolley", "bvolley": "bvolley",
          "forehand": "forehand", "backhand": "backhand", "overhead": "overhead"}
CLASSES = np.array(["backhand", "bvolley", "forehand", "fvolley", "none", "overhead"])
KIND = {"forehand": "forehand", "fvolley": "forehand", "backhand": "backhand", "bvolley": "backhand", "overhead": "serve"}
THR, MINGAP, TOL = 0.5, 0.7, 0.4


def load(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    X = np.array([r.pop("x") for r in rows], dtype=np.float32)
    return rows, X


base, Xb = load(sys.argv[1])
chosen_t = json.load(open(sys.argv[2]))
yb = np.full(len(base), "", dtype=object); use = np.zeros(len(base), dtype=bool)
for i, r in enumerate(base):
    if r["src"] == "mocap":
        yb[i] = TARGET[r["label"]] if r.get("pos") == 1 else "none"; use[i] = True
    else:
        ct = chosen_t.get(r["clip"])
        if ct is None:
            continue
        if abs(r["t"] - ct) < 0.01:
            yb[i] = TARGET[r["label"]]; use[i] = True
        elif abs(r["t"] - ct) > 0.5:
            yb[i] = "none"; use[i] = True
Xb, yb = Xb[use], yb[use]
del base


class Hits:
    def __init__(self, cand_path, hits_path):
        self.rows, self.X = load(cand_path)
        j = json.load(open(hits_path)); clips = j if isinstance(j, list) else j["clips"]
        self.clips = {c["seq"]: c for c in clips}
        self.clip = np.array([r["clip"] for r in self.rows]); self.t = np.array([r["t"] for r in self.rows])
        self.pos = np.array([r["pos"] for r in self.rows])
        self.y = np.array([TARGET[r["label"]] if r["pos"] == 1 else "none" for r in self.rows], dtype=object)
        self.train = self.pos >= 0

    def score(self, P, sel=None, thr=THR, clear=False):
        tot = collections.Counter()
        s = 1 - P[:, 4]; Pk = P.copy(); Pk[:, 4] = 0; cls = CLASSES[Pk.argmax(1)]
        for seq, c in self.clips.items():
            if sel is not None and seq not in sel:
                continue
            ids = np.where(self.clip == seq)[0]
            hits = c["hits"]; ignore = list(c.get("maybe", []))
            if clear:
                ignore += [h[0] for h in hits if len(h) > 5 and h[5] < 3]; hits = [h for h in hits if len(h) <= 5 or h[5] >= 3]
            tot["hits"] += len(hits)
            keep = []
            for i in sorted(ids[s[ids] >= thr], key=lambda i: -s[i]):
                if all(abs(self.t[i] - self.t[k]) >= MINGAP for k in keep):
                    keep.append(i)
            used = set()
            for h in hits:
                best = None
                for i in keep:
                    if i not in used and abs(self.t[i] - h[0]) <= TOL and (best is None or abs(self.t[i] - h[0]) < abs(self.t[best] - h[0])):
                        best = i
                if best is None:
                    continue
                used.add(best); tot["found"] += 1
                if KIND[cls[best]] == h[1]:
                    tot["right"] += 1
            vis = c.get("visible")
            for i in keep:
                t = self.t[i]
                if i in used or (vis and not any(a - 0.05 <= t <= b + 0.05 for a, b in vis)):
                    continue
                if any(abs(h[0] - t) <= TOL for h in hits) or any(abs(tm - t) <= 0.5 for tm in ignore):
                    continue
                tot["extra"] += 1
        return tot


SEED = int(os.environ.get('SEED', '0'))


def fit(Xa, ya, seed=None):
    seed = SEED if seed is None else seed
    sc = StandardScaler().fit(Xa)
    m = MLPClassifier(hidden_layer_sizes=(96,), alpha=1.0, max_iter=200, random_state=seed).fit(sc.transform(Xa), ya)
    return sc, m


def proba(model, X):
    sc, m = model
    P = np.zeros((len(X), len(CLASSES)))
    P[:, [list(CLASSES).index(c) for c in m.classes_]] = m.predict_proba(sc.transform(X))
    return P


def line(t):
    h, f, r, e = t["hits"], t["found"], t["right"], t["extra"]
    pc = lambda a, b: f"{100 * a / b:.1f}%" if b else "—"
    return f"친 것 {h} · 찾음 {pc(f, h)} · 종류 {pc(r, f)} · 없는 스윙 {e}({pc(e, f + e)}) · 끝까지 {pc(r, h)}"


demo = Hits(sys.argv[3], sys.argv[4]); match = Hits(sys.argv[5], sys.argv[6])
W = 3
rep = lambda X, y: (np.repeat(X, W, axis=0), np.repeat(y, W))
Xd, yd = rep(demo.X[demo.train], demo.y[demo.train])
groups = collections.defaultdict(set)
for sq, c in match.clips.items():
    groups[c.get("group", "?")].add(sq)

# ── 화면 보고 모은 자료
# 뼈대가 깨졌다고 보는 기준(특징에서 본다): 진짜 스윙 4,885개의 99.5% 가 이 안에 든다
TH = {"jump": 0.464, "nose_up": 0.143, "tratio": 1.485}     # 느린 관절이 0.1초에 뛴 거리(키의 배수) · 코 높이(골반 위, 키의 배수) · 구간 안 몸통 길이의 최대÷최소
SLOW = [0, 1, 7, 4, 10, 5, 11, 6, 12]


def glitchy(X):
    A = X.reshape(len(X), 15, 44); P = A[:, :, :39].reshape(len(X), 15, 13, 3)
    jump = np.linalg.norm(np.diff(P[:, :, SLOW, :], axis=1), axis=3).max(axis=(1, 2))
    nose = P[:, :, 0, 1].min(axis=1)
    torso = np.linalg.norm((P[:, :, 1, :] + P[:, :, 7, :]) / 2, axis=2)
    return (jump > TH["jump"]) | (nose < TH["nose_up"]) | (torso.max(axis=1) / np.maximum(torso.min(axis=1), 1e-3) > TH["tratio"])


rng = np.random.default_rng(0)
wx, wy, wkind = [], [], []
n = collections.Counter()
for l in open(sys.argv[7], encoding="utf-8"):
    r = json.loads(l)
    if r["pos"] < 0:
        continue
    if r["pos"] == 0:
        n["neg"] += 1
        if rng.random() > 0.12:                      # '스윙 아님'은 아주 많아서 일부만
            continue
        kind, y = "neg", "none"
    else:
        y = TARGET[r["label"]]
        kind = "trust" if r["mode"] == "weak" else ("agree" if r.get("only") else "free")     # 믿는 구간 / '○○만'에서 모델도 같은 종류 / 섞인 영상에서 모델이 확신
        n[kind] += 1
    wx.append(r["x"]); wy.append(y); wkind.append(kind)
WX = np.array(wx, dtype=np.float32); WY = np.array(wy, dtype=object); WK = np.array(wkind)
del wx
print(f"화면 보고 모은 자료: 믿는 구간 {n['trust']} · '○○만'에서 모델도 같은 종류 {n['agree']} · 섞인 영상에서 모델이 확신 {n['free']} · 스윙 아님 {n['neg']}(쓰는 것 {(WK == 'neg').sum()})", flush=True)
print("  종류별(스윙으로 쓰는 것):", dict(collections.Counter(WY[WK != 'neg'])), flush=True)

GL = glitchy(WX)
print(f"  스윙으로 쓰는 것 가운데 뼈대가 깨진 것: {GL[WK != 'neg'].mean():.1%}", flush=True)
WYE = WY.copy(); WYE[GL & (WK != "neg")] = "none"           # E: 깨진 것은 '스윙 아님'으로
VARIANTS = {"A": ("A 더하지 않음", np.zeros(len(WX), dtype=bool), WY),
            "B": ("B 믿는 구간 + 같은 종류 확신 + 스윙 아님", np.isin(WK, ["trust", "agree", "neg"]), WY),
            "C": ("C B + 섞인 영상의 확신", np.ones(len(WX), dtype=bool), WY),
            "D": ("D C 에서 뼈대가 깨진 스윙은 빼고", ~(GL & (WK != "neg")), WY),
            "E": ("E C 에서 뼈대가 깨진 스윙은 '스윙 아님'으로", np.ones(len(WX), dtype=bool), WYE)}
for key in os.environ.get("VARS", "ABC"):
    name, sel, WYv = VARIANTS[key]
    Xw, yw = WX[sel], WYv[sel]
    tot = collections.Counter(); tot3 = collections.Counter(); per = []
    for gname, test in sorted(groups.items()):
        tr = match.train & ~np.isin(match.clip, list(test))
        Xm, ym = rep(match.X[tr], match.y[tr])
        m = fit(np.vstack([Xb, Xd, Xm, Xw]), np.concatenate([yb, yd, ym, yw]))
        P = proba(m, match.X)
        t = match.score(P, sel=test); tot += t; tot3 += match.score(P, sel=test, clear=True); per.append(f"{gname[:9]} {100 * t['right'] / max(1, t['hits']):.0f}%")
    Xm, ym = rep(match.X[match.train], match.y[match.train])
    m = fit(np.vstack([Xb, Xm, Xw]), np.concatenate([yb, ym, yw]))
    td = demo.score(proba(m, demo.X))
    print(f"\n[{name}] 더한 것 {int(sel.sum())}개 · 씨앗 {SEED}", flush=True)
    print(f"  경기(처음 보는 선수): {line(tot)}   [{' · '.join(per)}]", flush=True)
    print(f"  경기 중 임팩트가 또렷한 샷: {line(tot3)}", flush=True)
    print(f"  시범 영상(안 본 채): {line(td)}", flush=True)
