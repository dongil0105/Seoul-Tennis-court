#!/usr/bin/env python3
"""친 순간을 표시한 실제 영상(시범 영상·경기 영상)을 학습에 더하고, 보지 않은 영상·선수로 '끝까지' 잰다.

  python -u tools/coach/eval_moment_cv.py cands.jsonl models/moment_model_chosen.json cands_commons.jsonl eval_hits_commons.json cands_usopen.jsonl eval_hits_usopen.json [무게 3]
  (cands_*.jsonl 은 build_moment_cands.mjs / build_hit_cands.mjs 로 만든다)

끝까지 재기: 영상마다 후보에 확률 → 스윙일 확률 0.5 이상, 0.7초 안에 겹치면 높은 것 하나 → 표시한 친 순간과 ±0.4초로 짝짓기.
나누는 법: (가) 경기 영상을 아예 안 본 모델(지금 모델) (나) 다른 경기만 본 모델(알카라스-우 ↔ 페굴라-페르난데스) (다) 영상 단위 5겹(같은 경기의 다른 영상은 봄).
"""
import collections
import json
import sys
import warnings

import numpy as np
from sklearn.model_selection import GroupKFold
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
print(f"바탕 자료(연습 영상 + 모션캡처): {len(Xb)}개", flush=True)


class Hits:
    def __init__(self, cand_path, hits_path, name):
        self.name = name
        self.rows, self.X = load(cand_path)
        j = json.load(open(hits_path)); clips = j if isinstance(j, list) else j["clips"]
        self.clips = {c["seq"]: c for c in clips}
        self.clip = np.array([r["clip"] for r in self.rows]); self.t = np.array([r["t"] for r in self.rows])
        self.pos = np.array([r["pos"] for r in self.rows])
        self.y = np.array([TARGET[r["label"]] if r["pos"] == 1 else "none" for r in self.rows], dtype=object)
        self.train = self.pos >= 0

    def score(self, P, sel=None, thr=THR, clear=False):
        """P: 후보마다 확률(행 = self.rows). sel: 잴 영상(seq) 모음. → 친 것, 찾음, 종류 맞음, 없는 스윙"""
        tot = collections.Counter(); wrong = []
        s = 1 - P[:, 4]; Pk = P.copy(); Pk[:, 4] = 0; cls = CLASSES[Pk.argmax(1)]
        for seq, c in self.clips.items():
            if sel is not None and seq not in sel:
                continue
            ids = np.where(self.clip == seq)[0]
            hits = c["hits"]; ignore = list(c.get("maybe", []))
            if clear:                                   # 임팩트가 또렷이 보인 것(확신 3)만 세고, 나머지는 세지 않는 구간으로
                ignore += [h[0] for h in hits if len(h) > 5 and h[5] < 3]; hits = [h for h in hits if len(h) <= 5 or h[5] >= 3]
            tot["hits"] += len(hits)
            keep = []
            for i in sorted(ids[s[ids] >= thr], key=lambda i: -s[i]):
                if all(abs(self.t[i] - self.t[k]) >= MINGAP for k in keep):
                    keep.append(i)
            used = set()
            for h in hits:
                th, want = h[0], h[1]
                best = None
                for i in keep:
                    if i not in used and abs(self.t[i] - th) <= TOL and (best is None or abs(self.t[i] - th) < abs(self.t[best] - th)):
                        best = i
                if best is None:
                    wrong.append((c.get("title", seq)[:28], th, want, "놓침")); continue
                used.add(best); tot["found"] += 1
                if KIND[cls[best]] == want:
                    tot["right"] += 1
                else:
                    wrong.append((c.get("title", seq)[:28], th, want, "→" + KIND[cls[best]]))
            vis = c.get("visible")
            for i in keep:
                if i in used:
                    continue
                t = self.t[i]
                if vis and not any(a - 0.05 <= t <= b + 0.05 for a, b in vis):
                    continue
                if any(abs(h[0] - t) <= TOL for h in hits) or any(abs(tm - t) <= 0.5 for tm in ignore):
                    continue
                tot["extra"] += 1; wrong.append((c.get("title", seq)[:28], round(float(t), 1), "-", "없는 스윙 " + KIND[cls[i]]))
        return tot, wrong


def fit(Xa, ya, seed=0, hidden=96):
    sc = StandardScaler().fit(Xa)
    m = MLPClassifier(hidden_layer_sizes=(hidden,), alpha=1.0, max_iter=200, random_state=seed).fit(sc.transform(Xa), ya)
    return sc, m


def proba(model, X):
    sc, m = model
    P = np.zeros((len(X), len(CLASSES)))
    if len(X):
        P[:, [list(CLASSES).index(c) for c in m.classes_]] = m.predict_proba(sc.transform(X))
    return P


