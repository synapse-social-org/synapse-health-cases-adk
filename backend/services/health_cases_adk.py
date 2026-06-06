"""Google ADK adapter for Synapse Health Cases.

This module keeps Health Cases' existing Flask/SSE contract intact while
running the competition path through a Google ADK multi-agent workflow when the
``google-adk`` package is available. The fallback remains the legacy research
agent so production never fails closed because an optional agent runtime is
missing in a lightweight environment.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sys
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

import sentry_sdk

logger = logging.getLogger(__name__)

APP_NAME = "synapse_health_case_navigator"
SYNTHESIS_AGENT_NAME = "health_case_brief_synthesis_agent"
# The "pro" tier is reserved for the final synthesis pass (quality matters most
# there). The parallel research fan-out + topics extraction run on the faster
# "flash" tier so the bulk of the wall-clock — many concurrent tool-calling
# turns — finishes far quicker. Both are overridable per-environment.
DEFAULT_MODEL = os.environ.get("HEALTH_CASE_ADK_MODEL", "gemini-3.1-pro-preview")
# Newest full-flash tier (verified accessible on our key): fast + cheap, yet
# supports function calling and Google Search grounding, which the research
# sub-agents require. Pinned (not the moving ``gemini-flash-latest`` alias) so
# a model rollout can't silently shift production behavior.
DEFAULT_FAST_MODEL = os.environ.get("HEALTH_CASE_ADK_FAST_MODEL", "gemini-3.5-flash")
DEFAULT_INTAKE_TIMEOUT_SECONDS = float(
    os.environ.get("HEALTH_CASE_ADK_INTAKE_TIMEOUT_SECONDS", 120)
)
# Internal ADK cap is kept strictly below the route's SSE wall-clock ceiling
# (see ``max_wait_seconds`` in backend/api/routes/health_case/__init__.py) so a
# timed-out ADK run still leaves runway for the legacy fallback inside the same
# client connection instead of both racing the same deadline.
DEFAULT_BRIEF_TIMEOUT_SECONDS = float(
    os.environ.get("HEALTH_CASE_ADK_BRIEF_TIMEOUT_SECONDS", 300)
)

_GOOGLE_API_KEY_LOCK = threading.Lock()
_GOOGLE_API_KEY_CONFIGURED = False


class HealthCaseADKUnavailable(RuntimeError):
    """Raised when ADK cannot run and the caller should use the legacy path."""


@dataclass
class _ToolRunState:
    tool_events: list[dict[str, Any]] = field(default_factory=list)
    papers_cited: list[dict[str, Any]] = field(default_factory=list)
    # Optional callback invoked the moment a tool finishes, so the brief can
    # stream ``tool_result`` events live instead of dumping them after the
    # whole multi-agent run completes. Stays ``None`` for non-streaming callers
    # (e.g. tests), preserving the original collect-then-return behavior.
    sink: Callable[[dict[str, Any]], None] | None = None


def should_use_adk() -> bool:
    """Return whether Health Cases should attempt the ADK path.

    Defaults to "adk" so the Google ADK multi-agent workflow is the
    production code path; the legacy executor remains wired up as an
    automatic fallback inside `_source_events` (see
    `backend/api/routes/health_case/__init__.py`). Set
    HEALTH_CASE_AGENT_BACKEND=legacy in an environment to opt back out.
    """

    return os.environ.get("HEALTH_CASE_AGENT_BACKEND", "adk").lower() == "adk"


def _ensure_google_api_key() -> None:
    """ADK reads GOOGLE_API_KEY; Synapse historically stores GEMINI_API_KEY."""

    global _GOOGLE_API_KEY_CONFIGURED
    if _GOOGLE_API_KEY_CONFIGURED:
        return
    gemini_key = os.environ.get("GEMINI_API_KEY")
    with _GOOGLE_API_KEY_LOCK:
        if gemini_key and not os.environ.get("GOOGLE_API_KEY"):
            os.environ["GOOGLE_API_KEY"] = gemini_key
        _GOOGLE_API_KEY_CONFIGURED = True


def _import_adk_runtime():
    try:
        from google.adk.agents.llm_agent import Agent
        from google.adk.agents.parallel_agent import ParallelAgent
        from google.adk.agents.sequential_agent import SequentialAgent
        from google.adk.runners import Runner
        from google.adk.sessions import InMemorySessionService
        from google.genai import types
    except Exception as exc:  # pragma: no cover - depends on optional package
        raise HealthCaseADKUnavailable(str(exc)) from exc

    return Agent, ParallelAgent, SequentialAgent, Runner, InMemorySessionService, types


def _mcp_enabled() -> bool:
    return os.environ.get("HEALTH_CASE_ENABLE_MCP", "true").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _build_mcp_toolset():
    """Spawn the Health Cases MCP server and return an ADK McpToolset.

    Returns ``None`` when MCP is unavailable so the brief can fall back to the
    inline ``clinical_trials_lookup`` function tool without failing closed.
    """

    try:
        from google.adk.tools.mcp_tool.mcp_toolset import (
            McpToolset,
            StdioConnectionParams,
        )
        from mcp import StdioServerParameters
    except Exception as exc:  # pragma: no cover - depends on optional package
        logger.warning("Health Cases MCP toolset unavailable: %s", exc)
        return None

    backend_dir = Path(__file__).resolve().parent.parent
    try:
        return McpToolset(
            connection_params=StdioConnectionParams(
                server_params=StdioServerParameters(
                    command=sys.executable,
                    args=["-m", "services.mcp.synapse_mcp_server"],
                    cwd=str(backend_dir),
                ),
            ),
            tool_filter=["clinical_trials_lookup"],
        )
    except Exception as exc:  # pragma: no cover - spawn failures are env-specific
        logger.warning("Failed to configure Health Cases MCP toolset: %s", exc)
        sentry_sdk.capture_exception(exc)
        return None


def _import_google_search_tool():
    """Import the ADK built-in Google Search grounding tool.

    Returned as a separate import so the absence of the tool (older ADK
    versions, or environments where Google Search grounding is not enabled
    on the API key) downgrades cleanly to "no web-discourse agent" rather
    than failing the whole brief.
    """

    try:
        from google.adk.tools import google_search

        return google_search
    except Exception:  # pragma: no cover - depends on optional package
        return None


def _streaming_run_config():
    """Return an ADK ``RunConfig`` for token streaming, or ``None``.

    Token streaming lets the synthesis agent's output flow to the client as it
    is generated. If the installed ADK version doesn't expose it, we degrade to
    a single end-of-run chunk rather than failing the brief.
    """

    try:
        from google.adk.agents.run_config import RunConfig, StreamingMode

        return RunConfig(streaming_mode=StreamingMode.SSE)
    except Exception:  # pragma: no cover - depends on optional package
        return None


_AGENT_PROGRESS = {
    "health_case_parallel_research": "Researching in parallel: evidence, trials, researchers, real-time signals...",
    "evidence_research_agent": "Searching papers, guidelines, and evidence graph...",
    "clinical_trial_agent": "Looking up relevant clinical trials...",
    "researcher_match_agent": "Matching relevant researchers and centers...",
    "web_discourse_agent": "Grounding in real-time discourse via Google Search...",
    "exa_web_research_agent": "Broadening discovery via Exa web search...",
    "intervention_topics_agent": "Distilling citation-grounded discussion topics...",
    SYNTHESIS_AGENT_NAME: "Synthesizing your Expert Research brief...",
}


def _agent_progress_message(author: str | None) -> str | None:
    if not author:
        return None
    return _AGENT_PROGRESS.get(author)


def _exa_enabled() -> bool:
    """Exa enrichment is opt-in for the brief via HEALTH_CASE_ENABLE_EXA."""
    return os.environ.get("HEALTH_CASE_ENABLE_EXA", "false").lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


def exa_web_search(query: str) -> dict:
    """ADK function tool: broad web/news search for a Health Case via Exa.

    Surfaces authoritative web sources (guideline pages, society/regulatory
    statements, reputable news) that PubMed/OpenAlex miss. Always safe to call;
    returns an empty list when Exa is unconfigured or errors.

    Args:
        query: A focused clinical web query (condition, drug, guideline, trial,
            or expert name).

    Returns:
        A dict with a ``results`` list of ``{title, url, published_date,
        snippet}``.
    """
    try:
        from services.exa import search_news

        raw = search_news(query, num_results=6) or []
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Exa web search failed: %s", exc)
        return {"results": []}

    results = []
    for item in raw:
        if not isinstance(item, dict) or not item.get("url"):
            continue
        text = item.get("text") or ""
        results.append(
            {
                "title": (item.get("title") or "Untitled")[:300],
                "url": item.get("url"),
                "published_date": item.get("published_date") or "",
                "snippet": (text[:600]).strip() if isinstance(text, str) else "",
            }
        )
    return {"results": results}


def _build_exa_agent(agent_cls, model):
    """Optional Exa-grounded research sub-agent.

    Returns ``None`` (so the brief proceeds without it) unless the
    ``HEALTH_CASE_ENABLE_EXA`` flag is on. Mirrors the web_discourse_agent
    pattern: an isolated sub-agent with a single web-search tool and its own
    optional output_key, so disabled/unconfigured Exa degrades cleanly. The
    underlying ``services.exa`` client itself no-ops without an API key.
    """
    if not _exa_enabled():
        return None

    return agent_cls(
        model=model,
        name="exa_web_research_agent",
        description=(
            "Broadens discovery via Exa neural web search (guidelines, society "
            "statements, news, trial-site and patient-org pages)."
        ),
        instruction=(
            "Use exa_web_search to find authoritative web sources for the "
            "Health Case conditions that structured databases (PubMed/OpenAlex) "
            "miss: clinical guideline pages, society/position statements, "
            "regulatory pages, and reputable news on late-breaking results. "
            "Prefer recent, primary, and high-credibility sources; skip "
            "content farms and low-quality patient forums. For each item "
            "return a one-line summary, the URL, the date if present, and why "
            "it matters for this case. Return at most 6 items. If nothing "
            "trustworthy is found, return the literal string 'No additional "
            "web sources found.' rather than fabricating items."
        ),
        tools=[exa_web_search],
        output_key="exa_research",
    )


def _run_async(coro, *, timeout_seconds: float | None = None):
    if timeout_seconds is None:
        raise HealthCaseADKUnavailable("ADK timeout is required")

    async def _with_timeout():
        return await asyncio.wait_for(coro, timeout=timeout_seconds)

    try:
        asyncio.get_running_loop()
    except RuntimeError:
        try:
            return asyncio.run(_with_timeout())
        except asyncio.TimeoutError as exc:
            raise HealthCaseADKUnavailable("ADK run timed out") from exc

    # Flask routes are sync today, but keep this safe if a future worker runs
    # inside an event loop.
    result: list[Any] = []
    error: list[BaseException] = []

    def target() -> None:
        try:
            result.append(asyncio.run(_with_timeout()))
        except asyncio.TimeoutError:
            error.append(HealthCaseADKUnavailable("ADK run timed out"))
        except BaseException as exc:  # pragma: no cover - defensive
            error.append(exc)

    thread = threading.Thread(target=target, daemon=True)
    thread.start()
    thread.join(timeout=timeout_seconds)
    if thread.is_alive():
        raise HealthCaseADKUnavailable("ADK run timed out")
    if error:
        raise error[0]
    return result[0] if result else None


def _event_text(event) -> str:
    content = getattr(event, "content", None)
    if content and getattr(content, "parts", None):
        # Parts may be non-text (function calls, thoughts); guard the access so
        # a single non-text part can't raise and kill the whole stream.
        return getattr(content.parts[0], "text", None) or ""
    return ""


async def _run_agent_text(
    agent,
    prompt: str,
    *,
    user_id: str,
    session_id: str,
    on_event: Callable[[dict[str, Any]], None] | None = None,
    stream_content: bool = False,
    content_author: str | None = None,
    cancel_event: "threading.Event | None" = None,
) -> str:
    """Drive an ADK runner to completion and return the final response text.

    When ``on_event`` is provided we also surface live progress: a ``thinking``
    event as each named agent starts, and — when ``stream_content`` is set —
    incremental ``content`` deltas from ``content_author`` (the synthesis
    agent) as they are generated. Callers that omit ``on_event`` get the
    original collect-then-return behavior unchanged.
    """

    (
        _Agent,
        _ParallelAgent,
        _SequentialAgent,
        Runner,
        InMemorySessionService,
        types,
    ) = _import_adk_runtime()

    session_service = InMemorySessionService()
    await session_service.create_session(
        app_name=APP_NAME,
        user_id=user_id,
        session_id=session_id,
    )
    runner = Runner(
        agent=agent,
        app_name=APP_NAME,
        session_service=session_service,
    )
    content = types.Content(role="user", parts=[types.Part(text=prompt)])
    run_kwargs: dict[str, Any] = {
        "user_id": user_id,
        "session_id": session_id,
        "new_message": content,
    }
    run_config = _streaming_run_config() if stream_content else None
    if run_config is not None:
        run_kwargs["run_config"] = run_config

    final_text: str | None = None
    seen_authors: set[str] = set()
    streamed_chars = 0
    event_stream = runner.run_async(**run_kwargs)
    while True:
        # Cooperative cancellation: if the caller (e.g. a disconnected client)
        # signalled stop, break at the next event boundary instead of letting
        # the run burn its full timeout making model calls in an orphan thread.
        if cancel_event is not None and cancel_event.is_set():
            break
        try:
            event = await anext(event_stream)
        except StopAsyncIteration:
            break
        except Exception:
            if final_text is None:
                raise
            logger.warning(
                "[Health Cases ADK] Runner failed while draining after final response",
                exc_info=True,
            )
            sentry_sdk.add_breadcrumb(
                category="health_case.adk",
                message="ADK stream drain failed after final response",
                level="warning",
            )
            break

        author = getattr(event, "author", None)
        if on_event is not None and author and author not in seen_authors:
            seen_authors.add(author)
            message = _agent_progress_message(author)
            if message:
                on_event({"type": "thinking", "content": message})

        # Stream synthesis tokens as they arrive. We only forward deltas from
        # the synthesis agent so the user never sees raw intermediate
        # sub-agent notes, and we track how much we streamed so the caller can
        # avoid re-emitting the same text at the end.
        if (
            on_event is not None
            and stream_content
            and author == content_author
            and getattr(event, "partial", False)
        ):
            delta = _event_text(event)
            if delta:
                on_event({"type": "content", "content": delta})
                streamed_chars += len(delta)

        if event.is_final_response() and final_text is None:
            if event.content and event.content.parts:
                final_text = getattr(event.content.parts[0], "text", None) or ""
            elif getattr(event, "actions", None) and event.actions.escalate:
                final_text = event.error_message or ""
            # Signal to the caller that the final text was already streamed
            # token-by-token, so it should not chunk and re-send it.
            if (
                on_event is not None
                and stream_content
                and streamed_chars > 0
                and final_text
            ):
                on_event({"type": "content_streamed"})
    return final_text or ""


def _serialize_tool_result(tool: str, result: Any) -> dict[str, Any]:
    if isinstance(result, dict):
        return {
            "type": "tool_result",
            "tool": tool,
            "data": result.get("data"),
            "papers": result.get("papers_cited") or result.get("papers") or [],
            "error": result.get("error"),
        }

    return {
        "type": "tool_result",
        "tool": tool,
        "data": getattr(result, "data", None),
        "papers": getattr(result, "papers_cited", []) or [],
        "error": getattr(result, "error", None),
    }


def _record_tool_result(state: _ToolRunState, tool: str, result: Any) -> dict[str, Any]:
    event = _serialize_tool_result(tool, result)
    state.tool_events.append(event)
    for paper in event.get("papers") or []:
        if not isinstance(paper, dict):
            continue
        key = paper.get("id") or paper.get("url") or paper.get("title")
        if key and all(
            key != (existing.get("id") or existing.get("url") or existing.get("title"))
            for existing in state.papers_cited
        ):
            state.papers_cited.append(paper)
    _emit_tool_event(state, event)
    return event["data"] if event.get("error") is None else {"error": event["error"]}


def _emit_tool_event(state: _ToolRunState, event: dict[str, Any]) -> None:
    """Forward a recorded tool event to the live sink, if one is attached."""

    if state.sink is None:
        return
    try:
        state.sink(event)
    except Exception:  # pragma: no cover - a flaky sink must never break a tool
        logger.warning("Health Cases tool-event sink raised; dropping event")


def _research_tool(
    state: _ToolRunState,
    name: str,
    args: dict[str, Any],
) -> dict[str, Any]:
    from services.research_agent import TOOL_EXECUTORS

    executor = TOOL_EXECUTORS.get(name)
    if not executor:
        return {"error": f"Tool {name} is not registered"}
    try:
        result = executor(args)
    except Exception as exc:  # pragma: no cover - executor should capture
        sentry_sdk.capture_exception(exc)
        return {"error": f"{name} failed"}
    return _record_tool_result(state, name, result)


def _build_health_case_tools(
    state: _ToolRunState,
) -> list[Callable[..., dict[str, Any]]]:
    def paper_search(query: str, max_results: int = 5) -> dict[str, Any]:
        """Search Synapse's paper corpus for research relevant to the case."""

        return _research_tool(
            state,
            "paper_search",
            {"query": query, "max_results": max_results},
        )

    def evidence_lookup(
        drug: str = "",
        condition: str = "",
    ) -> dict[str, Any]:
        """Look up consensus and evidence graph signals for a condition."""

        return _research_tool(
            state,
            "evidence_lookup",
            {"drug": drug, "condition": condition},
        )

    def guideline_lookup(
        condition: str = "",
        intervention: str = "",
        society: str = "",
        max_results: int = 5,
    ) -> dict[str, Any]:
        """Find guideline recommendations relevant to the health case."""

        return _research_tool(
            state,
            "guideline_lookup",
            {
                "condition": condition,
                "intervention": intervention,
                "society": society,
                "max_results": max_results,
            },
        )

    def clinical_trials_lookup(
        condition: str = "",
        intervention: str = "",
        status: str = "",
        phase: str = "",
        max_results: int = 5,
    ) -> dict[str, Any]:
        """Find ClinicalTrials.gov records relevant to the case."""

        return _research_tool(
            state,
            "clinical_trials_lookup",
            {
                "condition": condition,
                "intervention": intervention,
                "status": status,
                "phase": phase,
                "max_results": max_results,
            },
        )

    def researcher_match(topic: str, max_results: int = 6) -> dict[str, Any]:
        """Find relevant Synapse researchers and centers for a topic."""

        try:
            from services.researcher_graph import build_researcher_graph

            graph = build_researcher_graph(
                mode="topic",
                topic=topic,
                max_nodes=max(10, min(max_results * 2, 30)),
            )
            nodes = graph.get("nodes") or []
            researchers = []
            for node in nodes[:max_results]:
                researchers.append(
                    {
                        "name": node.get("name"),
                        "institution": node.get("institution"),
                        "specialty": node.get("specialty"),
                        "areas_of_expertise": node.get("areas_of_expertise") or [],
                        "openalex_id": node.get("id"),
                        "synapse_id": node.get("synapse_id"),
                        "profile_url": (
                            f"/authors/{node.get('synapse_id')}"
                            if node.get("synapse_id")
                            else ""
                        ),
                        "rationale": f"Matched to {topic} via Synapse researcher graph.",
                    }
                )
            data = {
                "topic": topic,
                "researchers": researchers,
                "metadata": graph.get("metadata") or {},
            }
            event = {
                "type": "tool_result",
                "tool": "researcher_match",
                "data": data,
                "papers": [],
                "error": None,
            }
            state.tool_events.append(event)
            _emit_tool_event(state, event)
            return data
        except Exception as exc:
            sentry_sdk.capture_exception(exc)
            error = "researcher_match failed"
            event = {
                "type": "tool_result",
                "tool": "researcher_match",
                "data": None,
                "papers": [],
                "error": error,
            }
            state.tool_events.append(event)
            _emit_tool_event(state, event)
            return {"error": error}

    return [
        paper_search,
        evidence_lookup,
        guideline_lookup,
        clinical_trials_lookup,
        researcher_match,
    ]


