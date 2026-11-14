#!/usr/bin/env python3
"""스트로크 분류기 학습: 스윙마다의 특징 벡터(js/classify.js 의 swingFeatures)로 종류를 가린다.

  python3 tools/coach/train_strokes.py feats.jsonl [--out app/static/coach/data/stroke_model.json]

feats.jsonl 한 줄 = { src('thetis'|'mocap'), who(사람), label, det, rule(지금 규칙이 부른 종류), x(특징) }.
검증은 '사람 단위'로 한다(같은 사람의 스윙이 학습과 시험에 함께 들어가지 않게). 숫자는 실제 영상(THETIS) 기준으로 본다.
모델은 다항 로지스틱 회귀 — 브라우저에서 곱셈 몇 번으로 돈다(js/classify.js 의 predictStroke).
"""
from __future__ import annotations

import argparse
import collections
import json
import sys

import numpy as np
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import GroupKFold
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler

# 앱이 부르는 종류 6가지(슬라이스는 포핸드·백핸드에 넣는다)
TARGET = {"fh": "forehand", "fhslice": "forehand", "bh1": "backhand", "bh2": "backhand", "bhslice": "backhand",
          "serve": "serve", "smash": "smash", "fvolley": "fvolley", "bvolley": "bvolley"}
GROUP3 = {"forehand": "F", "fvolley": "F", "backhand": "B", "bvolley": "B", "serve": "O", "smash": "O"}     # 포핸드쪽 / 백핸드쪽 / 머리 위
RULE3 = {"forehand": "F", "backhand": "B", "serve": "O"}


def load(path):
    rows = [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]
    X = np.array([r["x"] for r in rows], dtype=float)
    y = np.array([TARGET[r["label"]] for r in rows])
    who = np.array([r["who"] for r in rows])
    src = np.array([r["src"] for r in rows])
    return rows, X, y, who, src


def lr(C=1.0):
    return make_pipeline(StandardScaler(), LogisticRegression(C=C, max_iter=3000))


def export(m, n_feat, extra):
    sc, clf = m.named_steps["standardscaler"], m.named_steps["logisticregression"]
    return {"kind": "stroke-logreg", "v": 1, "classes": [str(c) for c in clf.classes_], "n_feat": int(n_feat),
            "mean": [round(float(v), 5) for v in sc.mean_], "scale": [round(float(v), 5) for v in sc.scale_],
            "W": [[round(float(v), 4) for v in row] for row in clf.coef_], "b": [round(float(v), 4) for v in clf.intercept_], **extra}


