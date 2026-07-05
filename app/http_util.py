"""외부호출 공통 유틸 — 타임아웃 + 지수백오프 재시도.

모든 외부 API 호출이 이 헬퍼를 거치게 해 한 곳에서 견고성을 보장한다.
"""
from __future__ import annotations

import asyncio
import logging

import httpx

logger = logging.getLogger("tennis.http")

DEFAULT_TIMEOUT = httpx.Timeout(10.0, connect=5.0)


async def request_with_retry(
    method: str,
    url: str,
    *,
    retries: int = 3,
    backoff_base: float = 0.8,
    **kwargs,
) -> httpx.Response:
    """지수백오프 재시도. 모든 시도가 실패하면 마지막 예외를 올린다.

    호출측(스케줄러 잡)에서 try/except로 감싸 한 주기 실패가 전체를 죽이지 않게 한다.
    """
    kwargs.setdefault("timeout", DEFAULT_TIMEOUT)
    last_exc: Exception | None = None
    async with httpx.AsyncClient() as client:
        for attempt in range(retries):
            try:
                resp = await client.request(method, url, **kwargs)
                resp.raise_for_status()
                return resp
            except (httpx.HTTPError, httpx.TransportError) as exc:
                last_exc = exc
                wait = backoff_base * (2 ** attempt)
                logger.warning(
                    "외부호출 실패 (%d/%d) %s — %s. %.1fs 후 재시도",
                    attempt + 1, retries, _safe_url(url), type(exc).__name__, wait,
                )
                if attempt < retries - 1:
                    await asyncio.sleep(wait)
    assert last_exc is not None
    raise last_exc


def _safe_url(url: str) -> str:
    """로그에 키가 노출되지 않도록 path 일부를 마스킹."""
    # 서울 API는 경로에 키가 들어가므로 호스트만 남긴다.
    try:
        parsed = httpx.URL(url)
        return f"{parsed.scheme}://{parsed.host}/…"
    except Exception:
        return "<url>"