def _chunk_text(text: str) -> Iterable[str]:
    paragraphs = text.split("\n\n")
    for index, paragraph in enumerate(paragraphs):
        if not paragraph:
            continue
        suffix = "\n\n" if index < len(paragraphs) - 1 else ""
        yield paragraph + suffix


def _feed_suggestions_from_prompt(prompt: str) -> list[dict[str, Any]]:
    marker = "Health Case profile JSON:\n"
    if marker not in prompt:
        return []
    try:
        payload = json.loads(prompt.split(marker, 1)[1])
    except Exception:
        return []

    terms = [
        str(term).strip()
        for term in (payload.get("condition_terms") or [])
        if str(term).strip()
    ]
    profile = payload.get("profile") if isinstance(payload.get("profile"), dict) else {}
    if not terms:
        terms = [
            str(term).strip()
            for term in (profile.get("conditions") or [])
            if str(term).strip()
        ][:6]
    if not terms:
        return []

    topic = ", ".join(terms[:2])
    return [
        {
            "topic": f"{topic} Research",
            "description": "Track new papers related to this Health Case.",
            "search_terms": terms[:8],
        }
    ]


def run_health_case_intake_adk(
    *,
    story: str,
    extracted_records: list[dict[str, Any]],
    system_prompt: str,
    model: str = DEFAULT_MODEL,
    max_context_chars: int = 120_000,
    timeout_seconds: float = DEFAULT_INTAKE_TIMEOUT_SECONDS,
) -> str:
    """Run Health Cases intake through a single ADK intake agent."""

    if not should_use_adk():
        raise HealthCaseADKUnavailable("HEALTH_CASE_AGENT_BACKEND is not adk")

    _ensure_google_api_key()
    Agent, *_ = _import_adk_runtime()

    record_context = []
    remaining = max_context_chars
    for record in extracted_records:
        text = record.get("text") or ""
        if not text or remaining <= 0:
            continue
        chunk = text[:remaining]
        remaining -= len(chunk)
        record_context.append(
            {
                "filename": record.get("filename"),
                "content_type": record.get("content_type"),
                "text": chunk,
            }
        )

    payload = {"user_story": story, "record_texts": record_context}
    prompt = (
        "Create the medical intake confirmation JSON from this case payload:\n"
        f"{json.dumps(payload, sort_keys=True)}"
    )
    agent = Agent(
        model=model,
        name="health_case_intake_agent",
        description="Structures Health Case intake into a user-confirmed profile.",
        instruction=(
            system_prompt
            + "\nReturn raw JSON only. Do not wrap the response in markdown fences."
        ),
    )
    return _run_async(
        _run_agent_text(
            agent,
            prompt,
            user_id="health_case_intake",
            session_id=f"intake_{secrets.token_hex(8)}",
        ),
        timeout_seconds=timeout_seconds,
    )


