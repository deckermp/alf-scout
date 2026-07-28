"""Core types.

The load-bearing idea: a table cell is never a bare value. It is a value plus where it
came from and how much we believe it. A cell that cannot name its source cannot be
constructed -- `Cell` requires `source`, and `unknown()` requires a `reason`.

This is the trust ladder from the data-model package, narrowed to one object.
"""

from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class Confidence(str, Enum):
    """Deliberately four rungs, not a float. A float invites averaging."""

    REGISTRY = "registry"  # a government registry said so, verbatim
    DERIVED = "derived"  # computed from registry data by inspectable code
    INFERRED = "inferred"  # an agent concluded it from open sources
    UNKNOWN = "unknown"  # we do not know, and here is why

    @property
    def rank(self) -> int:
        return {"registry": 3, "derived": 2, "inferred": 1, "unknown": 0}[self.value]


class ServiceType(str, Enum):
    IL = "IL"  # independent living
    AL = "AL"  # assisted living
    MC = "MC"  # memory care
    HH = "HH"  # home health
    SNF = "SNF"  # skilled nursing (not requested, but it is what CMS certifies)


class Cell(BaseModel):
    """One value in the output table, with its receipt."""

    model_config = {"frozen": True}

    value: Any = None
    confidence: Confidence
    source: str = Field(description="Source id (S1..S7) or agent id. Never empty.")
    note: str | None = None
    retrieved_at: str = Field(default_factory=utcnow)
    # Set when a human corrected this cell. Survives re-runs as an override.
    human_verified: bool = False
    corrected_from: Any = None

    @field_validator("source")
    @classmethod
    def _source_required(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("Cell.source is required -- a cell with no provenance is not constructible")
        return v

    @classmethod
    def unknown(cls, source: str, reason: str) -> Cell:
        """The honest branch. `reason` is mandatory: deferral is not laundering."""
        if not reason or not reason.strip():
            raise ValueError("Cell.unknown() requires a reason")
        return cls(value=None, confidence=Confidence.UNKNOWN, source=source, note=reason)

    @property
    def known(self) -> bool:
        return self.confidence is not Confidence.UNKNOWN and self.value is not None

    def corrected(self, new_value: Any, note: str | None = None) -> Cell:
        return Cell(
            value=new_value,
            confidence=Confidence.REGISTRY if self.confidence is Confidence.REGISTRY else Confidence.DERIVED,
            source="human",
            note=note or "corrected by reviewer",
            human_verified=True,
            corrected_from=self.value,
        )


class ACOLink(BaseModel):
    aco_id: str
    aco_name: str
    service_area: str = ""
    match_score: float = Field(ge=0.0, le=1.0)
    matched_on: str = Field(description="The affiliate legal business name that matched")
    snf_3day_waiver: bool = False
    public_reporting_url: str | None = None
    # Fuzzy joins are proposals until a human says otherwise.
    status: Literal["proposed", "confirmed", "rejected"] = "proposed"


class Facility(BaseModel):
    """One row. `id` is stable across runs so corrections can re-attach."""

    id: str
    name: str
    address: str = ""
    city: str = ""
    state: str = ""
    zip: str = ""
    lat: float | None = None
    lon: float | None = None

    # Every requested output column, as a Cell.
    distance_mi: Cell
    beds: Cell
    bed_basis: Cell  # licensed capacity vs Medicare-certified -- NOT the same number
    avg_monthly_fee: Cell
    management: Cell
    services: Cell
    acos: Cell  # value is list[ACOLink]

    # Context that is real and free, so we carry it.
    facility_kind: str = ""  # e.g. "RCFE-CONTINUING CARE RETIREMENT COMMUNITY"
    cms_ccn: str | None = None
    license_id: str | None = None
    # The licensed/certified legal entity, as distinct from the building's trading name.
    # CMS keys its ACO affiliate file on exactly this, so it is the high-precision join key.
    legal_business_name: str = ""
    cms_overall_rating: Cell | None = None
    source_ids: list[str] = Field(default_factory=list)

    def cells(self) -> dict[str, Cell]:
        out = {
            "distance_mi": self.distance_mi,
            "beds": self.beds,
            "bed_basis": self.bed_basis,
            "avg_monthly_fee": self.avg_monthly_fee,
            "management": self.management,
            "services": self.services,
            "acos": self.acos,
        }
        if self.cms_overall_rating is not None:
            out["cms_overall_rating"] = self.cms_overall_rating
        return out

    @property
    def coverage(self) -> float:
        """Fraction of requested columns actually established. The headline honesty metric."""
        cs = [self.distance_mi, self.beds, self.avg_monthly_fee, self.management, self.services, self.acos]
        return sum(1 for c in cs if c.known) / len(cs)


class CoverageGap(BaseModel):
    """A first-class row, not an empty table.

    There is no federal ALF licensure (R4 s7a), so most states genuinely have no
    connector yet. Saying that is the product working, not the product failing.
    """

    state: str
    reason: str
    what_would_close_it: str
    partial_sources: list[str] = Field(default_factory=list)


class Verdict(BaseModel):
    """One human judgement about one cell. The raw material of meta-learning."""

    run_id: str
    facility_id: str
    field: str
    action: Literal["confirm", "correct", "reject", "flag"]
    before: Any = None
    after: Any = None
    note: str = ""
    at: str = Field(default_factory=utcnow)
    reviewer: str = "reviewer"


class SearchResult(BaseModel):
    run_id: str
    zip: str
    origin_lat: float | None = None
    origin_lon: float | None = None
    radius_mi: float = 15.0
    facilities: list[Facility] = Field(default_factory=list)
    gaps: list[CoverageGap] = Field(default_factory=list)
    policy_version: str = ""
    trace: list[dict] = Field(default_factory=list)
    started_at: str = Field(default_factory=utcnow)
    finished_at: str | None = None
    agentic_enabled: bool = False

    @property
    def mean_coverage(self) -> float:
        if not self.facilities:
            return 0.0
        return sum(f.coverage for f in self.facilities) / len(self.facilities)


def stable_id(*parts: str) -> str:
    return hashlib.sha1("|".join(p.strip().upper() for p in parts if p).encode()).hexdigest()[:12]


def policy_hash(payload: dict) -> str:
    return hashlib.sha256(json.dumps(payload, sort_keys=True, default=str).encode()).hexdigest()[:12]
