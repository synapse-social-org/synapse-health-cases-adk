"""Google Search-grounded web discourse helper for Evidence MCP."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any, Optional


def run_web_discourse(
    *,
    query: str,
    recency_days: int = 30,
) -> dict[str, Any]:
    """Run the standalone web discourse agent when ADK + Google Search are available."""
    from services.health_cases_adk import (
        DEFAULT_MODEL,
        HealthCaseADKUnavailable,
        _ensure_google_api_key,
        _import_adk_runtime,
        _import_google_search_tool,
        _run_async,
        _run_agent_text,
        should_use_adk,
    )

    cleaned = (query or "").strip()
    if not cleaned:
        return {"query": cleaned, "items": []}

    if not should_use_adk():
        raise HealthCaseADKUnavailable("HEALTH_CASE_AGENT_BACKEND is not adk")

    _ensure_google_api_key()
    Agent, *_ = _import_adk_runtime()
    google_search_tool = _import_google_search_tool()
    if google_search_tool is None:
        return {
            "query": cleaned,
            "items": [],
            "warnings": ["Google Search tool unavailable in this environment."],
        }

    agent = Agent(
        model=DEFAULT_MODEL,
        name="web_discourse_agent",
        description="Grounds a query in recent public discourse via Google Search.",
        instruction=(
            "Use Google Search to find recent real-time signals relevant to the query. "
            f"Prefer items from the last {recency_days} days. Return JSON only with "
            "an `items` array. Each item must include source_url, source_type "
            "(society|news|expert_post|preprint_signal), excerpt, captured_at."
        ),
        tools=[google_search_tool],
    )
    prompt = (
        "Find recent discourse for this biomedical query and return JSON only:\n"
        f"{json.dumps({'query': cleaned, 'recency_days': recency_days})}"
    )
    raw = _run_async(
        _run_agent_text(
            agent,
            prompt,
            user_id="mcp_web_discourse",
            session_id=f"web_discourse_{int(datetime.now(timezone.utc).timestamp())}",
        ),
        timeout_seconds=45.0,
    )
    return _parse_web_discourse_response(cleaned, raw)


def _parse_web_discourse_response(query: str, raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if not text:
        return {"query": query, "items": []}

    json_match = re.search(r"\{.*\}", text, re.DOTALL)
    if json_match:
        try:
            payload = json.loads(json_match.group(0))
            items = payload.get("items") if isinstance(payload, dict) else None
            if isinstance(items, list):
                return {
                    "query": query,
                    "items": [_normalize_item(item) for item in items],
                }
        except json.JSONDecodeError:
            pass

    return {
        "query": query,
        "items": [
            {
                "source_url": None,
                "source_type": "news",
                "excerpt": text[:500],
                "captured_at": datetime.now(timezone.utc).isoformat(),
            }
        ],
    }


def _normalize_item(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict):
        return {
            "source_url": None,
            "source_type": "news",
            "excerpt": str(item)[:500],
            "captured_at": datetime.now(timezone.utc).isoformat(),
        }
    return {
        "source_url": item.get("source_url"),
        "source_type": item.get("source_type") or "news",
        "excerpt": (item.get("excerpt") or "")[:500],
        "captured_at": item.get("captured_at")
        or datetime.now(timezone.utc).isoformat(),
    }