@dataclass
class HealthCaseBriefAgents:
    root_agent: Any
    web_discourse_agent: Any | None = None


def build_health_case_brief_prompt(
    intake_payload: dict[str, Any], *, extra_question: str = ""
) -> str:
    """Build the Expert Research brief prompt from a Health Case intake payload."""

    payload = {
        "primary_specialty": intake_payload.get("primary_specialty"),
        "condition_terms": intake_payload.get("condition_terms") or [],
        "profile": intake_payload.get("profile") or {},
        "extra_question": extra_question,
    }
    return (
        "Create a cardiology-first Expert Research brief for this user-reviewed "
        "Health Case profile. This is research education, not diagnosis or medical "
        "advice. Do not invent facts from the uploaded records.\n\n"
        "Use tools for guidelines, clinical trials, latest papers, evidence graph "
        "signals, knowledge graph context, editorials, expert commentary, and "
        "X/web discourse. Label clinicians as relevant researchers, trialists, "
        "or centers of expertise; do not claim they are the 'best doctors' by "
        "care-quality outcomes.\n\n"
        "Format the answer with EXACTLY these markdown section headings in this "
        "order:\n"
        "## 1. What Experts Are Saying\n"
        "- Summarize the strongest expert/evidence signals from guidelines, "
        "knowledge graph, evidence graph, editorials, conference discussion, "
        "and X/web commentary. Call out whether a claim is guideline-backed, "
        "trial-backed, editorial/commentary, or emerging.\n\n"
        "## 2. Relevant Research Papers\n"
        "- List the most relevant papers with title, first author when known, "
        "year, why it matters for this case, and citation/source details. "
        "End this section with a 'Create Feed' recommendation containing a "
        "feed topic and search terms.\n\n"
        "## 3. Relevant Researchers\n"
        "- List relevant researchers or centers with their rationale, institution "
        "when known, and what to ask them about. Include 'Request Contact' as "
        "the user action for each researcher. Use Synapse profile identifiers "
        "or links when available; otherwise state that the profile should be "
        "matched before outreach.\n\n"
        "## 4. Clinical Trials\n"
        "- List relevant trials with NCT IDs when available, status, phase, "
        "intervention, eligibility caveats, location notes if known, and why "
        "the trial may or may not fit this case.\n\n"
        "## 5. Topics to Discuss With Your Specialist\n"
        "- Open the section with a one-sentence disclaimer that these are "
        "research-grounded conversation topics, not medical advice. Then list "
        "3-6 bullets, each phrased as a topic or question to raise (never as "
        "an instruction), grounded in a specific paper title, NCT ID, or "
        "researcher mentioned elsewhere in this brief. Avoid dosages, "
        "specific drug doses, and 'you should' language; talk about classes "
        "or themes. End each bullet with the relevant specialist in "
        "parentheses, e.g. '(retina specialist)' or '(nephrology)'. If "
        "fewer than three citation-grounded topics can be supported, write "
        "only the disclaimer and explain that the brief did not surface "
        "enough cited material for safe discussion topics.\n\n"
        "## 6. Feedback\n"
        "- Ask the user what was helpful, what is missing, and what context "
        "would improve the next pass. Suggest 2-3 concrete follow-up questions "
        "the system should ask.\n\n"
        f"Health Case profile JSON:\n{json.dumps(payload, sort_keys=True)}"
    )


