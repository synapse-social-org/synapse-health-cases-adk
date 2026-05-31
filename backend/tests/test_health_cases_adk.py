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


def test_brief_trial_agent_dedupes_inline_clinical_trials_when_mcp_enabled(
    monkeypatch,
):
    """MCP and the inline fallback both expose ``clinical_trials_lookup``."""

    agents = {}
    mcp_toolset = object()

    class _FakeAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)
            agents[self.name] = self

    class _FakeParallelAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class _FakeSequentialAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    def _fake_import_adk_runtime():
        return _FakeAgent, _FakeParallelAgent, _FakeSequentialAgent, None, None, None

    def paper_search():
        return {}

    def clinical_trials_lookup():
        return {}

    def researcher_match():
        return {}

    tools = [paper_search, clinical_trials_lookup, researcher_match]
    monkeypatch.setattr(
        health_cases_adk, "_import_adk_runtime", _fake_import_adk_runtime
    )
    monkeypatch.setattr(health_cases_adk, "_mcp_enabled", lambda: True)
    monkeypatch.setattr(health_cases_adk, "_build_mcp_toolset", lambda: mcp_toolset)
    monkeypatch.setattr(health_cases_adk, "_import_google_search_tool", lambda: None)
    monkeypatch.setattr(health_cases_adk, "_build_exa_agent", lambda *_args: None)

    health_cases_adk.build_health_case_brief_root_agent(
        model="gemini-test",
        tools=tools,
    )

    trial_tools = agents["clinical_trial_agent"].tools
    assert trial_tools == [paper_search, researcher_match, mcp_toolset]
    assert (
        sum(
            1
            for tool in trial_tools
            if getattr(tool, "__name__", "") == "clinical_trials_lookup"
        )
        == 0
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
