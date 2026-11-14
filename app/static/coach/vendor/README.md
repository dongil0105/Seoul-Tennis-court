# 내장한 외부 파일 (스윙 코치 자세 인식)

휴대폰에서 CDN 이 막혀도 돌아가고, 버전이 바뀌어 결과가 달라지지 않게 저장소에 같이 둔다.

| 파일 | 출처 | 버전 | 라이선스 |
|---|---|---|---|
| `tasks-vision/vision_bundle.mjs`, `tasks-vision/wasm/*` | npm `@mediapipe/tasks-vision` | `tasks-vision/VERSION` 참고 | Apache-2.0 |
| `models/pose_landmarker_lite.task` | `storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/` | float16 / 1 | Apache-2.0 |
| `models/pose_landmarker_full.task` | `storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/` | float16 / 1 | Apache-2.0 |

- lite: 전체 영상을 훑을 때(빠름). full: 스윙 한 번을 정밀하게 볼 때.
- 기준 자세 데이터를 만들 때는 더 무거운 heavy 모델을 쓰지만, 30MB 라 저장소에는 넣지 않는다(같은 주소의 `pose_landmarker_heavy`).
- 바꿀 때: `npm i @mediapipe/tasks-vision` 뒤 위 파일을 다시 복사하고 `VERSION` 을 고친다.