def build_health_case_brief_root_agent(
    *,
    model: str,
    tools: list[Any],
    fast_model: str | None = None,
) -> HealthCaseBriefAgents:
    """Construct the ADK multi-agent graph used for Health Case briefs.

    ``model`` (the pro tier) drives only the final synthesis pass. The parallel
    research sub-agents and the topics extractor run on ``fast_model`` (the
    flash tier) because that fan-out is the bulk of the wall-clock and is more
    latency- than reasoning-bound. ``fast_model`` defaults to
    ``DEFAULT_FAST_MODEL`` when not provided.
    """

    Agent, ParallelAgent, SequentialAgent, *_ = _import_adk_runtime()
    fast_model = fast_model or DEFAULT_FAST_MODEL

    evidence_agent = Agent(
        model=fast_model,
        name="evidence_research_agent",
        description="Finds papers, guidelines, consensus, and expert evidence.",
        instruction=(
            "Use Synapse tools to identify evidence, guidelines, papers, and "
            "expert commentary relevant to the Health Case. Return concise "
            "notes with citations, paper titles, and confidence qualifiers."
        ),
        tools=tools,
        output_key="evidence_research",
    )
    trial_tools = list(tools)
    mcp_toolset = _build_mcp_toolset() if _mcp_enabled() else None
    if mcp_toolset is not None:
        # The MCP server exposes the same function name. Passing both providers
        # makes Gemini reject the request with a duplicate declaration error.
        trial_tools = [
            tool
            for tool in trial_tools
            if getattr(tool, "__name__", "") != "clinical_trials_lookup"
        ]
        trial_tools.append(mcp_toolset)
    trial_agent = Agent(
        model=fast_model,
        name="clinical_trial_agent",
        description="Finds relevant ClinicalTrials.gov studies and caveats.",
        instruction=(
            "Use clinical_trials_lookup to find relevant trials. When the MCP "
            "tool is available, prefer it for trial retrieval. Include NCT "
            "IDs, phase/status, intervention, eligibility caveats, location "
            "notes when known, and why each trial may or may not fit."
        ),
        tools=trial_tools,
        output_key="clinical_trial_research",
    )
    researcher_agent = Agent(
        model=fast_model,
        name="researcher_match_agent",
        description="Finds relevant researchers, trialists, and centers.",
        instruction=(
            "Use researcher_match and paper_search to identify researchers or "
            "centers of expertise. Do not call them the best doctors. Explain "
            "what the user should ask each person about and include Request "
            "Contact language."
        ),
        tools=tools,
        output_key="researcher_research",
    )

    parallel_subagents = [evidence_agent, trial_agent, researcher_agent]
    google_search_tool = _import_google_search_tool()
    web_discourse_agent = None
    if google_search_tool is not None:
        web_discourse_agent = Agent(
            model=fast_model,
            name="web_discourse_agent",
            description=(
                "Grounds the Health Case in real-time public discourse via "
                "Google Search (news, FDA/EMA, conference debriefs, X/web)."
            ),
            instruction=(
                "Use Google Search to find recent (prefer last 12 months) "
                "real-time signals relevant to the Health Case conditions: "
                "regulatory announcements (FDA/EMA approvals, label changes, "
                "safety alerts), late-breaking conference results (ACC, AHA, "
                "ESC, ASN, ARVO, AAO, ASCO), guideline updates not yet in "
                "PubMed, expert commentary, and public X/web discussion. "
                "Skip generic patient-advocacy or low-quality sources. For "
                "each item return: a one-line summary, the source URL, the "
                "date if visible, and a short note on why it matters for "
                "this case. Return at most 6 items. If Google Search returns "
                "nothing trustworthy, return the literal string 'No reliable "
                "real-time signals found.' rather than fabricating items."
            ),
            tools=[google_search_tool],
            output_key="web_discourse_research",
        )
        parallel_subagents.append(web_discourse_agent)
    exa_agent = _build_exa_agent(Agent, fast_model)
    if exa_agent is not None:
        parallel_subagents.append(exa_agent)
    parallel_research = ParallelAgent(
        name="health_case_parallel_research",
        sub_agents=parallel_subagents,
        description=(
            "Runs evidence, trial, researcher, and (when available) "
            "Google-Search-grounded web discourse and Exa neural-web research "
            "in parallel."
        ),
    )
    intervention_topics_agent = Agent(
        model=fast_model,
        name="intervention_topics_agent",
        description=(
            "Extracts citation-grounded conversation topics a patient can "
            "raise with their specialist from the parallel research findings."
        ),
        instruction=(
            "You produce 'Topics to Discuss With Your Specialist' for a "
            "patient-facing research brief. You are NOT a clinician and NOT a "
            "treatment recommender.\n\n"
            "Inputs (already produced by upstream agents in this run):\n"
            "Evidence findings:\n{evidence_research}\n\n"
            "Clinical trial findings:\n{clinical_trial_research}\n\n"
            "Researcher findings:\n{researcher_research}\n\n"
            "Web-discourse findings (Google Search grounded; may be empty):\n"
            "{web_discourse_research?}\n\n"
            "OUTPUT FORMAT: A short disclaimer sentence followed by 3-6 "
            "markdown bullets. Every bullet MUST:\n"
            "  * be phrased as a TOPIC or QUESTION TO RAISE, never as an "
            "    instruction (good: 'Ask your retina specialist about anti-VEGF "
            "    evidence for MacTel...'; bad: 'Take anti-VEGF therapy.').\n"
            "  * cite a specific paper title, NCT ID, or named researcher "
            "    that already appears in the inputs above. If you cannot "
            "    cite, drop the bullet.\n"
            "  * avoid dosages, brand-name + dose combinations, and 'you "
            "    should' language. Talk about classes, themes, or evidence "
            "    questions.\n"
            "  * end with the relevant specialist in parentheses, e.g. "
            "    '(retina specialist)' or '(nephrology)'.\n\n"
            "Always begin with this exact disclaimer paragraph (no heading, "
            "no markdown emphasis), then a blank line, then the bullets:\n"
            "These are research-grounded conversation topics to raise with "
            "your clinical team, not medical advice. Each item links to a "
            "paper, trial, or researcher already surfaced in this brief.\n\n"
            "If you cannot find at least three citation-grounded topics, "
            "output only the disclaimer followed by one bullet that says: "
            "'- The brief did not surface enough cited material to suggest "
            "specific discussion topics safely.'"
        ),
        output_key="intervention_topics",
    )
    synthesis_agent = Agent(
        model=model,
        name="health_case_brief_synthesis_agent",
        description="Synthesizes the final Health Case Expert Research brief.",
        instruction=(
            "Create the final user-facing Expert Research brief using the "
            "original Health Case prompt plus the agent findings.\n\n"
            "Evidence findings:\n{evidence_research}\n\n"
            "Clinical trial findings:\n{clinical_trial_research}\n\n"
            "Researcher findings:\n{researcher_research}\n\n"
            "Web-discourse findings (Google Search grounded; may be empty):\n"
            "{web_discourse_research?}\n\n"
            "Additional web sources (Exa neural search; may be empty):\n"
            "{exa_research?}\n\n"
            "Topics to Discuss With Your Specialist (pre-synthesized "
            "verbatim block, drop directly under the matching section "
            "heading -- do NOT rewrite, re-cite, or expand it):\n"
            "{intervention_topics}\n\n"
            "Section 1 ('What Experts Are Saying') should weave in any "
            "real-time signals from the web-discourse and Exa web findings "
            "(regulatory announcements, late-breaking conference results, "
            "guideline pages, news) with a URL and a clear 'real-time / news' "
            "qualifier, alongside the guideline-backed and trial-backed "
            "claims. Do not invent a real-time signal that is not in those "
            "findings.\n\n"
            "Follow the requested section headings exactly, including "
            "section 5 'Topics to Discuss With Your Specialist'. This is "
            "education and research support only, not diagnosis or medical "
            "advice."
        ),
    )
    root_agent = SequentialAgent(
        name="health_case_navigator",
        sub_agents=[parallel_research, intervention_topics_agent, synthesis_agent],
        description=(
            "ADK Health Case Navigator: research in parallel, then synthesize "
            "citation-grounded discussion topics, then assemble the brief."
        ),
    )
    return HealthCaseBriefAgents(
        root_agent=root_agent,
        web_discourse_agent=web_discourse_agent,
    )


