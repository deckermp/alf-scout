"""Graph assembly, including the two HITL seams.

    resolve_zip -> discover -> enrich_registry -> join_aco -> enrich_agentic
                -> apply_overrides -> review(interrupt) -> apply_verdicts -> finalize

`review` is the table-grain pause: LangGraph's `interrupt()` suspends the run with the
assembled table and a checkpoint, and `Command(resume=[verdicts])` restarts it exactly
there. Action-grain HITL happens earlier, inside `enrich_agentic`, through the Agent SDK
permission callback.

Both are real pauses against a real checkpointer. Neither is a modal dialog pretending to
be a workflow.
"""

from __future__ import annotations

import asyncio
import re
import uuid

from langgraph.checkpoint.memory import InMemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

from ..harness import agent as harness
from ..meta import store
from ..schema import Cell, Confidence, ServiceType, Verdict
from . import nodes
from .state import AtlasState

_CHECKPOINTER = InMemorySaver()

_FIELD_MAP = {"avg_monthly_fee": "avg_monthly_fee", "fee": "avg_monthly_fee", "services": "services"}


def enrich_agentic(state: AtlasState) -> dict:
    """Fields no registry holds. Optional by design -- without it the table is smaller
    and honest, never fuller and wrong."""
    facilities = state.get("facilities", [])
    if not state.get("agentic"):
        return {
            "trace": nodes._trace(
                state,
                "enrich_agentic",
                skipped=True,
                reason="agentic enrichment disabled; fee and service-mix cells stay unknown with their reasons",
            )
        }

    policy = state["policy"]
    targets = [f for f in facilities if not f["avg_monthly_fee"]["value"]][:6]
    try:
        res = asyncio.run(harness.enrich(targets, prompt_addenda=policy.prompt_addenda))
    except RuntimeError:
        loop = asyncio.new_event_loop()
        try:
            res = loop.run_until_complete(harness.enrich(targets, prompt_addenda=policy.prompt_addenda))
        finally:
            loop.close()

    by_id = {f["id"]: f for f in facilities}
    applied = 0
    for p in res.proposals:
        f = by_id.get(p.facility_id)
        field = _FIELD_MAP.get(p.field, p.field)
        if not f or field not in ("avg_monthly_fee", "services"):
            continue
        if p.confidence == "unknown" or p.value in (None, "", "unknown"):
            f[field] = Cell.unknown("agent", p.rationale or "agent could not establish this from open sources").model_dump()
            continue
        value = p.value
        if field == "avg_monthly_fee":
            # Real agent output looks like "$9,320/month (assisted living starting rate)".
            m = re.search(r"[\d,]+(?:\.\d+)?", str(value))
            if not m:
                f[field] = Cell.unknown("agent", f"agent returned an unparseable fee: {value!r}").model_dump()
                continue
            value = float(m.group(0).replace(",", ""))
        elif field == "services":
            # Only the four categories are meaningful here. An agent saying
            # "None of IL/AL/MC/HH" must land as unknown, not as four bogus services.
            text = value if isinstance(value, str) else ",".join(map(str, value or []))
            valid = {s.value for s in ServiceType}
            found = [t for t in re.split(r"[^A-Za-z]+", text.upper()) if t in valid]
            negated = re.search(r"\b(NONE|NEITHER|NO)\b", text.upper())
            value = [] if negated else list(dict.fromkeys(found))
            if not value:
                f[field] = Cell.unknown(
                    "agent", (p.rationale or "agent found none of IL/AL/MC/HH at this facility")[:400]
                ).model_dump()
                continue
        f[field] = Cell(
            value=value,
            confidence=Confidence.INFERRED,
            source="agent",
            note=(p.rationale or "")[:400] + (f" [evidence: {', '.join(p.evidence[:3])}]" if p.evidence else ""),
        ).model_dump()
        applied += 1

    return {
        "facilities": facilities,
        "trace": nodes._trace(
            state,
            "enrich_agentic",
            targeted=len(targets),
            proposals=len(res.proposals),
            applied=applied,
            cost_usd=round(res.cost_usd, 4),
            turns=res.turns,
            error=res.error,
        ),
    }


def review(state: AtlasState) -> dict:
    """Table-grain HITL. Suspends the graph until a human returns verdicts."""
    if not state.get("review_required"):
        return {"trace": nodes._trace(state, "review", skipped=True, reason="review not requested for this run")}

    facilities = state.get("facilities", [])
    payload = interrupt(
        {
            "kind": "table_review",
            "run_id": state.get("run_id"),
            "zip": state.get("zip"),
            "rows": len(facilities),
            "needs_attention": [
                {
                    "facility_id": f["id"],
                    "name": f["name"],
                    "field": field,
                    "value": f[field].get("value"),
                    "confidence": f[field].get("confidence"),
                    "note": f[field].get("note"),
                }
                for f in facilities
                for field in ("acos", "avg_monthly_fee", "services")
                if f[field].get("confidence") in ("inferred", "unknown")
            ][:40],
        }
    )
    return {"verdicts": payload if isinstance(payload, list) else [], "trace": nodes._trace(state, "review", verdicts=len(payload or []))}


