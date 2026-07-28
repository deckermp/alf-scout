"""The gate.

A candidate policy is replayed against a frozen set of hand-verified cases and compared
to the currently active policy. It is promoted only if the target metric improves and no
guardrail regresses.

The design constraint that matters: **there is no force parameter.** The fleet-harness
work established that a gate reachable by `force` is not a gate, and that a promotion
which can only be achieved by overriding the check is an incident, not a release. So the
only way to promote a lesson here is to earn it on the frozen set.

Shadow mode: candidates run against recorded cases, never against a user's live request.
The reviewer is the beneficiary of the improvement, never the subject of the experiment.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ..schema import utcnow
from . import store
from .compiler import active_policy, candidate_policy
from .policy import Policy

FROZEN_SET = Path(__file__).resolve().parents[2] / "evals" / "frozen_set.json"


def load_cases() -> dict:
    return json.loads(FROZEN_SET.read_text())


def _contains(haystack: str, needle: str) -> bool:
    return needle.strip().upper() in (haystack or "").upper()


def score_policy(policy: Policy, cases: dict | None = None) -> dict[str, Any]:
    """Replay every frozen case under one policy. Pure measurement, no judgement."""
    from ..pipeline import search  # local import: pipeline imports compiler

    spec = cases or load_cases()
    tp = fp = fn = 0
    rows_total = 0
    beds_known = beds_total = 0
    details: list[dict] = []

    for case in spec["cases"]:
        # use_overrides=False is load-bearing: with human patches applied, every candidate
        # policy scores identically on the cases a reviewer already fixed, and the gate
        # measures the reviewer instead of the pipeline.
        result, _, _ = search(
            case["zip"],
            radius_mi=case.get("radius_mi", 4.0),
            agentic=False,
            policy=policy,
            use_overrides=False,
        )
        rows_total += len(result.facilities)
        for f in result.facilities:
            beds_total += 1
            if f.beds.known:
                beds_known += 1

        case_detail = {"id": case["id"], "rows": len(result.facilities), "hits": [], "misses": [], "leaks": []}

        for want in case.get("expect_aco", []):
            matched = False
            for f in result.facilities:
                if not _contains(f.name, want["facility_contains"]):
                    continue
                for a in f.acos.value or []:
                    if _contains(a.get("aco_name", ""), want["aco_name_contains"]):
                        matched = True
            if matched:
                tp += 1
                case_detail["hits"].append(want["facility_contains"])
            else:
                fn += 1
                case_detail["misses"].append(want["facility_contains"])

        for forbid in case.get("forbid_aco", []):
            leaked = False
            for f in result.facilities:
                if _contains(f.name, forbid["facility_contains"]) and (f.acos.value or []):
                    leaked = True
            if leaked:
                fp += 1
                case_detail["leaks"].append(forbid["facility_contains"])

        details.append(case_detail)

    precision = tp / (tp + fp) if (tp + fp) else 1.0
    recall = tp / (tp + fn) if (tp + fn) else 1.0
    return {
        "policy_version": policy.version,
        "aco_true_positives": tp,
        "aco_false_positives": fp,
        "aco_false_negatives": fn,
        "aco_precision": round(precision, 4),
        "aco_recall": round(recall, 4),
        "beds_coverage": round(beds_known / beds_total, 4) if beds_total else 0.0,
        "rows_total": rows_total,
        "cases": details,
        "at": utcnow(),
    }


def gate(baseline_score: dict, candidate_score: dict, guardrails: dict) -> dict[str, Any]:
    """Decide. Every clause is stated so a refusal can be read, not guessed at."""
    reasons: list[str] = []

    improves = candidate_score["aco_precision"] > baseline_score["aco_precision"] or (
        candidate_score["aco_precision"] == baseline_score["aco_precision"]
        and candidate_score["aco_recall"] > baseline_score["aco_recall"]
    )
    if not improves:
        reasons.append(
            f"target metric did not improve: precision {baseline_score['aco_precision']} -> "
            f"{candidate_score['aco_precision']}, recall {baseline_score['aco_recall']} -> {candidate_score['aco_recall']}"
        )

    if candidate_score["aco_recall"] < baseline_score["aco_recall"]:
        reasons.append(
            f"GUARDRAIL: recall regressed {baseline_score['aco_recall']} -> {candidate_score['aco_recall']} "
            f"({candidate_score['aco_false_negatives']} true affiliations lost)"
        )
    if candidate_score["beds_coverage"] < guardrails.get("min_beds_coverage", 0.95):
        reasons.append(
            f"GUARDRAIL: beds coverage {candidate_score['beds_coverage']} below floor {guardrails['min_beds_coverage']}"
        )
    if candidate_score["rows_total"] < guardrails.get("min_rows_total", 0):
        reasons.append(
            f"GUARDRAIL: {candidate_score['rows_total']} rows discovered, floor is {guardrails['min_rows_total']} "
            "-- a policy that improves precision by returning fewer facilities has not improved anything"
        )

    decision = "promote" if not reasons else "quarantine"
    return {
        "decision": decision,
        "reasons": reasons or ["target metric improved and no guardrail regressed"],
        "baseline": baseline_score,
        "candidate": candidate_score,
        "at": utcnow(),
    }


def run_gate(auto_apply: bool = True) -> dict[str, Any]:
    """Score active vs candidate, decide, and record the decision either way.

    A quarantine is written to the lesson row with its failing report attached, so the
    reason a lesson did not ship survives in the same place as the lesson.
    """
    spec = load_cases()
    base = active_policy()
    cand, proposed_ids = candidate_policy()

    if not proposed_ids:
        return {"decision": "noop", "reasons": ["no proposed lessons to evaluate"], "at": utcnow()}
    if cand.version == base.version:
        return {"decision": "noop", "reasons": ["candidate compiles to the same policy as active"], "at": utcnow()}

    report = gate(score_policy(base, spec), score_policy(cand, spec), spec.get("guardrails", {}))
    report["lesson_ids"] = proposed_ids

    if auto_apply:
        store.set_lesson_status(proposed_ids, "active" if report["decision"] == "promote" else "quarantined", report)
        store.record_promotion(base.version, cand.version, report["decision"], report)
    return report
