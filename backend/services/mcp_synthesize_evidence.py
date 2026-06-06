"""Evidence synthesis helpers for Synapse Evidence MCP."""

from __future__ import annotations

import re
from typing import Any, Optional

from api.models.knowledge_graph.clinical_question import ClinicalQuestion
from api.models.knowledge_graph.consensus import ConsensusSnapshot
from services.consensus_engine import compute_consensus
from services.disagreement_adjudicator import (
    DisagreementReason,
    adjudicate_disagreement,
)


def _normalize(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _match_questions(
    question: str,
    *,
    domain: str = "cardiology",
    max_results: int = 3,
) -> list[ClinicalQuestion]:
    query = _normalize(question)
    if not query:
        return []

    mongo_query = {
        "$or": [
            {"population": {"$regex": re.escape(query[:80]), "$options": "i"}},
            {"intervention": {"$regex": re.escape(query[:80]), "$options": "i"}},
            {"endpoint_definition": {"$regex": re.escape(query[:80]), "$options": "i"}},
        ]
    }
    if domain == "cardiology":
        mongo_query["population_mesh_ids"] = {"$exists": True}

    return list(
        ClinicalQuestion.objects(__raw__=mongo_query)
        .order_by("-updated_at")
        .limit(max_results)
    )


def _parse_disagreement(open_question: str) -> dict[str, Any]:
    if ":" in open_question:
        label, narrative = open_question.split(":", 1)
        reason_code = None
        for reason in DisagreementReason:
            if _normalize(reason.value.replace("_", " ")) in _normalize(label):
                reason_code = reason.value
                break
        return {
            "reason_label": label.strip(),
            "reason_code": reason_code or "unknown",
            "narrative": narrative.strip(),
        }
    return {
        "reason_label": "disagreement",
        "reason_code": "unknown",
        "narrative": open_question,
    }


def synthesize_evidence(
    *,
    question: str,
    paper_ids: Optional[list[str]] = None,
    domain: str = "cardiology",
) -> dict[str, Any]:
    del paper_ids  # reserved for a future paper-scoped synthesis path
    matches = _match_questions(question, domain=domain)
    if not matches:
        return {
            "question": question,
            "domain": domain,
            "answer": None,
            "confidence": None,
            "agreements": [],
            "disagreements": [],
            "matched_questions": [],
        }

    primary = matches[0]
    snapshot = (
        ConsensusSnapshot.objects(question_id=primary.question_id)
        .order_by("-version")
        .first()
    )
    if snapshot is None:
        snapshot = compute_consensus(primary.question_id)

    disagreements = [
        _parse_disagreement(item)
        for item in (getattr(snapshot, "open_questions", []) or [])
    ]
    agreements = list(getattr(snapshot, "key_supporting_families", []) or [])

    return {
        "question": question,
        "domain": domain,
        "answer": getattr(snapshot, "summary", None),
        "confidence": getattr(snapshot, "certainty_level", None),
        "consensus_level": getattr(snapshot, "consensus_level", None),
        "agreements": agreements,
        "disagreements": disagreements,
        "matched_questions": [
            {
                "question_id": item.question_id,
                "population": item.population,
                "intervention": item.intervention,
                "outcome": item.endpoint_definition or item.outcome_id,
            }
            for item in matches
        ],
    }


def adjudicate_for_question(question_id: str) -> list[dict[str, Any]]:
    """Run disagreement adjudication directly when a weighted bundle is needed."""
    from services.consensus_engine import (
        _bundle_estimates,
        _compute_replication_counts,
        _compute_weight,
    )

    question = ClinicalQuestion.objects(question_id=question_id).first()
    if not question:
        return []
    bundle = _bundle_estimates(question_id)
    if not bundle:
        return []

    rep_counts = _compute_replication_counts(bundle)
    weighted_bundle = []
    for entry in bundle:
        est = entry["estimate"]
        fam = entry["study_family"]
        est_direction = est.direction or "not_reported"
        rep_count = max(rep_counts.get(est_direction, 1) - 1, 0)
        weight = _compute_weight(
            est,
            fam,
            {
                "is_primary_in_family": entry["is_primary_in_family"],
                "replication_count": rep_count,
            },
        )
        fam_key = (fam.family_id if fam else None) or f"orphan_{est.estimate_id}"
        weighted_bundle.append(
            {
                "estimate": est,
                "study_family": fam,
                "weight": weight,
                "direction": est_direction,
                "family_id": fam_key,
                "is_primary_in_family": entry["is_primary_in_family"],
                "question_meta": {
                    "intervention": question.intervention,
                    "outcome": question.endpoint_definition or question.outcome_id,
                    "population": question.population,
                },
            }
        )

    findings = adjudicate_disagreement(question, weighted_bundle)
    return [
        {
            "reason_code": finding.reason_code.value,
            "reason_label": finding.reason_code.value.replace("_", " "),
            "narrative": finding.narrative,
            "estimate_ids": finding.estimate_ids,
            "family_ids": finding.family_ids,
        }
        for finding in findings
    ]
