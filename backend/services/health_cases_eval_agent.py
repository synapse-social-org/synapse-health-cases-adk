"""ADK AgentEvaluator entrypoint for Health Cases brief generation."""

from __future__ import annotations

from services.health_cases_adk import (
    APP_NAME,
    DEFAULT_MODEL,
    _ToolRunState,
    _build_health_case_tools,
    build_health_case_brief_root_agent,
)

_state = _ToolRunState()
_tools = _build_health_case_tools(_state)
_brief_agents = build_health_case_brief_root_agent(model=DEFAULT_MODEL, tools=_tools)

root_agent = _brief_agents.root_agent
app_name = APP_NAME
