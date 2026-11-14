#!/usr/bin/env python3
"""스트로크 분류기 학습: 스윙마다의 '온몸 움직임' 특징(js/classify.js 의 swingSequence, 660값)으로 종류를 가린다.

  python3 tools/coach/train_strokes.py feats.jsonl [--out app/static/coach/data/stroke_model.json]
                                                   [--folds-out <폴더>] [--parity tests/js/stroke_model_parity.json]

feats.jsonl 은 tools/coach/build_stroke_features.mjs 로 만든다. 한 줄 = { src('thetis'|'mocap'), who(사람), label, cls, rule, x(특징) }.
종류는 5가지: forehand / backhand / fvolley / bvolley / overhead(서브·스매시). 슬라이스는 포핸드·백핸드에 넣는다.
검증은 '사람 단위'로 한다(같은 사람의 스윙이 학습과 시험에 함께 들어가지 않게).
모델은 은닉층 하나짜리 신경망 — 브라우저에서 곱셈 몇만 번으로 돈다(js/classify.js 의 predictStroke).
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import sys
import warnings

import numpy as np
from sklearn.model_selection import GroupKFold
from sklearn.neural_network import MLPClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

warnings.filterwarnings("ignore")
TARGET = {"fh": "forehand", "fhslice": "forehand", "bh1": "backhand", "bh2": "backhand", "bhslice": "backhand",
          "serve": "overhead", "smash": "overhead", "fvolley": "fvolley", "bvolley": "bvolley"}
GROUP3 = {"forehand": "F", "fvolley": "F", "backhand": "B", "bvolley": "B", "overhead": "O"}     # 포핸드쪽 / 백핸드쪽 / 머리 위
HIDDEN, ALPHA = 64, 1.0


def net():
    return make_pipeline(StandardScaler(), MLPClassifier(hidden_layer_sizes=(HIDDEN,), alpha=ALPHA, max_iter=250, random_state=0))


def export(m, extra=None):
    sc, clf = m.named_steps["standardscaler"], m.named_steps["mlpclassifier"]
    r = lambda a, n=4: [round(float(v), n) for v in a]
    return {"kind": "stroke-mlp", "v": 2, "classes": [str(c) for c in clf.classes_], "n_feat": int(sc.mean_.shape[0]),
            "mean": r(sc.mean_, 5), "scale": r(sc.scale_, 5),
            "W1": [r(row) for row in clf.coefs_[0].T], "b1": r(clf.intercepts_[0]),
            "W2": [r(row) for row in clf.coefs_[1].T], "b2": r(clf.intercepts_[1]), **(extra or {})}


def g3(a):
    return np.array([GROUP3[v] for v in a])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("feats")
    ap.add_argument("--out", help="모든 자료로 배운 모델을 쓸 곳")
    ap.add_argument("--folds-out", help="실제 영상의 사람 단위 5겹마다 모델을 따로 내보낼 폴더(앱의 판단 방식 그대로 재는 데 쓴다: eval_thetis.mjs)")
    ap.add_argument("--parity", help="브라우저 쪽 계산이 같은 값을 내는지 보는 시험 자료를 쓸 곳")
    a = ap.parse_args()
    rows = [json.loads(l) for l in open(a.feats, encoding="utf-8") if l.strip()]
    X = np.array([r["x"] for r in rows], dtype=np.float32)
    y = np.array([TARGET[r["label"]] for r in rows])
    who = np.array([r["who"] for r in rows])
    src = np.array([r["src"] for r in rows])
    T, M = src == "thetis", src == "mocap"
    classes = sorted(set(y))
    print(f"스윙 {len(y)}개 · 실제 영상(THETIS) {T.sum()}개·{len(set(who[T]))}명 · 모션캡처 {M.sum()}개·{len(set(who[M]))}명 · 특징 {X.shape[1]}값")
    print("종류별:", dict(collections.Counter(y)))

    # 지금 규칙이 부른 종류(포핸드·백핸드·서브)의 3묶음 정확도 — 같은 스윙에서 견준다
    rule = np.array([{"forehand": "F", "backhand": "B", "serve": "O"}.get(r.get("rule") or "", "-") for r in rows])
    print(f"\n규칙만(같은 스윙, 3묶음): 실제 영상 {np.mean(rule[T] == g3(y[T])):.1%} · 모션캡처 {np.mean(rule[M] == g3(y[M])):.1%}", flush=True)

    def cv(mt, ma, folds_dir=None):
        Xt, yt, wt = X[mt], y[mt], who[mt]
        pred = np.empty(mt.sum(), dtype=object)
        fold_of = {}
        for k, (tr, te) in enumerate(GroupKFold(5).split(Xt, yt, wt)):
            m = net().fit(np.vstack([Xt[tr], X[ma]]), np.concatenate([yt[tr], y[ma]]))
            pred[te] = m.predict(Xt[te])
            if folds_dir:                                # 이 겹의 시험 대상(사람)을 보지 않고 배운 모델
                os.makedirs(folds_dir, exist_ok=True)
                json.dump(export(m), open(os.path.join(folds_dir, f"fold{k}.json"), "w", encoding="utf-8"), separators=(",", ":"))
                for w in set(wt[te]):
                    fold_of[str(w)] = k
        if folds_dir:
            json.dump(fold_of, open(os.path.join(folds_dir, "folds.json"), "w", encoding="utf-8"))
        return pred

    print("\n[1] 실제 영상 — 사람 단위 5겹(모션캡처는 늘 학습에)", flush=True)
    pt = cv(T, M, a.folds_out)
    yt = y[T]
    expert = np.array([int(w[2:]) >= 32 for w in who[T]])          # THETIS: p32~p55 가 숙련자
    print(f"  5종류 {np.mean(pt == yt):.1%} (숙련자 {np.mean((pt == yt)[expert]):.1%} · 초보 {np.mean((pt == yt)[~expert]):.1%}) · 3묶음 {np.mean(g3(pt) == g3(yt)):.1%}")
    for c in classes:
        i = yt == c
        print(f"    {c:9s} {int(i.sum()):4d}개 맞음 {np.mean(pt[i] == c):.0%} (숙련 {np.mean((pt == yt)[i & expert]):.0%} · 초보 {np.mean((pt == yt)[i & ~expert]):.0%})")

    print("\n[2] 모션캡처(실제로 공을 친 스윙) — 사람 단위 5겹(실제 영상은 늘 학습에)", flush=True)
    pm = cv(M, T)
    ym = y[M]
    print(f"  5종류 {np.mean(pm == ym):.1%} · 3묶음 {np.mean(g3(pm) == g3(ym)):.1%}")
    print("    " + " · ".join(f"{c} {np.mean(pm[ym == c] == c):.0%}({int((ym == c).sum())})" for c in classes))
    yaw = np.array([r.get("yaw", -1) for r in rows])[M]
    print("    카메라 방향별: " + " · ".join(f"{int(v)}° {np.mean((pm == ym)[yaw == v]):.0%}" for v in sorted(set(yaw))), flush=True)

    if a.out or a.parity:
        m = net().fit(X, y)
        if a.out:
            model = export(m, {
                "trained": {"thetis": int(T.sum()), "mocap": int(M.sum()), "people": len(set(who)),
                            "cv_thetis_5class": round(float(np.mean(pt == yt)), 3), "cv_thetis_3group": round(float(np.mean(g3(pt) == g3(yt))), 3),
                            "cv_mocap_5class": round(float(np.mean(pm == ym)), 3), "cv_mocap_3group": round(float(np.mean(g3(pm) == g3(ym))), 3)},
                "source": "THETIS (Gourgari et al. 2013) 영상에서 뽑은 자세 + Tennis-MoCap (Pulgarin-Giraldo et al. 2017, CC BY-SA 3.0). 원본 자료는 싣지 않는다."})
            json.dump(model, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
            print(f"\n모델 저장: {a.out} ({os.path.getsize(a.out) // 1024}KB)")
        if a.parity:                                     # 내보낸(반올림한) 모델로 다시 계산한 확률 — 브라우저 쪽 코드가 같은 값을 내야 한다
            ex = export(m)
            idx = np.linspace(0, len(X) - 1, 12).astype(int)
            W1, b1, W2, b2 = np.array(ex["W1"]), np.array(ex["b1"]), np.array(ex["W2"]), np.array(ex["b2"])
            xs = (X[idx] - np.array(ex["mean"])) / np.array(ex["scale"])
            z = np.maximum(xs @ W1.T + b1, 0) @ W2.T + b2
            p = np.exp(z - z.max(axis=1, keepdims=True)); p /= p.sum(axis=1, keepdims=True)
            json.dump({"classes": ex["classes"], "rows": [{"x": [round(float(v), 4) for v in X[i]], "p": [round(float(v), 5) for v in pr]} for i, pr in zip(idx, p)]},
                      open(a.parity, "w", encoding="utf-8"), separators=(",", ":"))
            print(f"시험 자료 저장: {a.parity}")


if __name__ == "__main__":
    sys.exit(main())
