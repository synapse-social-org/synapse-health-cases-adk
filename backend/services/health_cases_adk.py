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
DEFAULT_MODEL = os.environ.get("HEALTH_CASE_ADK_MODEL", "gemini-3.1-pro-preview")
DEFAULT_INTAKE_TIMEOUT_SECONDS = float(
    os.environ.get("HEALTH_CASE_ADK_INTAKE_TIMEOUT_SECONDS", 120)
)
DEFAULT_BRIEF_TIMEOUT_SECONDS = float(
    os.environ.get("HEALTH_CASE_ADK_BRIEF_TIMEOUT_SECONDS", 450)
)

_GOOGLE_API_KEY_LOCK = threading.Lock()
_GOOGLE_API_KEY_CONFIGURED = False


class HealthCaseADKUnavailable(RuntimeError):
    """Raised when ADK cannot run and the caller should use the legacy path."""


@dataclass
class HealthCaseADKRunResult:
    text: str
    tool_events: list[dict[str, Any]] = field(default_factory=list)
    feed_suggestion_events: list[dict[str, Any]] = field(default_factory=list)
    papers_cited: list[dict[str, Any]] = field(default_factory=list)
    agent_names: list[str] = field(default_factory=list)


@dataclass
class _ToolRunState:
    tool_events: list[dict[str, Any]] = field(default_factory=list)
    papers_cited: list[dict[str, Any]] = field(default_factory=list)


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
    """Spawn the Health Cases MCP server and return an ADK McpToolset."""

    try:
        from google.adk.tools.mcp_tool.mcp_toolset import McpToolset, StdioConnectionParams
        from mcp import StdioServerParameters
    except Exception as exc:  # pragma: no cover
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
    except Exception as exc:  # pragma: no cover
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


async def _run_agent_text(agent, prompt: str, *, user_id: str, session_id: str) -> str:
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
    final_text: str | None = None
    event_stream = runner.run_async(
        user_id=user_id,
        session_id=session_id,
        new_message=content,
    )
    while True:
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

        if event.is_final_response() and final_text is None:
            if event.content and event.content.parts:
                final_text = event.content.parts[0].text or ""
            elif getattr(event, "actions", None) and event.actions.escalate:
                final_text = event.error_message or ""
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
    return event["data"] if event.get("error") is None else {"error": event["error"]}


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
            state.tool_events.append(
                {
                    "type": "tool_result",
                    "tool": "researcher_match",
                    "data": data,
                    "papers": [],
                    "error": None,
                }
            )
            return data
        except Exception as exc:
            sentry_sdk.capture_exception(exc)
            error = "researcher_match failed"
            state.tool_events.append(
                {
                    "type": "tool_result",
                    "tool": "researcher_match",
                    "data": None,
                    "papers": [],
                    "error": error,
                }
            )
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
) -> HealthCaseBriefAgents:
    """Construct the ADK multi-agent graph used for Health Case briefs."""

    Agent, ParallelAgent, SequentialAgent, *_ = _import_adk_runtime()

    evidence_agent = Agent(
        model=model,
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
        trial_tools.append(mcp_toolset)
    trial_agent = Agent(
        model=model,
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
        model=model,
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
            model=model,
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
    parallel_research = ParallelAgent(
        name="health_case_parallel_research",
        sub_agents=parallel_subagents,
        description=(
            "Runs evidence, trial, researcher, and (when available) "
            "Google-Search-grounded web discourse research in parallel."
        ),
    )
    intervention_topics_agent = Agent(
        model=model,
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
            "Topics to Discuss With Your Specialist (pre-synthesized "
            "verbatim block, drop directly under the matching section "
            "heading -- do NOT rewrite, re-cite, or expand it):\n"
            "{intervention_topics}\n\n"
            "Section 1 ('What Experts Are Saying') should weave in any "
            "real-time signals from the web-discourse findings (regulatory "
            "announcements, late-breaking conference results, news) with a "
            "URL and a clear 'real-time / news' qualifier, alongside the "
            "guideline-backed and trial-backed claims. Do not invent a "
            "real-time signal that is not in the web-discourse findings.\n\n"
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
    timeout_seconds: float = DEFAULT_BRIEF_TIMEOUT_SECONDS,
) -> Iterable[dict[str, Any]]:
    """Run the Health Case Expert Research brief through an ADK team."""

    if not should_use_adk():
        raise HealthCaseADKUnavailable("HEALTH_CASE_AGENT_BACKEND is not adk")

    _ensure_google_api_key()

    state = _ToolRunState()
    tools = _build_health_case_tools(state)
    brief_agents = build_health_case_brief_root_agent(model=model, tools=tools)

    text = _run_async(
        _run_agent_text(
            brief_agents.root_agent,
            prompt,
            user_id=user_id,
            session_id=f"brief_{secrets.token_hex(8)}",
        ),
        timeout_seconds=timeout_seconds,
    )
    if not text:
        raise HealthCaseADKUnavailable("ADK returned no final response")

    result = HealthCaseADKRunResult(
        text=text,
        tool_events=state.tool_events,
        feed_suggestion_events=_feed_suggestions_from_prompt(prompt),
        papers_cited=state.papers_cited,
        agent_names=health_case_brief_agent_names(brief_agents.web_discourse_agent),
    )

    yield {
        "type": "thinking",
        "content": "Running Google ADK Health Case Navigator agents...",
    }
    for event in result.tool_events:
        yield event
    for event in result.feed_suggestion_events:
        yield {"type": "feed_suggestion", **event}
    for chunk in _chunk_text(result.text):
        yield {"type": "content", "content": chunk}
    yield {
        "type": "done",
        "metadata": {
            "papers_cited": result.papers_cited,
            "agent_backend": "google_adk",
            "adk_agents": result.agent_names,
        },
    }
