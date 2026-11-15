// '치는 순간'까지 배운 모델로 스윙 찾기 — 본체는 앱 쪽 app/static/coach/js/moment.js (브라우저·Node 공용). 도구들은 여기를 거쳐 쓴다.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'app', 'static', 'coach', 'js');
export const { FLOOR, GAP, candidates, scoreCandidates, detectLearned, pickSwings, validMomentModel } = await import(path.join(JS, 'moment.js'));
