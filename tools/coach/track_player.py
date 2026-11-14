#!/usr/bin/env python3
"""경기 영상에서 가까운 쪽 선수를 따라가며 잘라 낸다(멀리 작게 찍힌 선수를 크게).

  python tools/coach/track_player.py <영상> <out.mp4> --roi x0,y0,x1,y1 [--size 0.4] [--fps 30] [--start x,y] [--debug 코트.jpg]

방법: 카메라가 거의 고정이라고 보고, 낮은 해상도에서 '시간 중앙값'을 배경으로 삼아 움직이는 덩어리를 찾는다.
roi(화면 비율 0~1) 안에서 가장 큰 덩어리(앞 프레임 위치에 가까운 것을 우선)를 선수로 본다 → 위치를 부드럽게 → ffmpeg 로 따라가며 자른다.
size = 자르는 정사각형 한 변(화면 높이에 대한 비율). 결과 영상은 720×720.
"""
import argparse
import json
import subprocess
import sys

import numpy as np
from scipy import ndimage

ap = argparse.ArgumentParser()
ap.add_argument("video"); ap.add_argument("out")
ap.add_argument("--roi", default="0,0.45,0.75,0.95")
ap.add_argument("--size", type=float, default=0.4)
ap.add_argument("--fps", type=float, default=30)
ap.add_argument("--start", default="")
ap.add_argument("--thr", type=float, default=28)
ap.add_argument("--court", type=float, default=0.6)
ap.add_argument("--debug", default="")
a = ap.parse_args()

probe = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "json", a.video]))
W, H = probe["streams"][0]["width"], probe["streams"][0]["height"]
w, h = 480, int(round(480 * H / W / 2) * 2)
TF = 15.0                                              # 위치를 찾는 속도(초당 프레임)
raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", a.video, "-vf", f"fps={TF},scale={w}:{h}", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"])
F = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3).astype(np.int16)
n = len(F)
bg = np.median(F[:: max(1, n // 60)], axis=0)
x0, y0, x1, y1 = [float(v) for v in a.roi.split(",")]
mask = np.zeros((h, w), dtype=bool); mask[int(y0 * h):int(y1 * h), int(x0 * w):int(x1 * w)] = True
# 코트 바닥: 배경에서 roi 안의 가장 흔한 색들(코트 색)과 가까운 곳 → 관중석·광고판은 빠진다
q = (bg.astype(np.int32) // 24)
key = q[..., 0] * 400 + q[..., 1] * 20 + q[..., 2]
vals, cnt = np.unique(key[mask], return_counts=True)
order = np.argsort(-cnt); keep = []; acc = 0
for o in order:
    keep.append(vals[o]); acc += cnt[o]
    if acc >= a.court * mask.sum() or len(keep) >= 6:
        break
court = np.isin(key, keep) & mask
court = ndimage.binary_closing(court, iterations=4)
court = ndimage.binary_opening(court, iterations=2)
lab0, k0 = ndimage.label(court)
if k0:
    sizes = ndimage.sum(court, lab0, range(1, k0 + 1))
    court = lab0 == (1 + int(np.argmax(sizes)))
court = ndimage.binary_fill_holes(court)
court = ndimage.binary_dilation(court, iterations=6)
prev = None
if a.start:
    sx, sy = [float(v) for v in a.start.split(",")]; prev = (sx * w, sy * h)
pts = []
for i in range(n):
    d = np.abs(F[i] - bg).max(axis=2) > a.thr
    d &= mask
    d = ndimage.binary_opening(d, iterations=1)
    d = ndimage.binary_dilation(d, iterations=3)
    lab, k = ndimage.label(d)
    best = None
    if k:
        idx = list(range(1, k + 1))
        area = ndimage.sum(d, lab, idx); com = ndimage.center_of_mass(d, lab, idx)
        inside = ndimage.mean(court, lab, idx)
        for ar, (cy, cx), ins in zip(area, com, inside):
            if ar < 25 or ins < 0.5:
                continue
            score = ar
            if prev is not None:
                dist = np.hypot(cx - prev[0], cy - prev[1])
                score = ar / (1 + (dist / 30.0) ** 2)
            if best is None or score > best[0]:
                best = (score, cx, cy, ar)
    if best is not None:
        prev = (best[1], best[2]); pts.append((i / TF, best[1] / w, best[2] / h, float(best[3])))
    else:
        pts.append((i / TF, np.nan, np.nan, 0.0))
P = np.array(pts)
if a.debug:                                            # 코트 바닥으로 본 곳을 그림으로
    img = bg.astype(np.uint8).copy(); img[~court] = img[~court] // 4
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{w}x{h}", "-i", "-", "-frames:v", "1", a.debug], input=img.tobytes(), check=True)
ok = ~np.isnan(P[:, 1])
if ok.sum() < 5:
    print("선수를 찾지 못함", file=sys.stderr); sys.exit(1)
for c in (1, 2):                                       # 빈 곳 메우고 부드럽게
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
json.dump({"video": a.video, "W": W, "H": H, "size": S, "found": float(ok.mean()), "track": [[round(float(v), 4) for v in r[:3]] for r in P]}, open(a.out + ".json", "w"))
print(f"{a.video.split('/')[-1]}: 선수를 찾은 프레임 {ok.mean():.0%} · 자른 크기 {S}px → {a.out}")
