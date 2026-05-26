"""Minimal stdio MCP server exposing Synapse clinical-trials lookup for ADK.

Health Cases' ``clinical_trial_agent`` consumes this server through ADK's
``McpToolset`` so trial retrieval crosses the Model Context Protocol boundary
while reusing the same Synapse implementation as the inline function tool.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def _import_mcp_sdk():
    try:
        from mcp.server.fastmcp import FastMCP
    except ImportError as exc:  # pragma: no cover - exercised without SDK
        raise RuntimeError(
            "The `mcp` Python package is required to run the Health Cases MCP server."
        ) from exc
    return FastMCP


def create_server():
    FastMCP = _import_mcp_sdk()
    mcp = FastMCP(
        "Synapse Health Cases MCP",
        instructions=(
            "Read-only clinical-trials lookup for Health Cases ADK agents. "
            "Do not send identifiable patient data."
        ),
        json_response=True,
    )

    @mcp.tool()
    def clinical_trials_lookup(
        condition: str = "",
        intervention: str = "",
        status: str = "",
        phase: str = "",
        max_results: int = 10,
    ) -> dict[str, Any]:
        """Find ClinicalTrials.gov records relevant to a health case."""

        from services.research_agent_extensions import _execute_clinical_trials_lookup

        result = _execute_clinical_trials_lookup(
            {
                "condition": condition,
                "intervention": intervention,
                "status": status,
                "phase": phase,
                "max_results": max_results,
            }
        )
        data = getattr(result, "data", None)
        if isinstance(data, dict):
            return data
        return {"trials": [], "metadata": {}}

    return mcp


def main() -> None:
    logging.basicConfig(level=logging.getLogger().level or logging.INFO)
    server = create_server()
    server.run(transport="stdio")


if __name__ == "__main__":
    main()
