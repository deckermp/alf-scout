"""The compiled policy -- the only thing the DAG is allowed to read.

Nodes never consult the lesson store directly. Lessons are *compiled* into an immutable,
version-hashed Policy, and a run records the version it ran under. That is what makes a
run reproducible: replay the version, reproduce the table.

It is also what makes the gate meaningful. You cannot shadow-evaluate "the lessons so
far" -- you can only evaluate a specific compiled artifact against another.
"""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field

from ..schema import policy_hash


class Policy(BaseModel):
    model_config = {"frozen": True}

    version: str = "v0"
    # join_aco
    aco_match_threshold: float = 0.86
    aco_min_key_tokens: int = 2  # a one-word name is not an identity
    aco_min_key_chars: int = 11  # ...unless it is long enough to be one
    aco_aliases: dict[str, str] = Field(default_factory=dict)
    aco_blocklist: list[str] = Field(default_factory=list)  # normalized names never to match
    # enrich_registry
    service_rules: list[dict[str, Any]] = Field(default_factory=list)
    min_capacity: int = 0  # 0 = keep every licensed facility, including 6-bed board-and-care
    # source preference, per field: ordered list of source ids
    source_pref: dict[str, list[str]] = Field(default_factory=dict)
    # enrich_agentic
    prompt_addenda: list[str] = Field(default_factory=list)
    # topology -- which optional nodes run. The other policy fields retune the
    # pipeline; this one restructures it. Empty means the full default graph.
    # Compiled from `topology` lessons; enforced in graph/build.py, which refuses
    # to drop a PROTECTED node no matter what a lesson asks for.
    disabled_nodes: list[str] = Field(default_factory=list)
    # bookkeeping
    lesson_ids: list[str] = Field(default_factory=list)
    notes: str = ""

    def stamped(self) -> Policy:
        payload = self.model_dump(exclude={"version"})
        return self.model_copy(update={"version": "p" + policy_hash(payload)})


DEFAULT_SERVICE_RULES: list[dict[str, Any]] = [
    # Each rule is (field, operator, operand) -> services, with a stated basis.
    # These are the seed rules. Everything beyond them must be *learned* from a human.
    {
        "id": "seed-ccrc",
        "when": {"field": "facility_type", "op": "contains", "value": "CONTINUING CARE"},
        "add": ["IL", "AL"],
        "basis": "A CCRC is licensed to provide independent and assisted living on one campus.",
        "confidence": "derived",
    },
    {
        "id": "seed-rcfe",
        "when": {"field": "facility_type", "op": "contains", "value": "RESIDENTIAL CARE ELDERLY"},
        "add": ["AL"],
        "basis": "California licenses RCFE as the assisted-living category.",
        "confidence": "registry",
    },
    {
        "id": "seed-snf",
        "when": {"field": "source_id", "op": "eq", "value": "S2"},
        "add": ["SNF"],
        "basis": "Medicare/Medicaid certification as a nursing facility.",
        "confidence": "registry",
    },
]


def baseline() -> Policy:
    """v0 -- what the pipeline knows before any human has taught it anything.

    The ACO threshold is deliberately set a little loose (0.86). A build that starts at a
    conservative threshold has nothing to learn, and the point of the exercise is to show
    the loop closing on real false positives.
    """
    return Policy(
        aco_match_threshold=0.86,
        service_rules=list(DEFAULT_SERVICE_RULES),
        source_pref={
            "beds": ["S1", "S2"],
            "management": ["S3", "S1", "S2"],
            "avg_monthly_fee": ["human", "agent"],
        },
        notes="baseline policy -- no lessons applied",
    ).stamped()
