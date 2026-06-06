"""Health case brief helper for Evidence MCP."""

from __future__ import annotations

from typing import Any


def build_health_case_brief(
    *,
    patient_context: str,
    question: str,
) -> dict[str, Any]:
    """Generate a structured health-case brief using the ADK brief workflow."""
    from services.health_cases_adk import (
        DEFAULT_MODEL,
        HealthCaseADKUnavailable,
        stream_health_case_brief_adk,
        should_use_adk,
    )

    if not should_use_adk():
        raise HealthCaseADKUnavailable("HEALTH_CASE_AGENT_BACKEND is not adk")

    prompt = (
        "Create a structured patient-facing research brief with sections for "
        "Presentation, Differential, Evidence Summary, and Citations.\n\n"
        f"Patient context:\n{patient_context.strip()}\n\n"
        f"Question:\n{question.strip()}"
    )

    sections: dict[str, str] = {
        "presentation": "",
        "differential": "",
        "evidence_summary": "",
        "citations": "",
    }
    buffer: list[str] = []
    for event in stream_health_case_brief_adk(
        prompt=prompt,
        user_id="mcp_health_case_brief",
        model=DEFAULT_MODEL,
        timeout_seconds=90.0,
    ):
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        if event_type == "content":
            buffer.append(str(event.get("content") or ""))
        elif event_type == "done":
            break

    full_text = "".join(buffer).strip()
    if full_text:
        sections["evidence_summary"] = full_text

    return {
        "question": question,
        "sections": sections,
        "raw_brief": full_text,
    }
