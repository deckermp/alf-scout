"""Public entry point: ZIP in, table out, with the HITL pause in the middle."""

from __future__ import annotations

from typing import Any

from langgraph.types import Command

from .graph.build import graph, new_thread
from .meta import store
from .meta.compiler import active_policy
from .meta.policy import Policy
from .schema import Facility, SearchResult, utcnow


def _to_result(rid: str, zipcode: str, radius: float, policy: Policy, state: dict, agentic: bool) -> SearchResult:
    return SearchResult(
        run_id=rid,
        zip=zipcode,
        origin_lat=(state.get("origin") or [None, None])[0],
        origin_lon=(state.get("origin") or [None, None])[1],
        radius_mi=radius,
        facilities=[Facility.model_validate(f) for f in state.get("facilities", [])],
        gaps=state.get("gaps", []),
        policy_version=policy.version,
        trace=state.get("trace", []),
        finished_at=utcnow(),
        agentic_enabled=agentic,
    )


def search(
    zipcode: str,
    radius_mi: float = 10.0,
    agentic: bool = False,
    review: bool = False,
    policy: Policy | None = None,
    use_overrides: bool = True,
) -> tuple[SearchResult, dict | None, dict]:
    """Run the pipeline.

    Returns (result, interrupt_payload, thread_config). When `review=True` the run pauses
    at the review node and `interrupt_payload` is non-None -- call `resume()` with the
    same thread config to finish it.
    """
    pol = policy or active_policy()
    rid, cfg = new_thread()
    init = {
        "run_id": rid,
        "zip": zipcode,
        "radius_mi": radius_mi,
        "policy": pol,
        "agentic": agentic,
        "review_required": review,
        "use_overrides": use_overrides,
        "trace": [],
    }
    out = graph().invoke(init, cfg)

    interrupts = out.get("__interrupt__") or []
    if interrupts:
        snap = graph().get_state(cfg)
        payload = interrupts[0].value if hasattr(interrupts[0], "value") else interrupts[0]
        result = _to_result(rid, zipcode, radius_mi, pol, snap.values, agentic)
        store.save_run(result)
        return result, payload, cfg

    result = _to_result(rid, zipcode, radius_mi, pol, out, agentic)
    store.save_run(result)
    return result, None, cfg


def resume(cfg: dict, verdicts: list[dict[str, Any]]) -> SearchResult:
    """Deliver the human's verdicts to the paused graph and let it finish."""
    out = graph().invoke(Command(resume=verdicts), cfg)
    rid = out.get("run_id", "")
    pol = out.get("policy")
    result = _to_result(rid, out.get("zip", ""), out.get("radius_mi", 10.0), pol, out, out.get("agentic", False))
    store.save_run(result)
    return result
