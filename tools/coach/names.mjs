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

// 1970년 이전에 뛴 선수(나무 라켓 시절 — 장비와 기술이 지금과 다르다). 제목에 연도가 없는 사진을 거르는 데 쓴다.
const OLD_PLAYERS = /\b(lenglen|jedrzejowska|tilden|fred perry|don budge|helen wills|lacoste|cochet|borotra|brugnon|bunny austin|von cramm|jack crawford|alice marble|maureen connolly|pancho gonzales|ken rosewall|lew hoad|kitty mckane|molla mallory|dorothea|suzanne|pat hughes|henner henkel|ellsworth vines|bobby riggs|althea gibson|doris hart|louise brough|margaret osborne|helen jacobs|simonne mathieu|cilly aussem|hilde krahwinkel)\b/;

/** 기준 자세에서 뺄 사진: 1970년 이전 사진·옛 선수(장비·기술이 다르다), 어린이 사진, 경기 장면이 아닌 사진 */
/** 같은 사진의 잘라낸 판을 알아보기 위한 이름: '(cropped)' 따위를 뗀다 */
export const baseTitle = (title) => String(title).replace(/\.[a-zA-Z]+$/, '').replace(/[_ ]*\((cropped|crop)[^)]*\)/gi, '').replace(/[_ ]+(cropped|crop)$/i, '').trim().toLowerCase();

export function excluded(title) {
  const t = String(title);
  if (/(?<!\d)(18\d{2}|19[0-6]\d)(?!\d)/.test(t)) return 'old';
  if (OLD_PLAYERS.test(norm(t))) return 'old';                    // 제목에 연도가 없어도, 나무 라켓 시절 선수는 뺀다
  if (/\b(boy|girl|child|children|kid|kids|toddler)\b/i.test(t.replace(/_/g, ' '))) return 'child';
  // 경기 장면이 아닌 사진(우승 세리머니·시상식·기자회견·사인회): 팔을 든 모습이 서브 자세로 잘못 잡힌다
  if (/\b(after winning|winner|wins|trophy|ceremony|celebrat\w*|award\w*|medal\w*|podium|press conference|interview|autograph\w*|signing|portrait|handshake|selfie)\b/i.test(t.replace(/_/g, ' '))) return 'event';
  return null;
}
