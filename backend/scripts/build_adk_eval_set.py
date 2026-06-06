"""Convert Health Cases golden brief fixtures to an ADK EvalSet JSON file."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

import yaml
from google.adk.evaluation.eval_case import Invocation, SessionInput
from google.adk.evaluation.eval_set import EvalCase, EvalSet
from google.genai import types

from services.health_cases_adk import APP_NAME, build_health_case_brief_prompt


def load_fixtures(path: Path) -> list[dict]:
    payload = yaml.safe_load(path.read_text(encoding="utf-8"))
    cases = payload.get("cases") if isinstance(payload, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ValueError(f"No cases found in {path}")
    return cases


def build_eval_set(fixtures: list[dict]) -> EvalSet:
    eval_cases: list[EvalCase] = []
    for fixture in fixtures:
        case_id = str(fixture["id"])
        prompt = build_health_case_brief_prompt(fixture["intake_payload"])
        eval_cases.append(
            EvalCase(
                eval_id=case_id,
                conversation=[
                    Invocation(
                        invocation_id=f"{case_id}_brief",
                        user_content=types.Content(
                            role="user",
                            parts=[types.Part(text=prompt)],
                        ),
                    )
                ],
                session_input=SessionInput(
                    app_name=APP_NAME,
                    user_id=f"eval_{case_id}",
                ),
            )
        )
    return EvalSet(
        eval_set_id="synapse_health_cases_golden",
        name="Synapse Health Cases Golden Briefs",
        description=(
            "Curated Health Case intake fixtures for ADK AgentEvaluator and "
            "Synapse brief-quality scorecards."
        ),
        eval_cases=eval_cases,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Build ADK eval set JSON.")
    parser.add_argument(
        "--fixtures",
        default="tests/health_cases/golden_briefs.yaml",
        help="Path to golden brief fixtures YAML (relative to backend/).",
    )
    parser.add_argument(
        "--output",
        default="tests/health_cases/golden_briefs.evalset.json",
        help="Output EvalSet JSON path (relative to backend/).",
    )
    args = parser.parse_args()

    backend_dir = Path(__file__).resolve().parent.parent
    fixtures_path = backend_dir / args.fixtures
    output_path = backend_dir / args.output

    eval_set = build_eval_set(load_fixtures(fixtures_path))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(
        json.dumps(eval_set.model_dump(mode="json"), indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {output_path} ({len(eval_set.eval_cases)} cases)")


if __name__ == "__main__":
    main()
