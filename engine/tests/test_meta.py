"""The meta-learning loop: compiler determinism, induction, and the gate's refusals."""

from __future__ import annotations

from atlas.meta import evals
from atlas.meta.compiler import compile_policy
from atlas.meta.policy import baseline


def L(lesson_id, kind, payload, node="join_aco"):
    return {"lesson_id": lesson_id, "kind": kind, "node": node, "payload": payload, "rationale": "", "evidence": []}


def test_compiling_the_same_lessons_twice_gives_the_same_version():
    lessons = [L("L1", "threshold", {"aco_match_threshold": 0.9}), L("L2", "alias", {"from": "a", "to": "b"})]
    assert compile_policy(lessons).version == compile_policy(lessons).version


def test_different_lessons_give_a_different_version():
    a = compile_policy([L("L1", "threshold", {"aco_match_threshold": 0.90})])
    b = compile_policy([L("L1", "threshold", {"aco_match_threshold": 0.91})])
    assert a.version != b.version


def test_later_lessons_win_on_conflict():
    p = compile_policy(
        [L("L1", "threshold", {"aco_match_threshold": 0.90}), L("L2", "threshold", {"aco_match_threshold": 0.95})]
    )
    assert p.aco_match_threshold == 0.95


def test_threshold_is_clamped_to_a_sane_band():
    assert compile_policy([L("L1", "threshold", {"aco_match_threshold": 5.0})]).aco_match_threshold == 0.99
    assert compile_policy([L("L1", "threshold", {"aco_match_threshold": -1})]).aco_match_threshold == 0.50


def test_a_malformed_lesson_is_skipped_not_half_applied():
    p = compile_policy([L("L1", "threshold", {"wrong_key": 1}), L("L2", "alias", {"from": "x", "to": "y"})])
    assert p.aco_match_threshold == baseline().aco_match_threshold
    assert p.aco_aliases == {"x": "y"}
    assert "L2" in p.lesson_ids


def test_rules_replace_by_id_rather_than_accumulating():
    rule = {"id": "seed-rcfe", "when": {"field": "facility_type", "op": "contains", "value": "X"}, "add": ["MC"]}
    p = compile_policy([L("L1", "rule", rule, node="enrich_registry")])
    matching = [r for r in p.service_rules if r["id"] == "seed-rcfe"]
    assert len(matching) == 1 and matching[0]["add"] == ["MC"]


# ------------------------------------------------------------------ the gate

BASE = {"aco_precision": 0.75, "aco_recall": 1.0, "aco_true_positives": 3, "aco_false_positives": 1,
        "beds_coverage": 1.0, "rows_total": 163, "aco_false_negatives": 0}
GUARD = {"min_beds_coverage": 0.95, "min_rows_total": 140}


def test_gate_promotes_a_precision_win_that_holds_recall():
    cand = {**BASE, "aco_precision": 1.0, "aco_false_positives": 0}
    assert evals.gate(BASE, cand, GUARD)["decision"] == "promote"


def test_gate_refuses_precision_bought_with_recall():
    cand = {**BASE, "aco_precision": 1.0, "aco_recall": 0.0, "aco_true_positives": 0, "aco_false_negatives": 3}
    report = evals.gate(BASE, cand, GUARD)
    assert report["decision"] == "quarantine"
    assert any("recall regressed" in r for r in report["reasons"])


def test_gate_refuses_a_policy_that_improves_by_finding_fewer_facilities():
    cand = {**BASE, "aco_precision": 1.0, "aco_false_positives": 0, "rows_total": 12}
    report = evals.gate(BASE, cand, GUARD)
    assert report["decision"] == "quarantine"
    assert any("rows discovered" in r for r in report["reasons"])


def test_gate_refuses_a_registry_coverage_regression():
    cand = {**BASE, "aco_precision": 1.0, "aco_false_positives": 0, "beds_coverage": 0.4}
    assert evals.gate(BASE, cand, GUARD)["decision"] == "quarantine"


def test_gate_refuses_a_no_op_change():
    assert evals.gate(BASE, dict(BASE), GUARD)["decision"] == "quarantine"


def test_gate_has_no_force_parameter():
    """A gate reachable by force is not a gate."""
    import inspect

    for fn in (evals.gate, evals.run_gate):
        assert "force" not in inspect.signature(fn).parameters


def test_frozen_set_declares_its_target_and_guardrails():
    spec = evals.load_cases()
    assert spec["cases"] and spec["guardrails"]["min_beds_coverage"] >= 0.9
    for case in spec["cases"]:
        for want in case.get("expect_aco", []) + case.get("forbid_aco", []):
            assert want.get("why"), "every frozen assertion must say how it was established"
