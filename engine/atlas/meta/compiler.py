"""Lessons -> Policy.

Deterministic, total, and boring on purpose. Every lesson kind has exactly one effect on
exactly one node's parameters, and compiling the same lesson set twice yields the same
version hash. All the judgement lives upstream (induction) and downstream (the gate);
none of it lives here.
"""

from __future__ import annotations

from . import store
from .policy import Policy, baseline

# kind -> the DAG node it re-parameterises. A lesson that does not name a node it can
# actually change is not a lesson.
NODE_FOR_KIND = {
    "alias": "join_aco",
    "threshold": "join_aco",
    "blocklist": "join_aco",
    "rule": "enrich_registry",
    "source_pref": "enrich_registry",
    "prompt": "enrich_agentic",
}


def compile_policy(lesson_rows: list[dict] | None = None, base: Policy | None = None) -> Policy:
    """Fold lessons into an immutable policy. Order is creation order, so later lessons
    win where they conflict -- which is what "the reviewer changed their mind" means."""
    p = base or baseline()
    rows = lesson_rows if lesson_rows is not None else store.lessons(status="active")

    aliases = dict(p.aco_aliases)
    blocklist = list(p.aco_blocklist)
    rules = list(p.service_rules)
    prefs = {k: list(v) for k, v in p.source_pref.items()}
    addenda = list(p.prompt_addenda)
    disabled = list(p.disabled_nodes)
    threshold = p.aco_match_threshold
    min_key_tokens = p.aco_min_key_tokens
    min_key_chars = p.aco_min_key_chars
    min_capacity = p.min_capacity
    applied: list[str] = []

    for row in rows:
        kind, payload = row["kind"], row["payload"]
        try:
            if kind == "alias":
                aliases[payload["from"]] = payload["to"]
            elif kind == "threshold":
                if "aco_match_threshold" in payload:
                    threshold = min(0.99, max(0.50, float(payload["aco_match_threshold"])))
                if "aco_min_key_tokens" in payload:
                    min_key_tokens = max(1, int(payload["aco_min_key_tokens"]))
                if "aco_min_key_chars" in payload:
                    min_key_chars = max(3, int(payload["aco_min_key_chars"]))
            elif kind == "blocklist":
                for n in payload.get("names", []):
                    if n not in blocklist:
                        blocklist.append(n)
            elif kind == "rule":
                rules = [r for r in rules if r.get("id") != payload.get("id")]
                rules.append(payload)
            elif kind == "source_pref":
                # `order` and `min_capacity` apply INDEPENDENTLY. Requiring both meant a
                # scope-only lesson ({"field":"beds","min_capacity":20}) raised KeyError on
                # `order`, got swallowed by the except below, and vanished whole -- the
                # reviewer saw a lesson with a rationale that compiled to nothing. A lesson
                # that silently does nothing is worse than one that is refused out loud.
                touched = False
                if "order" in payload and payload.get("field"):
                    prefs[payload["field"]] = list(payload["order"])
                    touched = True
                if "min_capacity" in payload:
                    min_capacity = int(payload["min_capacity"])
                    touched = True
                if not touched:
                    raise KeyError("source_pref needs at least one of `order` or `min_capacity`")
            elif kind == "prompt":
                text = payload.get("text", "").strip()
                if text and text not in addenda:
                    addenda.append(text)
            elif kind == "topology":
                # The seventh kind: a lesson that restructures the graph rather than
                # retuning it. Ops are order-sensitive and last-write-wins, same as
                # every other kind, so "disable then re-enable" resolves to enabled.
                for op in payload.get("ops", []):
                    name = op.get("node")
                    if not name:
                        continue
                    if op.get("op") == "disable_node":
                        if name not in disabled:
                            disabled.append(name)
                    elif op.get("op") == "enable_node":
                        disabled = [n for n in disabled if n != name]
            else:
                continue
        except (KeyError, TypeError, ValueError):
            continue  # a malformed lesson is skipped, never fatal, and never silently "sort of" applied
        applied.append(row["lesson_id"])

    return Policy(
        aco_match_threshold=threshold,
        aco_min_key_tokens=min_key_tokens,
        aco_min_key_chars=min_key_chars,
        aco_aliases=aliases,
        aco_blocklist=blocklist,
        service_rules=rules,
        min_capacity=min_capacity,
        source_pref=prefs,
        prompt_addenda=addenda,
        disabled_nodes=disabled,
        lesson_ids=applied,
        notes=f"{len(applied)} lesson(s) applied",
    ).stamped()


def active_policy() -> Policy:
    return compile_policy(store.lessons(status="active"))


def candidate_policy() -> tuple[Policy, list[str]]:
    """Active lessons plus everything currently proposed -- the thing the gate judges."""
    active = store.lessons(status="active")
    proposed = store.lessons(status="proposed")
    return compile_policy(active + proposed), [r["lesson_id"] for r in proposed]
