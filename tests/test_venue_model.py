"""v6 화면 — 테니스장 모델(buildVenues)과 화면 뼈대.

화면(app/static/dashboard.html)의 계산 부분만 떼어 Node 로 돌린다(tests/js/venue_harness.js).
기준: docs/REDESIGN_V6.md §4.1(지금 예약 칸) · §4.2(다음 예약 오픈 칸) · §10.1(buildVenues 계약).
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
PAGE = ROOT / "app" / "static" / "dashboard.html"
AREAS = ["한남", "장충", "마루공원", "선우공원", "서울숲", "잠원", "대치유수지"]


@pytest.fixture(scope="module")
def out() -> dict:
    if shutil.which("node") is None:
        pytest.skip("node 가 없으면 화면 검사는 건너뛴다")
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "venue_harness.js")],
                       capture_output=True, text=True, encoding="utf-8", timeout=60)
    assert r.returncode == 0, r.stderr
    return json.loads(r.stdout.strip().splitlines()[-1])


def rows(case: dict) -> dict:
    """[곳, 지금 상태, 색, 큰 글자, 작은 글자, 다음 상태, 큰 글자, 작은 글자, 24시간 안] → 곳별 사전"""
    return {r[0]: {"now": r[1:5], "next": r[5:9]} for r in case["list"]}


# ── 실제 응답: 한남 예약이 열린 직후(2026-11-15 09:02:52) ─────────────────

def test_live_sample_just_after_hannam_opened(out):
    v = rows(out["live"])
    assert list(v) == AREAS + ["반포"]                                   # 늘 같은 순서, 반포는 서버가 줄 때만
    # 한남: 19건의 예약 = 코트 11개(같은 코트의 시간대는 한 번만). 3분 뒤 추가 오픈은 따로 '다음 예약 오픈'으로
    assert v["한남"]["now"] == ["hot", "go", "오늘 열림", "09:00 시작 · 코트 11개"]
    assert v["한남"]["next"] == ["date", "오늘 09:03", "8초 남음", True]
    # 장충: 실제로 예약 받는 중이면 공지 일정과 상관없이 초록. 다음 오픈은 시설 공지 일정
    assert v["장충"]["now"] == ["open", "go", "예약 받는 중", "코트 2개"]
    assert v["장충"]["next"] == ["date", "11.25(수) 10:00", "10일 남음 · 공지 일정", False]
    # 마루공원: 조명 예약 6건 = 코트 3개, 상시 예약이라 오픈 날이 따로 없다
    assert v["마루공원"]["now"] == ["open", "go", "예약 받는 중", "코트 3개"]
    assert v["마루공원"]["next"] == ["always", "따로 없음", "정해진 날이 없어요", False]
    # 선우공원: 달마다 접수하는 곳 — 다음 오픈을 모르면 지난번 날짜를 알려 준다
    assert v["선우공원"]["now"] == ["open", "go", "예약 받는 중", "코트 1개"]
    assert v["선우공원"]["next"] == ["unknown", "아직 몰라요", "지난번 10.27(화) 09:30", False]
    # 서울숲: 번호 없는 예약은 건수로. 미래 오픈이 있으면 상시 예약보다 그 날짜가 먼저
    assert v["서울숲"]["now"] == ["open", "go", "예약 받는 중", "예약 1건"]
    assert v["서울숲"]["next"] == ["date", "12.1(화) 09:01", "16일 남음", False]
    # 반포: 가장 이른 빈 시간(오늘이 아니면 날짜를 적는다)
    # 잠원 · 대치유수지: 이 응답(두 곳을 넣기 전에 받은 것)에는 자료가 없다 — 지어내지 않는다
    assert v["잠원"]["now"] == ["none", "off", "정보 없음", "올라온 예약이 없어요"]
    assert v["대치유수지"]["now"] == ["ext", "off", "직접 확인", "예약 사이트에서 봐요"]     # 자체 예약 사이트 — 여기서는 상태를 모른다
    assert v["대치유수지"]["next"] == ["unknown", "아직 몰라요", "일정이 아직 없어요", False]
    assert v["반포"]["now"] == ["free", "go", "빈 시간 있음", "11.17(화) 14~15시"]
    assert v["반포"]["next"] == ["date", "내일 09:00", "23시간 58분 남음", True]
    assert out["live"]["hot"] == [["한남", "2026-11-15 09:00", False]]
    assert out["live"]["next"] == ["한남", "2026-11-15 09:03"]            # 큰 카드에 같이 보여 줄 '곧 열려요'


def test_live_sample_lists_keep_everything_reachable(out):
    d = out["liveDetail"]
    # 오늘 열린 19건은 '오늘 열린 예약'에서 보여 주므로 아래 목록에서는 뺀다 → 지난 회차 20건만 남는다
    assert d["한남"] == {"hot": 1, "cold": 0, "upcoming": 1, "avail": 0, "shut": 20, "past": 2,
                        "rule": "매월 15일·말일 09:00", "region": "용산구", "kind": "seoul"}
    assert (d["장충"]["avail"], d["장충"]["shut"]) == (2, 28)
    assert (d["마루공원"]["avail"], d["마루공원"]["shut"]) == (6, 0)
    assert d["반포"]["kind"] == "play" and d["반포"]["region"] == "서초구"


def test_live_sample_three_hours_later(out):
    v = rows(out["liveLater"])
    # 2시간이 지나면 '오늘 열림'이 아니다. 상태가 안 올라온 코트만 남았으니 직접 확인하라고 한다
    assert v["한남"]["now"] == ["check", "warn", "확인 필요", "예약 화면에서 확인"]
    assert v["한남"]["next"] == ["unknown", "아직 몰라요", "지난번 11.15(일) 09:00", False]
    assert out["liveLater"]["hot"] == []
    assert out["liveLater"]["next"] == ["장충", "2026-11-25 10:00"]


def test_sorting(out):
    s = out["liveSort"]
    assert s["base"] == AREAS + ["반포"]                                  # 늘 같은 자리
    # 오늘 열림 → 예약 받는 중(반포의 빈 시간 포함) → 그 밖(같으면 기본 순서)
    assert s["now"] == ["한남", "장충", "마루공원", "선우공원", "서울숲", "반포", "잠원", "대치유수지"]
    # 빨리 열리는 순, 날짜 없는 곳은 뒤
    assert s["soon"] == ["한남", "반포", "장충", "서울숲", "마루공원", "선우공원", "잠원", "대치유수지"]


# ── 미리보기 자료(?mock=…) ────────────────────────────────────────────

def test_states_from_previews(out):
    assert rows(out["opened"])["한남"]["now"][:3] == ["hot", "go", "오늘 열림"]
    assert rows(out["late"])["한남"]["now"] == ["check", "warn", "확인 필요", "예약 화면에서 확인"]
    assert rows(out["next"])["한남"]["now"] == ["ended", "off", "예약 끝남", "다음 오픈을 기다려요"]
    # 코트 자료는 없고 다음 오픈만 있는 곳
    assert rows(out["soon"])["한남"]["now"] == ["wait", "off", "예약 시작 전", "열리는 날을 기다려요"]
    assert rows(out["soon"])["한남"]["next"] == ["date", "오늘 12:42", "42분 남음", True]
    e = rows(out["empty"])
    assert e["장충"]["now"] == ["full", "off", "모두 마감", "코트 6개"]
    assert e["마루공원"]["now"] == ["none", "off", "정보 없음", "올라온 예약이 없어요"]
    assert e["서울숲"]["now"] == ["full", "off", "모두 마감", "예약 2건"]
    assert e["서울숲"]["next"][:2] == ["always", "따로 없음"]            # 모두 마감이어도 상시 예약인 곳은 그대로
    assert out["empty"]["next"] is None and out["none"]["next"] is None


def test_notice_schedule(out):
    n = rows(out["notice"])
    assert n["한남"]["next"] == ["date", "11.13(금) 09:00", "3일 남음 · 공지 일정", False]
    p = rows(out["passed"])
    # 공지된 오픈 시각이 지났는데 서울시 자료에 새 예약이 없다 — '열렸다'고 하지 않는다
    assert p["한남"]["now"] == ["check", "warn", "확인 필요", "11:40 공지 시각 지남"]
    assert out["passed"]["hot"] == [["한남", "2026-11-10 11:40", True]]
    assert out["passed"]["next"][0] == "장충"


def test_banpo_states(out):
    assert rows(out["play"])["반포"]["now"] == ["free", "go", "빈 시간 있음", "오늘 20~22시 외"]
    assert rows(out["playfull"])["반포"]["now"] == ["full", "off", "빈 시간 없음", "11.10~11.17 확인"]
    assert rows(out["playerr"])["반포"]["now"] == ["error", "off", "확인 못 함", "테니스플레이에서 확인"]
    assert "반포" not in rows(out["next"])                               # 반포를 읽지 않는 서버에는 카드가 없다
    assert out["play"]["next"][0] == "장충"                               # 큰 카드는 5곳 기준(반포는 매일 열려서 뺀다)


def test_bad_input_never_breaks(out):
    for key in ("garbage", "emptyObj"):
        v = rows(out[key])
        assert list(v) == AREAS
        assert all(x["now"] == ["none", "off", "정보 없음", "올라온 예약이 없어요"] for a, x in v.items() if a != "대치유수지")
        assert v["대치유수지"]["now"] == ["ext", "off", "직접 확인", "예약 사이트에서 봐요"]
        assert all(x["next"] == ["unknown", "아직 몰라요", "일정이 아직 없어요", False] for x in v.values())
        assert out[key]["hot"] == [] and out[key]["next"] is None


# ── Codex 가 설계 기준서만 보고 쓴 독립 시험(100건) ─────────────────────

def test_independent_cases_written_by_codex():
    if shutil.which("node") is None:
        pytest.skip("node 가 없으면 화면 검사는 건너뛴다")
    r = subprocess.run(["node", str(ROOT / "tests" / "js" / "venue_model_cases.js")],
                       capture_output=True, text=True, encoding="utf-8", timeout=120)
    assert r.returncode == 0, r.stdout[-3000:] + r.stderr[-1000:]
    assert r.stdout.strip().splitlines()[-1].startswith("PASS ")


# ── 화면 뼈대 ─────────────────────────────────────────────────────────

def test_page_structure():
    page = PAGE.read_text(encoding="utf-8")
    # 계산 부분과 화면 부분의 경계 — 시험이 이 표시로 계산 부분만 떼어 낸다
    assert page.count("/* MODEL-END */") == 1
    assert page.index("function buildVenues(") < page.index("/* MODEL-END */") < page.index("function renderBoard(")
    # 아래 탭 3개 · 테니스장 고르기 줄 · 한 곳 화면 · 정렬
    for part in ('id="nav"', 'data-tab="home"', 'data-tab="alerts"', 'data-tab="more"', 'id="chips"',
                 'id="home-all"', 'id="home-one"', 'id="sort"', 'id="page-alerts"', 'id="page-more"'):
        assert part in page, part
    # 스윙 코치로 가는 탭은 따로 둔 <nav class="tabs"> 하나뿐 — 열쇠가 없는 기기에는 서버가 이 줄만 통째로 뺀다
    assert page.count('<nav class="tabs"') == 1 and page.count('href="/coach"') == 1
    assert page.index('<nav class="tabs"') < page.index('<div class="app"') < page.index('<nav class="nav"')
    from app.routers.dashboard import without_coach
    bare = without_coach(page)
    assert '<nav class="tabs"' not in bare and 'href="/coach"' not in bare
    assert '<nav class="nav" id="nav"' in bare and bare.count('data-act="tab"') >= 3      # 홈 · 알림 · 더보기는 그대로
    assert "#main{padding-bottom:" in bare                                                 # 아래 여백은 main 에(.app 여백을 0 으로 해도 남는다)
    # 알림 설정에 쓰는 자리(웹 푸시 코드가 찾는 이름)
    for el in ("master", "push-status", "install", "prefs", "areas", "d1", "h1", "free", "free-row", "play-hint", "test",
               "toast", "stamp", "refresh", "fresh", "stale"):
        assert f'id="{el}"' in page, el
    # 화면은 서버의 정해진 주소만 부른다
    assert "/^\\/(board|refresh|push\\/(key|subscribe|unsubscribe|test))$/" in page
    # 예약 링크는 서울시 · 테니스플레이일 때만
    assert "seoul\\.go\\.kr$" in page and "www.thetennisplay.com" in page
    # 서버 글자를 그대로 화면에 넣는 곳이 없다(esc 를 거친다) — 대표적인 자리 확인
    assert "${esc(v.name)}" in page and "${esc(x.text)}" in page and "${esc(sub)}" in page


def test_court_surface_of_each_venue(out):
    """코트 그림의 바닥 종류 — 공개된 시설 안내에서 확인한 것만 적는다(모르는 곳은 빈 값 = 회색 그림)."""
    assert out["surface"] == {"한남": "인조잔디", "장충": "하드 코트", "마루공원": "인조잔디", "선우공원": "인조잔디",
                              "서울숲": "인조잔디", "잠원": "클레이", "대치유수지": "하드 코트", "반포": "인조잔디 · 클레이",
                              "없는곳": ""}
    page = PAGE.read_text(encoding="utf-8")
    assert "function courtArt(" in page and 'class="court-art"' in page


def test_two_more_places_in_the_previews(out):
    """잠원(서울시 자료가 오는 곳)은 다른 곳과 같은 칸을 쓰고, 대치유수지(자체 예약 사이트)는 정기 오픈 일정만 보여 준다."""
    v = rows(out["next"])
    assert v["잠원"]["now"] == ["open", "go", "예약 받는 중", "코트 3개"]
    assert v["대치유수지"]["now"] == ["ext", "off", "직접 확인", "예약 사이트에서 봐요"]
    assert v["대치유수지"]["next"] == ["date", "11.30(월) 09:00", "20일 남음 · 공지 일정", False]
    page = PAGE.read_text(encoding="utf-8")
    # 예약 사이트 바로가기는 화면에 적어 둔 그 한 곳뿐(서버가 준 주소를 쓰지 않는다)
    assert page.count("http://www.xn--vk1b79znxd34c61h.kr/") == 1 and "function extNowSecHTML(" in page
    assert "'잠원': 'jamwon', '대치유수지': 'daechi'" in page


def test_guidance_lives_on_the_venue_card_and_same_button_closes():
    """사용자 의견(2026-11-15): 맨 위 큰 카드 대신 테니스장 카드 안에서 안내, [코트 예약 보기]를 다시 누르면 닫힘, 뒤로 버튼은 그대로."""
    page = PAGE.read_text(encoding="utf-8")
    for gone in ("heroHTML", "hero-ball", "hero-bell", "hero-item", "다음 예약 오픈</p>"):
        assert gone not in page, gone
    assert "function noteHTML(" in page and "에 예약이 열렸어요. 빈자리는 예약 화면에서 확인해요." in page
    assert "'코트 예약 닫기' : '코트 예약 보기'" in page and 'aria-expanded="${on}"' in page
    assert "view.tab === 'home' && view.area === a ? '' : a" in page          # 열려 있는 곳을 다시 누르면 전체로
    assert '<button class="back" data-act="venue" data-area="">' in page       # 뒤로 버튼


def test_page_has_no_leftovers_from_v5():
    page = PAGE.read_text(encoding="utf-8")
    for old in ("<dialog", "openSheet", "sheetShown", "renderPlay(", "goPlay(", "pickPlay(", 'id="bell"', "push-value"):
        assert old not in page, old
    script = re.search(r"<script>\n(.*)</script>", page, re.S).group(1)
    # 쓰는 말 규칙(§8): 화면에 보이는 글자에 행정 용어 · 약어가 없다
    for word in ("D-", "미정", "회차가"):
        assert word not in script.split("/* ── 미리보기 데이터")[0] + script.split("/* MODEL-END */")[1], word