def report(name, y, p):
    acc = float(np.mean(y == p))
    g = float(np.mean(np.array([GROUP3[a] for a in y]) == np.array([GROUP3[a] for a in p])))
    print(f"  {name}: 6종류 {acc:.1%} · 3묶음(포/백/머리 위) {g:.1%}")
    return acc, g


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("feats")
    ap.add_argument("--out")
    ap.add_argument("--C", type=float, default=0.3)
    ap.add_argument("--folds-out", help="실제 영상의 사람 단위 5겹마다 모델을 따로 내보낼 폴더(앱의 판단 방식 그대로 재는 데 쓴다: eval_thetis.mjs)")
    a = ap.parse_args()
    rows, X, y, who, src = load(a.feats)
    T, M = src == "thetis", src == "mocap"
    print(f"스윙 {len(y)}개 (THETIS {T.sum()} · 모션캡처 {M.sum()}) · 사람 {len(set(who))}명")
    print("종류별:", dict(collections.Counter(y)))

    # 지금 규칙(3묶음)의 실제 영상 정확도
    rule = np.array([RULE3.get(r.get("rule") or "", "-") for r in rows])
    g3 = np.array([GROUP3[v] for v in y])
    print(f"\n지금 규칙(실제 영상, 3묶음): {np.mean(rule[T] == g3[T]):.1%}  (스윙을 못 찾은 것 포함 {int((rule[T] == '-').sum())}개는 틀린 것으로)")

    print("\n[1] 실제 영상만으로 학습 — 사람 단위 5겹 검증")
    pred = np.empty(T.sum(), dtype=object)
    XT, yT, wT = X[T], y[T], who[T]
    for tr, te in GroupKFold(5).split(XT, yT, wT):
        pred[te] = lr(a.C).fit(XT[tr], yT[tr]).predict(XT[te])
    report("로지스틱", yT, pred)
    pred_g = np.empty(T.sum(), dtype=object)
    for tr, te in GroupKFold(5).split(XT, yT, wT):
        pred_g[te] = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.08).fit(XT[tr], yT[tr]).predict(XT[te])
    report("그래디언트 부스팅(더 큰 모델이면 얼마나 오르나)", yT, pred_g)

    print("\n[2] 모션캡처로만 학습 → 실제 영상에 시험(자료가 달라도 통하나)")
    report("로지스틱", yT, lr(a.C).fit(X[M], y[M]).predict(XT))

    print("\n[3] 둘 다로 학습 — 실제 영상의 사람 단위 5겹 검증(모션캡처는 늘 학습에)")
    pred2 = np.empty(T.sum(), dtype=object)
    wM = np.full(M.sum(), 0.25)                       # 모션캡처는 같은 스윙을 네 방향에서 본 것이라 한 줄의 무게를 1/4 로
    fold_of = {}
    for k, (tr, te) in enumerate(GroupKFold(5).split(XT, yT, wT)):
        Xtr, ytr = np.vstack([XT[tr], X[M]]), np.concatenate([yT[tr], y[M]])
        sw = np.concatenate([np.ones(len(tr)), wM])
        m = lr(a.C); m.fit(Xtr, ytr, standardscaler__sample_weight=sw, logisticregression__sample_weight=sw)
        pred2[te] = m.predict(XT[te])
        if a.folds_out:                                  # 이 겹의 시험 대상(사람)을 보지 않고 배운 모델
            import os
            os.makedirs(a.folds_out, exist_ok=True)
            json.dump(export(m, X.shape[1], {}), open(os.path.join(a.folds_out, f"fold{k}.json"), "w", encoding="utf-8"), separators=(",", ":"))
            for w in set(wT[te]):
                fold_of[str(w)] = k
    if a.folds_out:
        json.dump(fold_of, open(os.path.join(a.folds_out, "folds.json"), "w", encoding="utf-8"))
    acc, g = report("로지스틱", yT, pred2)
    classes = sorted(set(y))
    print("  혼동표(행 = 정답, 열 = 부른 종류):", " ".join(classes))
    for c in classes:
        idx = yT == c
        print(f"    {c:9s} {int(idx.sum()):4d}개 →", " ".join(f"{int(np.sum(pred2[idx] == d)):4d}" for d in classes), f" 맞음 {np.mean(pred2[idx] == c):.0%}")
    det = np.array([r["det"] for r in rows])[T]
    print(f"  엔진이 스윙을 찾은 것만: {np.mean(pred2[det] == yT[det]):.1%} ({int(det.sum())}개) · 못 찾은 것: {np.mean(pred2[~det] == yT[~det]):.1%} ({int((~det).sum())}개)")

    print("\n[4] 모션캡처(실제로 공을 친 스윙)의 사람 단위 5겹 검증 — 실제 영상은 늘 학습에")
    XM, yM, wMo = X[M], y[M], who[M]
    pred3 = np.empty(M.sum(), dtype=object)
    for tr, te in GroupKFold(5).split(XM, yM, wMo):
        Xtr, ytr = np.vstack([XT, XM[tr]]), np.concatenate([yT, yM[tr]])
        sw = np.concatenate([np.ones(T.sum()), np.full(len(tr), 0.25)])
        m = lr(a.C); m.fit(Xtr, ytr, standardscaler__sample_weight=sw, logisticregression__sample_weight=sw)
        pred3[te] = m.predict(XM[te])
    report("로지스틱", yM, pred3)
    print(f"  지금 규칙(모션캡처, 3묶음): {np.mean(rule[M] == g3[M]):.1%}")
    for c in classes:
        idx = yM == c
        print(f"    {c:9s} {int(idx.sum()):4d}개 → 분류기 맞음 {np.mean(pred3[idx] == c):.0%} · 3묶음 {np.mean(np.array([GROUP3[v] for v in pred3[idx]]) == GROUP3[c]):.0%} · 규칙 3묶음 {np.mean(rule[M][idx] == GROUP3[c]):.0%}")

    if a.out:
        sw = np.concatenate([np.ones(T.sum()), wM])
        Xall, yall = np.vstack([XT, X[M]]), np.concatenate([yT, y[M]])
        m = lr(a.C); m.fit(Xall, yall, standardscaler__sample_weight=sw, logisticregression__sample_weight=sw)
        model = export(m, X.shape[1], {
            "trained": {"thetis": int(T.sum()), "mocap": int(M.sum()), "people": len(set(who)), "cv_thetis_6class": round(acc, 3), "cv_thetis_3group": round(g, 3)},
            "source": "THETIS (Gourgari et al. 2013) 영상에서 뽑은 자세 + Tennis-MoCap (Pulgarin-Giraldo et al. 2017, CC BY-SA 3.0). 원본 자료는 싣지 않는다."})
        json.dump(model, open(a.out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print(f"\n모델 저장: {a.out} ({len(json.dumps(model)) // 1024}KB)")


if __name__ == "__main__":
    sys.exit(main())
