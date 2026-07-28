"""A source_pref lesson must never compile to nothing while looking like it worked.

Regression test. `compile_policy` read `payload["order"]` unconditionally, so a scope-only
lesson -- {"field":"beds","min_capacity":20}, which is exactly what the agent inducer emits
from "I only care about 20+ bed communities" -- raised KeyError, hit the blanket except, and
was dropped whole. The reviewer saw a created lesson with a good rationale; the policy was
unchanged and nothing said so.
"""

from __future__ import annotations

from atlas.meta.compiler import compile_policy


def L(payload):
    return [{"lesson_id": "L1", "kind": "source_pref", "node": "enrich_registry",
             "payload": payload, "rationale": "", "evidence": []}]


def test_min_capacity_alone_applies():
    p = compile_policy(L({"field": "beds", "min_capacity": 20}))
    assert p.min_capacity == 20
    assert p.lesson_ids == ["L1"], "the lesson must be recorded as applied, not silently dropped"


def test_order_alone_applies():
    p = compile_policy(L({"field": "beds", "order": ["S2", "S1"]}))
    assert p.source_pref["beds"] == ["S2", "S1"]
    assert p.lesson_ids == ["L1"]


def test_both_apply_together():
    p = compile_policy(L({"field": "beds", "order": ["S2", "S1"], "min_capacity": 15}))
    assert p.min_capacity == 15 and p.source_pref["beds"] == ["S2", "S1"]


def test_a_lesson_that_asks_for_nothing_is_dropped():
    """The one case where dropping is right -- and it must not be recorded as applied."""
    p = compile_policy(L({"field": "beds"}))
    assert p.lesson_ids == []
    assert p.min_capacity == 0


def test_scope_only_lesson_changes_the_policy_version():
    """The gate compares compiled artifacts. If the version does not move, the gate has
    nothing to evaluate and the reviewer's preference is invisible to it."""
    base = compile_policy([])
    scoped = compile_policy(L({"field": "beds", "min_capacity": 20}))
    assert scoped.version != base.version
