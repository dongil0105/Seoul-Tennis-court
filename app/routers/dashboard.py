"""사람이 보기 좋은 HTML 대시보드(/) — /preview JSON을 카드로 렌더링 + 브라우저 필터.

필터는 전부 클라이언트(브라우저)에서 동작 — 서버에 아무것도 저장하지 않아
공개(읽기 전용) 배포에서도 각자 자기 조건으로 골라볼 수 있다. 선택은 localStorage에 기억.
'평일/주말'은 코트 이름 표기(예: '테니스장1(평일)')를 파싱 — 표기 없는 곳은 어느 필터에서든 노출.
"""
from __future__ import annotations

from fastapi import APIRouter
from fastapi.responses import HTMLResponse

router = APIRouter()

_PAGE = """<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<!-- iPhone '홈 화면에 추가' 시 전체화면 앱처럼 실행(사파리 스와이프 이탈 방지) -->
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="테니스알림">
<meta name="theme-color" content="#111827">
<title>🎾 테니스 예약 접수중</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --line:#e6e8eb; --muted:#6b7280; --accent:#2563eb; --kakao:#fee500; }
  * { box-sizing:border-box; }
  body { margin:0; font-family:"Malgun Gothic","맑은 고딕",system-ui,sans-serif; background:var(--bg); color:#111; }
  header { background:#111827; color:#fff; padding:18px 16px;
           padding-top:max(18px, env(safe-area-inset-top)); position:sticky; top:0; z-index:10; }
  header h1 { margin:0; font-size:18px; }
  header .sub { font-size:12px; color:#cbd5e1; margin-top:4px; }
  .wrap { max-width:760px; margin:0 auto; padding:16px; }
  .notice { background:#fffbeb; border:1px solid #fde68a; color:#78350f; font-size:12.5px;
            line-height:1.5; border-radius:10px; padding:11px 13px; margin-bottom:14px; }
  .filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
  .filters select, .filters input { border:1px solid var(--line); background:#fff; border-radius:8px;
            padding:8px 10px; font-size:13px; font-family:inherit; }
  .filters select { min-width:96px; }
  .filters input { flex:1; min-width:120px; }
  .bar { display:flex; align-items:center; gap:8px; margin-bottom:12px; }
  .count { font-weight:700; font-size:15px; }
  button.refresh { margin-left:auto; border:1px solid var(--line); background:#fff; padding:7px 12px; border-radius:8px; cursor:pointer; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px; margin-bottom:10px; }
  .row1 { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
  .region { background:#eef2ff; color:#3730a3; font-size:12px; padding:2px 8px; border-radius:20px; }
  .name { font-weight:600; font-size:15px; }
  .tags { margin-top:6px; display:flex; gap:6px; flex-wrap:wrap; }
  .tag { font-size:11px; padding:2px 8px; border-radius:6px; }
  .paid { background:#fef3c7; color:#92400e; }
  .free { background:#dcfce7; color:#166534; }
  .night { background:#e0e7ff; color:#3730a3; }
  .warn { background:#fee2e2; color:#991b1b; }
  .day { background:#f1f5f9; color:#334155; }
  a.book { display:inline-block; margin-top:10px; background:var(--kakao); color:#3c1e1e; text-decoration:none; font-weight:700; font-size:13px; padding:9px 14px; border-radius:8px; }
  .empty { text-align:center; color:var(--muted); padding:40px 0; }
  .section-title { font-size:13px; color:var(--muted); margin:18px 0 8px; }
  .linkcard { background:#fff; border:1px dashed var(--line); border-radius:10px; padding:12px; margin-bottom:8px; }
  .linkcard a { color:var(--accent); text-decoration:none; font-weight:600; }
  footer { text-align:center; color:var(--muted); font-size:12px; padding:20px; }
</style>
</head>
<body>
<header>
  <h1>🎾 서울 테니스 코트 · 예약 접수중</h1>
  <div class="sub">예약 접수가 열린 코트 목록 · 버튼을 눌러 예약 페이지로 이동</div>
</header>
<div class="wrap">
  <div class="notice">ℹ️ <b>접수중</b> = 예약 접수 기간이 열린 코트예요. 날짜·시간별 <b>실제 잔여</b>는
  예약 페이지의 달력에서 확인하세요(마감된 날짜도 있을 수 있어요). 서울시 공식 데이터라 여기까지 제공돼요.</div>
  <div class="filters">
    <select id="fRegion" onchange="save();render()"><option value="">전체 지역</option></select>
    <select id="fDay" onchange="save();render()">
      <option value="">평일+주말</option>
      <option value="wd">평일</option>
      <option value="we">주말·공휴일</option>
    </select>
    <select id="fFee" onchange="save();render()">
      <option value="">무료+유료</option>
      <option value="free">무료만</option>
      <option value="paid">유료만</option>
    </select>
    <input id="fQ" type="search" placeholder="코트 이름 검색" oninput="save();render()">
  </div>
  <div class="bar">
    <span class="count" id="count">불러오는 중…</span>
    <button class="refresh" onclick="load()">↻ 새로고침</button>
  </div>
  <div id="list"></div>
  <div id="links"></div>
</div>
<footer>서울 열린데이터광장 OA-2266 · 자동 예약은 하지 않습니다</footer>
<script>
let allSlots = [];
let linkOnly = [];

const WEEKEND_KW = ['주말','토/일','토,일','토·일','공휴일','토요일','일요일'];
function dayType(name) {
  const wd = name.includes('평일');
  const we = WEEKEND_KW.some(k => name.includes(k));
  if (wd && we) return 'both';
  if (wd) return 'wd';
  if (we) return 'we';
  return 'any'; // 표기 없음 → 어느 필터에서도 노출(기회를 숨기지 않음)
}

function save() {
  try {
    localStorage.setItem('tennisFilters', JSON.stringify({
      region: document.getElementById('fRegion').value,
      day: document.getElementById('fDay').value,
      fee: document.getElementById('fFee').value,
      q: document.getElementById('fQ').value,
    }));
  } catch (e) {}
}
function restore() {
  try {
    const s = JSON.parse(localStorage.getItem('tennisFilters') || '{}');
    if (s.day) document.getElementById('fDay').value = s.day;
    if (s.fee) document.getElementById('fFee').value = s.fee;
    if (s.q) document.getElementById('fQ').value = s.q;
    return s;
  } catch (e) { return {}; }
}

function render() {
  const region = document.getElementById('fRegion').value;
  const day = document.getElementById('fDay').value;
  const fee = document.getElementById('fFee').value;
  const q = document.getElementById('fQ').value.trim().toLowerCase();

  const rows = allSlots.filter(s => {
    if (region && (s.region || '') !== region) return false;
    if (day) {
      const t = dayType(s.facility || '');
      if (!(t === day || t === 'both' || t === 'any')) return false;
    }
    if (fee === 'free' && s.is_paid) return false;
    if (fee === 'paid' && !s.is_paid) return false;
    if (q) {
      const hay = ((s.facility || '') + ' ' + (s.court || '') + ' ' + (s.region || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  document.getElementById('count').textContent =
    '예약 접수중 ' + rows.length + '곳' + (rows.length !== allSlots.length ? ' (전체 ' + allSlots.length + ')' : '');

  const list = document.getElementById('list');
  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<div class="empty">조건에 맞는 코트가 없어요.<br>필터를 바꿔보세요.</div>';
    return;
  }
  for (const s of rows) {
    const div = document.createElement('div');
    div.className = 'card';
    let tags = '';
    tags += s.is_paid ? '<span class="tag paid">유료</span>' : '<span class="tag free">무료</span>';
    const t = dayType(s.facility || '');
    if (t === 'wd') tags += '<span class="tag day">평일</span>';
    else if (t === 'we') tags += '<span class="tag day">주말·공휴일</span>';
    else if (t === 'both') tags += '<span class="tag day">평일+주말</span>';
    if (s.is_night) tags += '<span class="tag night">야간</span>';
    if (s.eligibility) tags += '<span class="tag warn">자격: ' + s.eligibility + '</span>';
    const url = s.reserve_url || 'https://yeyak.seoul.go.kr';
    div.innerHTML =
      '<div class="row1"><span class="region">' + (s.region || '서울') + '</span>' +
      '<span class="name">' + s.facility + '</span></div>' +
      '<div class="tags">' + tags + '</div>' +
      '<a class="book" href="' + url + '">예약하러 가기 →</a>';
    list.appendChild(div);
  }
}

async function load() {
  const count = document.getElementById('count');
  count.textContent = '불러오는 중…';
  try {
    const r = await fetch('/preview?limit=500');
    const d = await r.json();
    allSlots = d.slots || [];
    linkOnly = d.link_only || [];

    // 지역 드롭다운 구성(가나다순) 후 저장된 선택 복원
    const regions = [...new Set(allSlots.map(s => s.region).filter(Boolean))].sort();
    const sel = document.getElementById('fRegion');
    const saved = restore();
    sel.innerHTML = '<option value="">전체 지역</option>' +
      regions.map(g => '<option value="' + g + '">' + g + '</option>').join('');
    if (saved.region && regions.includes(saved.region)) sel.value = saved.region;

    const links = document.getElementById('links');
    if (linkOnly.length) {
      let html = '<div class="section-title">🔗 사설/실내 코트 (자동감지 X · 바로가기)</div>';
      for (const l of linkOnly) {
        html += '<div class="linkcard"><a href="' + l.reserve_url + '">' + l.name + ' →</a>' +
                (l.note ? '<div style="font-size:12px;color:#6b7280;margin-top:4px">' + l.note + '</div>' : '') + '</div>';
      }
      links.innerHTML = html;
    }
    render();
  } catch (e) {
    count.textContent = '불러오기 실패 — 잠시 후 새로고침 해보세요';
  }
}
load();
</script>
</body>
</html>"""


@router.get("/", response_class=HTMLResponse)
def dashboard() -> str:
    return _PAGE
