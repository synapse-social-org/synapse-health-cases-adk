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


class _StreamEvent:
    """Fake ADK event with author/partial/content for streaming tests."""

    actions = None

    def __init__(self, *, author=None, text="", partial=False, final=False):
        self.author = author
        self.partial = partial
        self._final = final
        parts = [SimpleNamespace(text=text)] if text else []
        self.content = SimpleNamespace(parts=parts)

    def is_final_response(self):
        return self._final


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


def test_build_brief_assigns_fast_model_to_subagents_pro_to_synthesis(monkeypatch):
    """Sub-agents + topics run on the flash tier; synthesis on the pro tier."""

    agents = {}

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

    monkeypatch.setattr(
        health_cases_adk, "_import_adk_runtime", _fake_import_adk_runtime
    )
    monkeypatch.setattr(health_cases_adk, "_mcp_enabled", lambda: False)
    monkeypatch.setattr(health_cases_adk, "_import_google_search_tool", lambda: None)
    monkeypatch.setattr(health_cases_adk, "_build_exa_agent", lambda *_args: None)

    def paper_search():
        return {}

    health_cases_adk.build_health_case_brief_root_agent(
        model="pro-tier",
        fast_model="flash-tier",
        tools=[paper_search],
    )

    for name in (
        "evidence_research_agent",
        "clinical_trial_agent",
        "researcher_match_agent",
        "intervention_topics_agent",
    ):
        assert agents[name].model == "flash-tier", name
    assert agents["health_case_brief_synthesis_agent"].model == "pro-tier"


def test_record_tool_result_forwards_to_live_sink():
    """Recorded tool events fire the live sink immediately."""

    captured: list[dict] = []
    state = health_cases_adk._ToolRunState(sink=captured.append)

    health_cases_adk._record_tool_result(
        state,
        "paper_search",
        {"data": {"hits": 1}, "papers_cited": [{"id": "p1"}]},
    )

    assert len(captured) == 1
    assert captured[0]["tool"] == "paper_search"
    assert captured[0]["type"] == "tool_result"
    # Still recorded for the post-run summary as before.
    assert state.tool_events == captured
    assert state.papers_cited == [{"id": "p1"}]


@pytest.mark.asyncio
async def test_run_agent_text_streams_progress_and_content(monkeypatch):
    """on_event surfaces per-agent progress + synthesis content deltas."""

    class _FakeRunner:
        def __init__(self, **_kwargs):
            pass

        async def run_async(self, **_kwargs):
            yield _StreamEvent(author="evidence_research_agent")
            yield _StreamEvent(
                author=health_cases_adk.SYNTHESIS_AGENT_NAME,
                text="Hello ",
                partial=True,
            )
            yield _StreamEvent(
                author=health_cases_adk.SYNTHESIS_AGENT_NAME,
                text="world",
                partial=True,
            )
            yield _StreamEvent(
                author=health_cases_adk.SYNTHESIS_AGENT_NAME,
                text="Hello world",
                final=True,
            )

    _patch_adk_runtime(monkeypatch, _FakeRunner)
    monkeypatch.setattr(health_cases_adk, "_streaming_run_config", lambda: None)

    out: list[dict] = []
    text = await health_cases_adk._run_agent_text(
        object(),
        "prompt",
        user_id="user",
        session_id="session",
        on_event=out.append,
        stream_content=True,
        content_author=health_cases_adk.SYNTHESIS_AGENT_NAME,
    )

    assert text == "Hello world"
    contents = [e["content"] for e in out if e["type"] == "content"]
    assert contents == ["Hello ", "world"]
    thinking = [e["content"] for e in out if e["type"] == "thinking"]
    assert any("Synthesizing" in t for t in thinking)
    assert any(e["type"] == "content_streamed" for e in out)


def test_stream_brief_emits_live_events_and_done(monkeypatch):
    """End-to-end: progress, streamed content, then a done event with metadata."""

    class _FakeAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class _FakeParallelAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class _FakeSequentialAgent:
        def __init__(self, **kwargs):
            self.__dict__.update(kwargs)

    class _FakeRunner:
        def __init__(self, **_kwargs):
            pass

        async def run_async(self, **_kwargs):
            yield _StreamEvent(author="evidence_research_agent")
            yield _StreamEvent(
                author=health_cases_adk.SYNTHESIS_AGENT_NAME,
                text="Brief body",
                partial=True,
            )
            yield _StreamEvent(
                author=health_cases_adk.SYNTHESIS_AGENT_NAME,
                text="Brief body",
                final=True,
            )

    def _fake_import_adk_runtime():
        return (
            _FakeAgent,
            _FakeParallelAgent,
            _FakeSequentialAgent,
            _FakeRunner,
            _FakeSessionService,
            _FakeTypes,
        )

    monkeypatch.setattr(
        health_cases_adk, "_import_adk_runtime", _fake_import_adk_runtime
    )
    monkeypatch.setattr(health_cases_adk, "should_use_adk", lambda: True)
    monkeypatch.setattr(health_cases_adk, "_ensure_google_api_key", lambda: None)
    monkeypatch.setattr(health_cases_adk, "_mcp_enabled", lambda: False)
    monkeypatch.setattr(health_cases_adk, "_import_google_search_tool", lambda: None)
    monkeypatch.setattr(health_cases_adk, "_build_exa_agent", lambda *_args: None)
    monkeypatch.setattr(health_cases_adk, "_streaming_run_config", lambda: None)

    import services.research_agent_extensions as rae

    monkeypatch.setattr(rae, "grounding_enabled", lambda: False)

    import json

    prompt = "Build a brief.\nHealth Case profile JSON:\n" + json.dumps(
        {"condition_terms": ["MacTel", "CKD"], "profile": {}}
    )
    events = list(
        health_cases_adk.stream_health_case_brief_adk(
            prompt=prompt,
            user_id="user",
        )
    )

    assert events[0]["type"] == "thinking"
    contents = [e["content"] for e in events if e["type"] == "content"]
    assert contents == ["Brief body"]
    done = events[-1]
    assert done["type"] == "done"
    assert done["metadata"]["agent_backend"] == "google_adk"
    assert "health_case_brief_synthesis_agent" in done["metadata"]["adk_agents"]

    # Feed suggestions must precede brief content (ordering clients rely on).
    types = [e["type"] for e in events]
    assert "feed_suggestion" in types
    assert types.index("feed_suggestion") < types.index("content")


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
