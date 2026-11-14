#!/usr/bin/env bash
# 기준 자세 데이터(app/static/coach/data/reference.json)를 처음부터 다시 만든다.
#   tools/coach/make_reference.sh <수집 폴더(commons_collect.py 의 --out)> <pose_landmarker_heavy.task 경로>
# 순서: 사진에서 자세 뽑기 → 후보 표본 고르기 → 그 사진들의 저작자·라이선스 읽기 → 출처가 있는 것만으로 확정
set -euo pipefail
DIR="$1"; MODEL="$2"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && pwd)"
node "$HERE/pose_extract.mjs" --in "$DIR/manifest.tsv" --out "$DIR/poses.jsonl" --model "$MODEL" --poses 2
node "$HERE/build_reference.mjs" --poses "$DIR/poses.jsonl" --out "$DIR/reference_candidates.json" --perCell 110 --titles-out "$DIR/sample_titles.txt"
python3 "$HERE/commons_meta.py" --titles "$DIR/sample_titles.txt" --out "$DIR/meta.json"
node "$HERE/build_reference.mjs" --poses "$DIR/poses.jsonl" --meta "$DIR/meta.json" --out "$ROOT/app/static/coach/data/reference.json" --perCell 70
