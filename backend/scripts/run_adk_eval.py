"""Run Health Cases ADK eval fixtures and emit a scorecard."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from datetime import date
from pathlib import Path
from typing import Any

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

import yaml

from scripts.build_adk_eval_set import build_eval_set, load_fixtures
from services.health_cases_adk import (
    DEFAULT_BRIEF_TIMEOUT_SECONDS,
    build_health_case_brief_prompt,
    stream_health_case_brief_adk,
)

_NCT_RE = re.compile(r"\bNCT\d{8}\b", re.IGNORECASE)
_TOPICS_HEADING = "## 5. Topics to Discuss With Your Specialist"


def _count_topics(brief_text: str) -> int:
    start = brief_text.find(_TOPICS_HEADING)
    if start == -1:
        return 0
    section = brief_text[start:]
    next_heading = re.search(r"\n## [0-9]+\.", section[len(_TOPICS_HEADING) :])
    if next_heading:
        section = section[: len(_TOPICS_HEADING) + next_heading.start()]
    return len(re.findall(r"(?m)^\s*-\s+", section))


def _score_fixture(
    fixture: dict[str, Any],
    *,
    brief_text: str,
    papers_cited: list[Any],
    latency_seconds: float,
) -> dict[str, Any]:
    lowered = brief_text.lower()
    must_mention = fixture.get("must_mention") or []
    should_not_mention = fixture.get("should_not_mention") or []
    failures: list[str] = []

    missing = [term for term in must_mention if term.lower() not in lowered]
    if missing:
        failures.append(f"missing must_mention: {missing}")

    forbidden = [term for term in should_not_mention if term.lower() in lowered]
    if forbidden:
        failures.append(f"matched should_not_mention: {forbidden}")

    min_papers = int(fixture.get("min_papers_cited") or 0)
    if len(papers_cited) < min_papers:
        failures.append(
            f"papers_cited {len(papers_cited)} < min_papers_cited {min_papers}"
        )

    nct_count = len(_NCT_RE.findall(brief_text))
    min_trials = int(fixture.get("min_trials_cited") or 0)
    if nct_count < min_trials:
        failures.append(f"trials_cited {nct_count} < min_trials_cited {min_trials}")

    topics_count = _count_topics(brief_text)
    min_topics = int(fixture.get("min_topics_cited") or 0)
    if topics_count < min_topics:
        failures.append(f"topics_cited {topics_count} < min_topics_cited {min_topics}")

    max_latency = float(
        fixture.get("max_latency_seconds") or DEFAULT_BRIEF_TIMEOUT_SECONDS
    )
    if latency_seconds > max_latency:
        failures.append(
            f"latency {latency_seconds:.1f}s > max_latency_seconds {max_latency:.1f}s"
        )

    return {
        "id": fixture["id"],
        "description": fixture.get("description", ""),
        "passed": not failures,
        "failures": failures,
        "metrics": {
            "papers_cited": len(papers_cited),
            "trials_cited": nct_count,
            "topics_cited": topics_count,
            "latency_seconds": round(latency_seconds, 1),
        },
    }


def _run_live_fixture(fixture: dict[str, Any]) -> dict[str, Any]:
    prompt = build_health_case_brief_prompt(fixture["intake_payload"])
    started = time.monotonic()
    brief_parts: list[str] = []
    papers_cited: list[Any] = []

    for event in stream_health_case_brief_adk(
        prompt=prompt,
        user_id=f"eval_{fixture['id']}",
        timeout_seconds=float(
            fixture.get("max_latency_seconds") or DEFAULT_BRIEF_TIMEOUT_SECONDS
        ),
    ):
        if event.get("type") == "content":
            brief_parts.append(str(event.get("content") or ""))
        if event.get("type") == "done":
            metadata = event.get("metadata") or {}
            papers_cited = metadata.get("papers_cited") or []

    brief_text = "".join(brief_parts)
    latency_seconds = time.monotonic() - started
    return _score_fixture(
        fixture,
        brief_text=brief_text,
        papers_cited=papers_cited,
        latency_seconds=latency_seconds,
    )


async def _run_native_adk_eval(eval_set_path: Path) -> None:
    from google.adk.evaluation.agent_evaluator import AgentEvaluator
    from google.adk.evaluation.eval_config import EvalConfig
    from google.adk.evaluation.eval_metrics import BaseCriterion
    from google.adk.evaluation.eval_set import EvalSet

    eval_set = EvalSet.model_validate_json(eval_set_path.read_text(encoding="utf-8"))
    eval_config = EvalConfig(
        criteria={
            "tool_trajectory_avg_score": BaseCriterion(threshold=0.0),
        }
    )
    await AgentEvaluator.evaluate_eval_set(
        agent_module="services.health_cases_eval_agent",
        eval_set=eval_set,
        eval_config=eval_config,
        num_runs=1,
        print_detailed_results=True,
    )


def _write_scorecard(
    *,
    output_dir: Path,
    results: list[dict[str, Any]],
    eval_set_path: Path,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    passed = sum(1 for result in results if result["passed"])
    total = len(results)
    payload = {
        "date": date.today().isoformat(),
        "eval_set_path": str(eval_set_path),
        "passed": passed,
        "total": total,
        "pass_rate": round(passed / total, 3) if total else 0.0,
        "results": results,
    }
    json_path = output_dir / "scorecard.json"
    md_path = output_dir / "scorecard.md"
    json_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Health Cases ADK Eval Scorecard",
        "",
        f"- Date: {payload['date']}",
        f"- Pass rate: **{passed}/{total}** ({payload['pass_rate']:.0%})",
        f"- Eval set: `{eval_set_path}`",
        "",
        "| Case | Passed | Papers | Trials | Topics | Latency (s) | Notes |",
        "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ]
    for result in results:
        metrics = result["metrics"]
        notes = "; ".join(result["failures"]) if result["failures"] else "ok"
        lines.append(
            "| {id} | {passed} | {papers} | {trials} | {topics} | {latency} | {notes} |".format(
                id=result["id"],
                passed="yes" if result["passed"] else "no",
                papers=metrics["papers_cited"],
                trials=metrics["trials_cited"],
                topics=metrics["topics_cited"],
                latency=metrics["latency_seconds"],
                notes=notes.replace("|", "/"),
            )
        )
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"Wrote {json_path}")
    print(f"Wrote {md_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Run Health Cases ADK evals.")
    parser.add_argument(
        "--fixtures",
        default="tests/health_cases/golden_briefs.yaml",
        help="Golden fixtures YAML (relative to backend/).",
    )
    parser.add_argument(
        "--eval-set",
        default="tests/health_cases/golden_briefs.evalset.json",
        help="EvalSet JSON output/input path (relative to backend/).",
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Scorecard output directory (defaults to tasks/audit-artifacts/adk-eval-YYYY-MM-DD).",
    )
    parser.add_argument(
        "--validate-only",
        action="store_true",
        help="Build/validate the eval set JSON without running live briefs.",
    )
    parser.add_argument(
        "--native-adk-eval",
        action="store_true",
        help="Also invoke ADK AgentEvaluator against the generated eval set.",
    )
    parser.add_argument(
        "--case-id",
        default=None,
        help="Run only a single fixture id.",
    )
    args = parser.parse_args()

    backend_dir = Path(__file__).resolve().parent.parent
    repo_root = backend_dir.parent
    fixtures_path = backend_dir / args.fixtures
    eval_set_path = backend_dir / args.eval_set
    output_dir = (
        Path(args.output_dir)
        if args.output_dir
        else repo_root
        / "tasks"
        / "audit-artifacts"
        / f"adk-eval-{date.today().isoformat()}"
    )

    fixtures = load_fixtures(fixtures_path)
    if args.case_id:
        fixtures = [fixture for fixture in fixtures if fixture["id"] == args.case_id]
        if not fixtures:
            raise SystemExit(f"No fixture found with id={args.case_id!r}")

    eval_set = build_eval_set(fixtures)
    eval_set_path.parent.mkdir(parents=True, exist_ok=True)
    eval_set_path.write_text(
        json.dumps(eval_set.model_dump(mode="json"), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {eval_set_path}")

    if args.validate_only:
        return

    if not os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
        raise SystemExit(
            "GEMINI_API_KEY or GOOGLE_API_KEY is required for live ADK eval runs."
        )

    results = [_run_live_fixture(fixture) for fixture in fixtures]
    _write_scorecard(
        output_dir=output_dir,
        results=results,
        eval_set_path=eval_set_path,
    )

    if args.native_adk_eval:
        asyncio.run(_run_native_adk_eval(eval_set_path))


if __name__ == "__main__":
    main()