def show(name, tot):
    h, f, r, e = tot["hits"], tot["found"], tot["right"], tot["extra"]
    pc = lambda a, b: f"{100 * a / b:.1f}%" if b else "—"
    print(f"  {name}: 친 것 {h} → 찾음 {f} ({pc(f, h)}) · 찾은 것 중 종류 맞음 {r} ({pc(r, f)}) · 없는 스윙 {e} (부른 것 중 {pc(e, f + e)}) · 끝까지 맞음 {pc(r, h)}", flush=True)


demo = Hits(sys.argv[3], sys.argv[4], "시범 영상")
match = Hits(sys.argv[5], sys.argv[6], "경기 영상")
W = int(sys.argv[7]) if len(sys.argv) > 7 else 3           # 표시한 실제 영상에 주는 무게(되풀이 횟수)
rep = lambda X, y: (np.repeat(X, W, axis=0), np.repeat(y, W))
aw = {s for s, c in match.clips.items() if c.get("match") == "AW"}; pf = {s for s, c in match.clips.items() if c.get("match") == "PF"}
print(f"시범 영상 {len(demo.clips)}개(친 것 {sum(len(c['hits']) for c in demo.clips.values())}) · 경기 영상 {len(match.clips)}개(친 것 {sum(len(c['hits']) for c in match.clips.values())}; 알카라스-우 {len(aw)} · 페굴라-페르난데스 {len(pf)})")

print("\n[가] 경기 영상을 한 번도 안 본 모델(지금까지의 학습)")
m0 = fit(Xb, yb)
t, w0 = match.score(proba(m0, match.X)); show("경기 영상", t)
t3, _ = match.score(proba(m0, match.X), clear=True); show("그중 임팩트가 또렷이 보인 것만", t3)
t, _ = demo.score(proba(m0, demo.X)); show("시범 영상", t)

print("\n[나] 시범 영상까지 더한 모델(경기 영상은 여전히 안 봄)")
Xd, yd = rep(demo.X[demo.train], demo.y[demo.train])
m1 = fit(np.vstack([Xb, Xd]), np.concatenate([yb, yd]))
t, _ = match.score(proba(m1, match.X)); show("경기 영상", t)

print("\n[다] 그 선수를 한 번도 안 본 모델(선수 단위로 빼고 학습)")
groups = collections.defaultdict(set)
for sq, c in match.clips.items():
    groups[c.get("group", "?")].add(sq)
tot = collections.Counter(); tot3 = collections.Counter(); wrongs = []
for gname, test in sorted(groups.items()):
    tr = match.train & ~np.isin(match.clip, list(test))
    Xm, ym = rep(match.X[tr], match.y[tr])
    m = fit(np.vstack([Xb, Xd, Xm]), np.concatenate([yb, yd, ym]))
    Pg = proba(m, match.X)
    t, w = match.score(Pg, sel=test); show(f"{gname}(영상 {len(test)}개)로 시험", t); tot += t; wrongs += w
    t3, _ = match.score(Pg, sel=test, clear=True); tot3 += t3
show("모두 합쳐서", tot)
show("그중 임팩트가 또렷이 보인 것만", tot3)
print("  틀린 것(선수 단위): " + " | ".join(f"{a} {b}초 {c}{d}" for a, b, c, d in wrongs[:60]))

print("\n[라] 영상 단위 5겹(같은 경기의 다른 영상은 학습에 있음)")
seqs = np.array(sorted(match.clips)); P = np.zeros((len(match.rows), len(CLASSES)))
for tr, te in GroupKFold(5).split(seqs, groups=seqs):
    trm = match.train & np.isin(match.clip, seqs[tr])
    Xm, ym = rep(match.X[trm], match.y[trm])
    m = fit(np.vstack([Xb, Xd, Xm]), np.concatenate([yb, yd, ym]))
    te_rows = np.isin(match.clip, seqs[te])
    P[te_rows] = proba(m, match.X[te_rows])
t, w5 = match.score(P); show("경기 영상", t)
t3, _ = match.score(P, clear=True); show("그중 임팩트가 또렷이 보인 것만", t3)
for th in (0.3, 0.7):
    t, _ = match.score(P, thr=th); show(f"  문턱 {th}", t)
print("  틀린 것(영상 단위 5겹): " + " | ".join(f"{a} {b}초 {c}{d}" for a, b, c, d in w5[:40]))
# 시범 영상: 경기 영상을 더해도 나빠지지 않는지 — 시범 영상을 빼고 배운 모델로
Xm, ym = rep(match.X[match.train], match.y[match.train])
m = fit(np.vstack([Xb, Xm]), np.concatenate([yb, ym]))
print("\n[마] 경기 영상을 더하고 시범 영상은 안 본 모델")
t, _ = demo.score(proba(m, demo.X)); show("시범 영상", t)
