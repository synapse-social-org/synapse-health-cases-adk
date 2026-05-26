"""Focused regression tests for the Health Cases Google ADK adapter."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

from services import health_cases_adk


class _FakeSessionService:
    async def create_session(self, **_kwargs):
        return None


class _FakeTypes:
    class Content:
        def __init__(self, *, role, parts):
            self.role = role
            self.parts = parts

    class Part:
        def __init__(self, *, text):
            self.text = text


class _FinalEvent:
    actions = None

    def __init__(self, text: str):
        self.content = SimpleNamespace(parts=[SimpleNamespace(text=text)])

    def is_final_response(self):
        return True


class _NonFinalEvent:
    def is_final_response(self):
        return False


def _patch_adk_runtime(monkeypatch, runner_cls) -> None:
    def _fake_import_adk_runtime():
        return None, None, None, runner_cls, _FakeSessionService, _FakeTypes

    monkeypatch.setattr(
        health_cases_adk,
        "_import_adk_runtime",
        _fake_import_adk_runtime,
    )


@pytest.mark.asyncio
async def test_run_agent_text_drains_adk_stream_after_final_response(monkeypatch):
    """ADK logs root-node cancellation when callers stop iterating early."""

    stream_state = {"completed": False, "closed_early": False}

    class _FakeRunner:
        def __init__(self, **_kwargs):
            pass

        async def run_async(self, **_kwargs):
            try:
                yield _FinalEvent('{"ok": true}')
                await asyncio.sleep(0)
                yield _FinalEvent('{"ok": false}')
                yield _NonFinalEvent()
                stream_state["completed"] = True
            finally:
                if not stream_state["completed"]:
                    stream_state["closed_early"] = True

    _patch_adk_runtime(monkeypatch, _FakeRunner)

    text = await health_cases_adk._run_agent_text(
        object(),
        "prompt",
        user_id="user",
        session_id="session",
    )

    assert text == '{"ok": true}'
    assert stream_state["completed"] is True
    assert stream_state["closed_early"] is False


@pytest.mark.asyncio
async def test_run_agent_text_keeps_final_response_when_drain_fails(
    monkeypatch, caplog
):
    breadcrumbs: list[dict[str, str]] = []

    class _FakeRunner:
        def __init__(self, **_kwargs):
            pass

        async def run_async(self, **_kwargs):
            yield _FinalEvent("")
            raise RuntimeError("late drain failure")

    _patch_adk_runtime(monkeypatch, _FakeRunner)
    monkeypatch.setattr(
        health_cases_adk.sentry_sdk,
        "add_breadcrumb",
        lambda **kwargs: breadcrumbs.append(kwargs),
    )

    text = await health_cases_adk._run_agent_text(
        object(),
        "prompt",
        user_id="user",
        session_id="session",
    )

    assert text == ""
    assert "Runner failed while draining after final response" in caplog.text
    assert breadcrumbs == [
        {
            "category": "health_case.adk",
            "message": "ADK stream drain failed after final response",
            "level": "warning",
        }
    ]