def apply_verdicts(state: AtlasState) -> dict:
    """Land the human's judgement on the table and persist it as evidence for the
    meta-learning loop. Confirmations matter as much as corrections -- a threshold cannot
    be tuned from negatives alone."""
    verdicts = state.get("verdicts") or []
    if not verdicts:
        return {"trace": nodes._trace(state, "apply_verdicts", applied=0)}

    facilities = state.get("facilities", [])
    by_id = {f["id"]: f for f in facilities}
    records: list[Verdict] = []
    applied = 0

    for v in verdicts:
        fid, field, action = v.get("facility_id"), v.get("field"), v.get("action", "confirm")
        f = by_id.get(fid)
        if not f or field not in f:
            continue
        before = f[field].get("value")
        if action == "correct":
            f[field] = Cell(
                value=v.get("after"),
                confidence=Confidence.REGISTRY,
                source="human",
                note=v.get("note") or "corrected by reviewer",
                human_verified=True,
                corrected_from=before,
            ).model_dump()
            store.set_override(fid, field, v.get("after"), v.get("note") or "corrected by reviewer")
            applied += 1
        elif action == "reject":
            if field == "acos" and isinstance(before, list):
                # `after` names which links to remove; the override must record what REMAINS.
                drop = set(v.get("after") or [])
                keep = [a for a in before if isinstance(a, dict) and a.get("aco_id") not in drop]
                cell = Cell(
                    value=keep,
                    confidence=Confidence.REGISTRY if keep else Confidence.UNKNOWN,
                    source="human",
                    note=v.get("note") or "reviewer rejected one or more proposed ACO matches",
                    human_verified=True,
                    corrected_from=before,
                )
                f[field] = cell.model_dump()
                store.set_override(fid, field, keep, cell.note or "")
            else:
                cell = Cell.unknown("human", v.get("note") or "reviewer rejected this value")
                f[field] = cell.model_dump()
                store.set_override(fid, field, None, cell.note or "")
            applied += 1
        elif action == "confirm":
            cur = dict(f[field])
            cur["human_verified"] = True
            if field == "acos" and isinstance(cur.get("value"), list):
                cur["value"] = [{**a, "status": "confirmed"} for a in cur["value"]]
                cur["confidence"] = Confidence.REGISTRY.value
            f[field] = cur
            applied += 1
        records.append(
            Verdict(
                run_id=state.get("run_id", ""),
                facility_id=fid,
                field=field,
                action=action,
                before=before,
                after=v.get("after"),
                note=v.get("note", ""),
                reviewer=v.get("reviewer", "reviewer"),
            )
        )

    store.add_verdicts(records)
    return {"facilities": facilities, "trace": nodes._trace(state, "apply_verdicts", applied=applied, recorded=len(records))}


def build_graph():
    g = StateGraph(AtlasState)
    g.add_node("resolve_zip", nodes.resolve_zip)
    g.add_node("discover", nodes.discover)
    g.add_node("enrich_registry", nodes.enrich_registry)
    g.add_node("join_aco", nodes.join_aco)
    g.add_node("enrich_agentic", enrich_agentic)
    g.add_node("apply_overrides", nodes.apply_overrides)
    g.add_node("review", review)
    g.add_node("apply_verdicts", apply_verdicts)
    g.add_node("finalize", nodes.finalize)

    g.add_edge(START, "resolve_zip")
    g.add_edge("resolve_zip", "discover")
    g.add_edge("discover", "enrich_registry")
    g.add_edge("enrich_registry", "join_aco")
    g.add_edge("join_aco", "enrich_agentic")
    g.add_edge("enrich_agentic", "apply_overrides")
    g.add_edge("apply_overrides", "review")
    g.add_edge("review", "apply_verdicts")
    g.add_edge("apply_verdicts", "finalize")
    g.add_edge("finalize", END)
    return g.compile(checkpointer=_CHECKPOINTER)


_GRAPH = None


def graph():
    global _GRAPH
    if _GRAPH is None:
        _GRAPH = build_graph()
    return _GRAPH


def new_thread() -> tuple[str, dict]:
    rid = "R" + uuid.uuid4().hex[:10]
    return rid, {"configurable": {"thread_id": rid}}
