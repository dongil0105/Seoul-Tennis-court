#!/usr/bin/env python3
"""경기 영상에서 가까운 쪽 선수를 따라가며 잘라 낸다(멀리 작게 찍힌 선수를 크게).

  python tools/coach/track_player.py <영상> <out.mp4> [--roi x0,y0,x1,y1] [--size 0.36] [--fps 30] [--debug 그림.jpg]
  roi = 가까운 선수가 다니는 곳(화면 비율). 기본값은 화면 아래 절반·왼쪽 80% (관중석 뒤 높은 곳에서 찍은 영상에 맞춘 값).

방법(색으로 찾기 — 카메라가 조금 움직여도 된다):
  1. 낮은 해상도(480px)에서 roi 안의 가장 흔한 색들을 '코트 색'으로 삼는다(영상 전체의 시간 중앙값에서 한 번).
  2. 프레임마다: 코트 색인 곳을 메워 '코트 바닥'을 만들고, 그 안에서 코트 색이 아닌 덩어리를 찾는다. 가는 선(라인)은 지운다.
  3. 가장 큰 덩어리들 가운데 앞 프레임 위치에 가까운 것을 선수로 본다 → 위치를 부드럽게 → ffmpeg 로 따라가며 자른다(720×720).
"""
import argparse
import json
import subprocess
import sys

import numpy as np
from scipy import ndimage

ap = argparse.ArgumentParser()
ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--roi", default="0,0.5,0.8,1.0")
ap.add_argument("--size", type=float, default=0.36)
ap.add_argument("--fps", type=float, default=30)
ap.add_argument("--court", type=float, default=0.8)
ap.add_argument("--debug", default="")
a = ap.parse_args()

probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", a.video]))
W, H = probe["streams"][0]["width"], probe["streams"][0]["height"]
w, h = 480, int(round(480 * H / W / 2) * 2)
TF = 15.0
raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", a.video, "-vf", f"fps={TF},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
F = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3)
n = len(F)
x0, y0, x1, y1 = [float(v) for v in a.roi.split(",")]
mask = np.zeros((h, w), dtype=bool); mask[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = True


def keyof(img):
    q = img.astype(np.int32) // 24
    return q[..., 0] * 400 + q[..., 1] * 20 + q[..., 2]


bg = np.median(F[:: max(1, n // 60)], axis=0)
kb = keyof(bg)
vals, cnt = np.unique(kb[mask], return_counts=True)
order = np.argsort(-cnt); keep = []; acc = 0
for o in order:
    keep.append(vals[o]); acc += cnt[o]
    if acc >= a.court * mask.sum() or len(keep) >= 12:
        break
keep = np.array(keep)


def objects(img):
    """코트 바닥 안의 '코트 색이 아닌' 덩어리(라인은 지움) → [(넓이, cx, cy)], 코트 바닥"""
    like = np.isin(keyof(img), keep) & mask
    like = ndimage.binary_opening(like, iterations=1)
    lab, k = ndimage.label(like)
    if not k:
        return [], like
    sizes = ndimage.sum(like, lab, range(1, k + 1))
    surf = lab == (1 + int(np.argmax(sizes)))
    region = ndimage.binary_fill_holes(ndimage.binary_closing(surf, iterations=10, border_value=0))
    obj = region & ~like & mask
    obj = ndimage.binary_opening(obj, iterations=2)            # 라인·네트 줄처럼 가는 것은 사라진다
    obj = ndimage.binary_dilation(obj, iterations=3)
    lab, k = ndimage.label(obj)
    if not k:
        return [], region
    idx = list(range(1, k + 1))
    area = ndimage.sum(obj, lab, idx); com = ndimage.center_of_mass(obj, lab, idx)
    return [(float(ar), cx, cy) for ar, (cy, cx) in zip(area, com) if ar >= 60], region


# 늘 같은 자리에 있는 것(심판석·볼퍼슨·관중 머리)은 뺀다: 프레임의 40% 넘게 물체였던 곳
stat = np.zeros((h, w), dtype=np.float32); regions = []
per = []
for i in range(n):
    c, region = objects(F[i]); per.append(c)
    if i % 3 == 0:
        like = np.isin(keyof(F[i]), keep) & mask
        stat += (region & ~like)
static = ndimage.binary_dilation(stat / max(1, len(range(0, n, 3))) > 0.4, iterations=2)
prev = None; pts = []
for i in range(n):
    cand = [c for c in per[i] if not static[int(min(h - 1, c[2])), int(min(w - 1, c[1]))]]
    best = None
    if cand:
        amax = max(c[0] for c in cand)
        big = [c for c in cand if c[0] >= 0.5 * amax]
        best = max(big) if prev is None else min(big, key=lambda c: np.hypot(c[1] - prev[0], c[2] - prev[1]))
        if prev is not None and np.hypot(best[1] - prev[0], best[2] - prev[1]) > 90 and best[0] < 0.8 * amax:
            best = None
    if best is not None:
        prev = (best[1], best[2]); pts.append((i / TF, best[1] / w, best[2] / h, best[0]))
    else:
        pts.append((i / TF, np.nan, np.nan, 0.0))
P = np.array(pts)
ok = ~np.isnan(P[:, 1])
if a.debug:
    img = bg.astype(np.uint8).copy()
    like = np.isin(kb, keep) & mask
    img[~like] = img[~like] // 3; img[static] = [255, 0, 0]
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", a.debug], input=img.tobytes(), check=True)
if ok.sum() < 5:
    print("선수를 찾지 못함", file=sys.stderr); sys.exit(1)
for c in (1, 2):
    P[:, c] = np.interp(P[:, 0], P[ok, 0], P[ok, c])
    P[:, c] = ndimage.median_filter(P[:, c], size=5, mode="nearest")
    P[:, c] = ndimage.gaussian_filter1d(P[:, c], sigma=4, mode="nearest")
S = int(round(a.size * H / 2) * 2)
cmds = []
for t, cx, cy, _ in P:
    X = int(min(max(cx * W - S / 2, 0), W - S)); Y = int(min(max(cy * H - S * 0.5, 0), H - S))
    cmds.append(f"{t:.3f} crop x {X}, crop y {Y};")
cmdfile = a.out + ".cmd"
open(cmdfile, "w").write("\n".join(cmds) + "\n")
subprocess.check_call(["ffmpeg", "-v", "error", "-y", "-i", a.video, "-vf", f"fps={a.fps},sendcmd=f={cmdfile},crop={S}:{S}:0:0,scale=720:720:flags=lanczos", "-an", "-c:v", "libx264", "-crf", "18", "-preset", "veryfast", a.out])
json.dump({"video": a.video, "W": W, "H": H, "size": S, "found": float(ok.mean()), "track": [[round(float(v), 4) for v in r[:3]] for r in P], "seen": [bool(v) for v in ok]}, open(a.out + ".json", "w"))
print(f"{a.video.split('/')[-1]}: 선수를 찾은 프레임 {ok.mean():.0%} · 자른 크기 {S}px → {a.out}")
