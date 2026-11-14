// 사진 제목에서 선수를 알아보고, 기준 자세에 넣으면 안 되는 사진(옛 사진·어린이)을 가려낸다. build_reference.mjs 와 테스트가 같이 쓴다.

/** 견주기 좋게: 악센트·구두점(콜론 포함)을 지우고 소문자로. 'File:' 머리말도 뗀다. */
export const norm = (s) => String(s).replace(/^File:/i, '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[_\-.,():;'"!?]/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * players = players.json 내용({ M:[…], F:[…], left:[…] }) → 제목에서 선수를 찾는 함수.
 * 돌려주는 것: { name, sex, hand } 또는 null. 긴 이름부터 본다('Venus Williams' 가 'Williams' 류에 가려지지 않게).
 */
export function makeFinder(players) {
  const table = [];
  for (const sex of ['M', 'F']) for (const name of players[sex]) table.push({ key: norm(name), name, sex, hand: players.left.includes(name) ? 'L' : 'R' });
  table.sort((p, q) => q.key.length - p.key.length);
  return (title) => {
    const t = ` ${norm(title)} `;
    return table.find((p) => t.includes(` ${p.key} `)) || null;
  };
}

/** 기준 자세에서 뺄 사진: 1970년 이전 사진(장비·기술이 다르다), 어린이 사진 */
export function excluded(title) {
  const t = String(title);
  if (/(?<!\d)(18\d{2}|19[0-6]\d)(?!\d)/.test(t)) return 'old';
  if (/\b(boy|girl|child|children|kid|kids|toddler)\b/i.test(t.replace(/_/g, ' '))) return 'child';
  return null;
}
