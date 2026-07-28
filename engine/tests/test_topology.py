"""Topology as the seventh lesson kind.

The other six lesson kinds *retune* the pipeline -- a threshold, an alias, a source
preference. A `topology` lesson *restructures* it: it takes a node out of the graph.

The whole point of routing it through the same machinery is that restructuring is the
most dangerous thing a human's feedback can do, so it must be the most thoroughly
checked. Two defences, tested here:

  1. A hard bound on what a lesson is *allowed* to ask for (PROTECTED_NODES), which is
     not a judgement call and does not depend on the evals.
  2. The eval gate, which decides whether an allowed change is actually *good* by
     replaying the frozen set under the candidate graph.

The second only works because `score_policy` runs the real pipeline. A topology lesson
that compiled into the policy hash but never reached the graph builder would shadow-replay
identically to active and look harmless -- inert while appearing to have been evaluated.
`test_a_disabled_node_actually_changes_the_replay` is the guard against that.
"""

from __future__ import annotations

from atlas.graph.build import PIPELINE, PROTECTED_NODES, build_graph
from atlas.meta import evals
from atlas.meta.compiler import compile_policy


def L(lesson_id, ops, node="graph"):
    return {
        "lesson_id": lesson_id,
        "kind": "topology",
        "node": node,
        "payload": {"ops": ops},
        "rationale": "",
        "evidence": [],
    }


def test_a_topology_lesson_disables_a_node():
    p = compile_policy([L("L1", [{"op": "disable_node", "node": "enrich_agentic"}])])
    assert p.disabled_nodes == ["enrich_agentic"]


def test_disable_then_enable_resolves_to_enabled():
    """Same last-write-wins semantics as every other kind: the reviewer changed their mind."""
    p = compile_policy(
        [
            L("L1", [{"op": "disable_node", "node": "enrich_agentic"}]),
            L("L2", [{"op": "enable_node", "node": "enrich_agentic"}]),
        ]
    )
    assert p.disabled_nodes == []


def test_topology_changes_the_policy_version():
    """If it did not, the gate would short-circuit to `noop` and never evaluate it."""
    base = compile_policy([])
    changed = compile_policy([L("L1", [{"op": "disable_node", "node": "enrich_agentic"}])])
    assert base.version != changed.version


def test_a_malformed_topology_lesson_is_skipped_not_half_applied():
    p = compile_policy([L("L1", [{"op": "disable_node"}, {"op": "nonsense", "node": "join_aco"}])])
    assert p.disabled_nodes == []


def test_protected_nodes_survive_a_lesson_that_asks_to_remove_them():
    """A lesson may ask for anything; the builder is what refuses.

    apply_overrides is in the protected set specifically because dropping it would stop
    applying the reviewer's own corrections -- a topology lesson could otherwise discard
    human work while reporting success.
    """
    for name in sorted(PROTECTED_NODES):
        p = compile_policy([L("L1", [{"op": "disable_node", "node": name}])])
        assert p.disabled_nodes == [name], "the lesson still compiles; the bound is at build time"
        build_graph(p.disabled_nodes)  # must not raise
        assert name in dict(PIPELINE), "protected node must exist in the pipeline it protects"


def test_the_graph_still_builds_with_an_optional_node_removed():
    """Edges rewire around the gap; the chain does not acquire a hole."""
    assert build_graph(["enrich_agentic"]) is not None
    assert build_graph(["enrich_agentic", "review", "apply_verdicts"]) is not None


def test_a_disabled_node_actually_changes_the_replay():
    """The load-bearing test.

    Disabling `enrich_registry` must move a measured metric. If this passes with the two
    scores identical, topology is compiling into the policy but never reaching the graph,
    and every topology lesson would sail through the gate as a harmless no-op.
    """
    base = compile_policy([])
    without_registry = compile_policy([L("L1", [{"op": "disable_node", "node": "enrich_registry"}])])

    before = evals.score_policy(base)
    after = evals.score_policy(without_registry)

    assert before != after, "disabling a node did not change the replay -- topology is not wired to the graph"


def test_the_gate_refuses_a_topology_lesson_that_regresses_a_guardrail():
    """Removing enrich_registry is exactly the kind of change a plausible-sounding
    instruction could produce ('stop hitting the registry, it is slow'). The gate should
    catch it on evidence rather than on anyone's intuition."""
    base = compile_policy([])
    without_registry = compile_policy([L("L1", [{"op": "disable_node", "node": "enrich_registry"}])])

    spec = evals.load_cases()
    report = evals.gate(
        evals.score_policy(base, spec),
        evals.score_policy(without_registry, spec),
        spec.get("guardrails", {}),
    )
    assert report["decision"] != "promote", f"a regressing topology change was promoted: {report}"