def health_case_brief_agent_names(web_discourse_agent: Any | None) -> list[str]:
    return [
        name
        for name in [
            "health_case_navigator",
            "health_case_parallel_research",
            "evidence_research_agent",
            "clinical_trial_agent",
            "researcher_match_agent",
            "web_discourse_agent" if web_discourse_agent is not None else None,
            "intervention_topics_agent",
            "health_case_brief_synthesis_agent",
        ]
        if name
    ]


def stream_health_case_brief_adk(
    *,
    prompt: str,
    user_id: str,
    model: str = DEFAULT_MODEL,
    fast_model: str | None = None,
    timeout_seconds: float = DEFAULT_BRIEF_TIMEOUT_SECONDS,
) -> Iterable[dict[str, Any]]:
    """Run the Health Case Expert Research brief through an ADK team.

    Streams events incrementally: agent-progress ``thinking`` events, live
    ``tool_result`` events as each tool completes, and synthesis ``content``
    deltas as they are generated. The multi-agent run executes on a daemon
    thread (Flask routes are sync) while this generator drains a queue, so the
    client sees movement throughout the run instead of a frozen connection
    until the very end. A run that fails or times out after streaming partial
    progress lets the caller persist what was produced.
    """

    if not should_use_adk():
        raise HealthCaseADKUnavailable("HEALTH_CASE_AGENT_BACKEND is not adk")

    _ensure_google_api_key()

    import queue as _queue

    state = _ToolRunState()
    event_queue: _queue.Queue[tuple[str, Any]] = _queue.Queue()
    state.sink = lambda event: event_queue.put(("event", event))

    tools = _build_health_case_tools(state)
    brief_agents = build_health_case_brief_root_agent(
        model=model, fast_model=fast_model, tools=tools
    )
    agent_names = health_case_brief_agent_names(brief_agents.web_discourse_agent)
    result_holder: dict[str, Any] = {}
    # Signals the worker to stop at the next event boundary when the consumer
    # goes away (client disconnect / stall), so we don't leak an orphan thread
    # making model calls for the rest of the ADK budget.
    cancel_event = threading.Event()

    async def _drive() -> None:
        text = await _run_agent_text(
            brief_agents.root_agent,
            prompt,
            user_id=user_id,
            session_id=f"brief_{secrets.token_hex(8)}",
            on_event=lambda event: event_queue.put(("event", event)),
            stream_content=True,
            content_author=SYNTHESIS_AGENT_NAME,
            cancel_event=cancel_event,
        )
        result_holder["text"] = text

    def _worker() -> None:
        try:
            asyncio.run(asyncio.wait_for(_drive(), timeout=timeout_seconds))
        except asyncio.TimeoutError:
            event_queue.put(("error", HealthCaseADKUnavailable("ADK run timed out")))
        except BaseException as exc:  # noqa: BLE001 - surfaced to the caller
            event_queue.put(("error", exc))
        finally:
            event_queue.put(("done", None))

    worker = threading.Thread(target=_worker, name="health-case-adk", daemon=True)
    worker.start()

    # Accumulate streamed content so the citation guard always has text to scan
    # even when the final aggregated event is empty — a health brief must never
    # reach a user with citation verification silently skipped.
    streamed_parts: list[str] = []
    content_streamed = False
    run_error: BaseException | None = None
    try:
        yield {
            "type": "thinking",
            "content": "Running Google ADK Health Case Navigator agents...",
        }
        # Feed suggestions derive only from the prompt (not the run), so emit
        # them up front — before any content — preserving the legacy ordering
        # clients may rely on to pre-render the "track this case" affordance. A
        # fallback `reset` (see the route) clears them if the ADK attempt
        # aborts.
        for event in _feed_suggestions_from_prompt(prompt):
            yield {"type": "feed_suggestion", **event}

        # If the worker hangs in a non-cancellable call its `finally` never
        # enqueues ("done"), so cap each wait at the ADK budget plus a small
        # grace. This detects a stall ~30s after the internal cap instead of
        # burning the full SSE wall-clock ceiling on the route.
        stall_timeout = timeout_seconds + 30.0

        while True:
            try:
                kind, payload = event_queue.get(timeout=stall_timeout)
            except _queue.Empty:
                sentry_sdk.capture_message(
                    "Health Case ADK run stalled past timeout budget",
                    level="error",
                )
                run_error = HealthCaseADKUnavailable("ADK run stalled")
                break
            if kind == "event":
                event_type = payload.get("type")
                if event_type == "content_streamed":
                    # Internal signal: synthesis text already streamed token-by-
                    # token, so don't re-chunk it below. Not forwarded.
                    content_streamed = True
                    continue
                if event_type == "content":
                    content_streamed = True
                    streamed_parts.append(payload.get("content", ""))
                yield payload
            elif kind == "error":
                run_error = payload
                break
            elif kind == "done":
                break
    finally:
        # Whether we finish, raise, or the client disconnects (GeneratorExit),
        # signal the worker to stop and give it a brief chance to unwind.
        cancel_event.set()
        worker.join(timeout=2.0)

    if run_error is not None:
        # Re-raise so the route can decide: if nothing streamed yet it falls
        # back to the legacy agent; if partial progress already streamed it
        # persists that and surfaces a retry. Normalize to the sentinel type so
        # the route's existing `except HealthCaseADKUnavailable` handles it.
        if isinstance(run_error, HealthCaseADKUnavailable):
            raise run_error
        sentry_sdk.capture_exception(run_error)
        raise HealthCaseADKUnavailable(
            f"ADK run failed: {type(run_error).__name__}"
        ) from run_error

    # Prefer the aggregated final text; fall back to the streamed buffer so the
    # guard (and a chunked re-emit, if needed) always have the brief body.
    text = result_holder.get("text") or "".join(streamed_parts)
    if not text and not content_streamed:
        raise HealthCaseADKUnavailable("ADK returned no final response")

    if not content_streamed:
        # Token streaming was unavailable (older ADK) — emit the final text in
        # chunks so the client still renders the brief.
        for chunk in _chunk_text(text):
            yield {"type": "content", "content": chunk}

    # Phase-1 hallucination guard, mirrored from the legacy research-agent
    # path so the production ADK backend also surfaces unverified NCT IDs and
    # trial acronyms. We don't mutate the streamed text — clients render a
    # "couldn't verify these references" warning from this metadata.
    citation_grounding = None
    try:
        from services.research_agent_extensions import (
            grounding_enabled,
            verify_citations,
        )

        if grounding_enabled():
            if text:
                citation_grounding = verify_citations(text, state.papers_cited)
            else:
                # No text at all to scan (no aggregated final, nothing
                # streamed). Flag it so clients can distinguish "checked" from
                # "missed" rather than silently trusting an unverified brief.
                sentry_sdk.add_breadcrumb(
                    category="health_case.adk",
                    message="citation guard skipped: no brief text to scan",
                    level="warning",
                )
    except Exception as guard_err:  # pragma: no cover - defensive
        logger.warning("ADK citation grounding skipped: %s", guard_err)

    yield {
        "type": "done",
        "metadata": {
            "papers_cited": state.papers_cited,
            "agent_backend": "google_adk",
            "adk_agents": agent_names,
            # Intentionally None when the guard is disabled or the agent
            # produced no text, so clients distinguish "checked, found
            # nothing" from "didn't check this run".
            "citation_grounding": citation_grounding,
        },
    }
