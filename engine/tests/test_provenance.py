"""The provenance contract. If these break, the table is allowed to lie."""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from atlas.schema import Cell, Confidence, Facility, stable_id


def test_cell_requires_a_source():
    with pytest.raises(ValidationError):
        Cell(value=42, confidence=Confidence.REGISTRY, source="")


def test_unknown_requires_a_reason():
    with pytest.raises(ValueError, match="requires a reason"):
        Cell.unknown("S1", "")


def test_unknown_is_not_known_and_carries_its_reason():
    c = Cell.unknown("S4", "no affiliate matched")
    assert not c.known
    assert c.value is None
    assert c.note == "no affiliate matched"


def test_cells_are_immutable():
    c = Cell(value=1, confidence=Confidence.REGISTRY, source="S1")
    with pytest.raises(ValidationError):
        c.value = 2


def test_correction_records_what_it_replaced():
    original = Cell(value=100, confidence=Confidence.INFERRED, source="agent")
    fixed = original.corrected(120, "called the facility")
    assert fixed.value == 120
    assert fixed.corrected_from == 100
    assert fixed.human_verified
    assert fixed.source == "human"


def test_confidence_ranks_are_ordered():
    assert Confidence.REGISTRY.rank > Confidence.DERIVED.rank > Confidence.INFERRED.rank > Confidence.UNKNOWN.rank


def test_stable_id_is_stable_and_case_insensitive():
    a = stable_id("Sunrise Villa", "1 Main St", "94550")
    b = stable_id("SUNRISE VILLA", "1 MAIN ST", "94550")
    assert a == b and len(a) == 12


def _facility(**over) -> Facility:
    base = dict(
        id="x",
        name="Test",
        distance_mi=Cell(value=1.0, confidence=Confidence.DERIVED, source="S6"),
        beds=Cell(value=50, confidence=Confidence.REGISTRY, source="S1"),
        bed_basis=Cell(value="State-licensed capacity", confidence=Confidence.REGISTRY, source="S1"),
        avg_monthly_fee=Cell.unknown("none", "no registry publishes this"),
        management=Cell(value=[{"name": "Acme"}], confidence=Confidence.REGISTRY, source="S3"),
        services=Cell(value=["AL"], confidence=Confidence.REGISTRY, source="S1"),
        acos=Cell.unknown("S4", "no match"),
    )
    return Facility(**{**base, **over})


def test_coverage_counts_only_established_cells():
    f = _facility()
    assert f.coverage == pytest.approx(4 / 6)


def test_every_output_column_is_a_cell():
    f = _facility()
    for name, cell in f.cells().items():
        assert isinstance(cell, Cell), name
        assert cell.source, f"{name} has no provenance"
