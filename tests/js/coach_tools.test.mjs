// 기준 자세 데이터를 만드는 도구의 이름 인식·제외 규칙 테스트.
//   node --test tests/js/coach_tools.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeFinder, excluded, norm } from '../../tools/coach/names.mjs';

const players = JSON.parse(fs.readFileSync(new URL('../../tools/coach/players.json', import.meta.url), 'utf8'));
const find = makeFinder(players);
const plain = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');

test('제목이 이름으로 시작해도(File:이름…) 선수를 알아본다', () => {
  assert.equal(find('File:Andy_Murray_2010_Forehand_(2).jpg').name, 'Andy Murray');
  assert.equal(find('File:2009_Australian_Open_-_Ana_Ivanovic_03.jpg').name, 'Ana Ivanovic');
  assert.equal(find('Rafael Nadal at the 2008 BNP Paribas Masters.jpg').name, 'Rafael Nadal');
  assert.equal(plain(find('File:Dominika_Cibulková_(5047217890).jpg').name), 'Dominika Cibulkova');
  assert.equal(find('File:Tennis_court_at_sunset.jpg'), null);
});

test('알려진 선수의 치는 손과 성별', () => {
  assert.deepEqual([find('File:Andy_Murray_serve.jpg').hand, find('File:Andy_Murray_serve.jpg').sex], ['R', 'M']);
  assert.equal(find('File:Ben_Shelton_(2023_US_Open).jpg').hand, 'L');
  assert.equal(find('File:Rafael_Nadal_forehand.jpg').hand, 'L');
  assert.equal(find('File:Feliciano_López_-_serve.jpg').hand, 'L');
  assert.deepEqual([find('File:Ekaterina_Makarova_2015.jpg').hand, find('File:Ekaterina_Makarova_2015.jpg').sex], ['L', 'F']);
  assert.equal(find('File:Justine_Henin.JPG').hand, 'R');
});

test('옛 사진과 어린이 사진은 기준에서 뺀다', () => {
  assert.equal(excluded('File:Pat_Hughes_1934.jpg'), 'old');
  assert.equal(excluded('File:Suzanne_Lenglen_1922_(cropped).jpg'), 'old');
  assert.equal(excluded('File:Boy_playing_Tennis.jpg'), 'child');
  assert.equal(excluded('File:2021_Montevideo_Open_(tennis)_-_Round_2.jpg'), null);
  assert.equal(excluded('File:Dominika_Cibulková_(5047217890).jpg'), null, '긴 숫자(사진 번호)를 연도로 보지 않는다');
  assert.equal(excluded('File:US_Open_2019_serve.jpg'), null);
});

test('norm 은 콜론·괄호·악센트를 지운다', () => {
  assert.equal(norm('File:Gaël_Monfils_(2012).jpg'), 'gael monfils 2012 jpg');
});
