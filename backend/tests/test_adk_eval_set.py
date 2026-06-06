from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

pytest.importorskip("google.adk")

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))

from scripts.build_adk_eval_set import build_eval_set, load_fixtures


def test_golden_brief_fixtures_parse():
    backend_dir = Path(__file__).resolve().parent.parent
    fixtures_path = backend_dir / "tests" / "health_cases" / "golden_briefs.yaml"
    fixtures = load_fixtures(fixtures_path)
    assert len(fixtures) == 4
    for fixture in fixtures:
        assert fixture["id"]
        assert fixture["intake_payload"]["condition_terms"]


def test_build_eval_set_json_roundtrip():
    backend_dir = Path(__file__).resolve().parent.parent
    fixtures_path = backend_dir / "tests" / "health_cases" / "golden_briefs.yaml"
    eval_set = build_eval_set(load_fixtures(fixtures_path))
    payload = eval_set.model_dump(mode="json")
    assert payload["eval_set_id"] == "synapse_health_cases_golden"
    assert len(payload["eval_cases"]) == 4
    first = payload["eval_cases"][0]
    assert first["eval_id"] == "mactel_diabetes_ckd_67m"
    assert first["conversation"][0]["user_content"]["parts"][0]["text"]


def test_golden_briefs_evalset_json_is_valid():
    backend_dir = Path(__file__).resolve().parent.parent
    json_path = backend_dir / "tests" / "health_cases" / "golden_briefs.evalset.json"
    if not json_path.exists():
        eval_set = build_eval_set(
            load_fixtures(backend_dir / "tests" / "health_cases" / "golden_briefs.yaml")
        )
        json_path.write_text(
            json.dumps(eval_set.model_dump(mode="json"), indent=2) + "\n",
            encoding="utf-8",
        )
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    assert payload["name"] == "Synapse Health Cases Golden Briefs"
