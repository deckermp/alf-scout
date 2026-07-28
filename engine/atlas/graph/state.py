from __future__ import annotations

from typing import Annotated, Any, TypedDict

from ..meta.policy import Policy


def _replace(_old: Any, new: Any) -> Any:
    return new


class AtlasState(TypedDict, total=False):
    run_id: str
    zip: str
    radius_mi: float
    state_code: str
    origin: tuple[float, float] | None
    nearby_zips: list[str]

    policy: Policy
    agentic: bool

    raw: Annotated[list[dict], _replace]
    facilities: Annotated[list[dict], _replace]  # serialized Facility
    gaps: Annotated[list[dict], _replace]
    trace: Annotated[list[dict], _replace]

    # HITL
    verdicts: Annotated[list[dict], _replace]
    review_required: bool
    # False for eval/shadow runs: the gate must see raw pipeline behaviour, not patches.
    use_overrides: bool
