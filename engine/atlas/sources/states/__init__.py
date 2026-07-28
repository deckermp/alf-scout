"""State ALF connector registry.

There is no federal assisted-living licensure -- states define, license and survey
(R4 s7a). So there is no national ALF table to query, and a tool that claims one is
either scraping a paid-referral directory or making it up.

The design answer is this registry. A state either has a connector that reads its real
licensing file, or it returns a `CoverageGap` naming what would close it. Adding a state
is adding one module and one line here.
"""

from __future__ import annotations

from typing import Callable, Protocol

from ...schema import CoverageGap


class StateConnector(Protocol):
    STATE: str
    SOURCE_ID: str
    SOURCE_NAME: str

    def facilities_in_zips(self, zips: list[str]) -> list[dict]: ...


_REGISTRY: dict[str, Callable[[], StateConnector]] = {}


def register(state: str, factory: Callable[[], StateConnector]) -> None:
    _REGISTRY[state.upper()] = factory


def connector_for(state: str) -> StateConnector | None:
    f = _REGISTRY.get((state or "").upper())
    return f() if f else None


def supported() -> list[str]:
    return sorted(_REGISTRY)


def gap_for(state: str) -> CoverageGap:
    return CoverageGap(
        state=state.upper(),
        reason=(
            f"No assisted-living licensing connector is implemented for {state.upper()}. "
            "There is no federal ALF licensure, so ALF coverage is state-by-state by construction; "
            "this is a coverage boundary, not a query that returned nothing."
        ),
        what_would_close_it=(
            f"A connector reading {state.upper()}'s licensing registry export. "
            "See atlas/sources/states/ca.py -- one module, ~80 lines, registered in this package."
        ),
        partial_sources=["S2 CMS Nursing Home Provider Information (certified SNFs, national)"],
    )


def _bootstrap() -> None:
    from . import ca  # noqa: F401  -- registers on import


_bootstrap()
