"""R1: corrections to RETRIEVED fields become source_pref lessons.

The guard these tests exist for: a lesson that compiles to the same policy is worse than
no lesson, because it reports learning that did not happen. Most of the cases below are
refusals.
"""

from __future__ import annotations

import json

import pytest

from atlas.meta import induce
from atlas.meta.induce import _induce_source_pref
from atlas.meta.policy import baseline


@pytest.fixture(autouse=True)
def _stub_run_lookup(monkeypatch):
    """Every fixture facility's `beds` came from S1 and `management` from S3."""
    sources = {("f1", "beds"): "S1", ("f2", "beds"): "S1", ("f3", "beds"): "S2",
               ("f1", "management"): "S3", ("f2", "management"): "S3"}
    monkeypatch.setattr(
        induce, "_source_of", lambda run_id, fid, field: sources.get((fid, field))
    )


def V(vid, field, facility_id, action="correct", before=None, after=None):
    return {
        "id": vid, "run_id": "R1", "facility_id": facility_id, "field": field,
        "action": action, "before": json.dumps(before), "after": json.dumps(after),
        "note": "", "reviewer": "test",
    }


def test_two_corrections_blaming_one_source_demote_it():
    rows = [V(1, "beds", "f1", before=60, after=72), V(2, "beds", "f2", before=40, after=55)]
    created, consumed = _induce_source_pref(rows, baseline())
    assert len(created) == 1
    assert consumed == [1, 2]


def test_the_demoted_source_goes_last_and_the_others_keep_their_order():
    pol = baseline()
    assert pol.source_pref["beds"] == ["S1", "S2"]  # guards the fixture's premise
    rows = [V(1, "beds", "f1"), V(2, "beds", "f2")]
    lessons: list[dict] = []
    from atlas.meta import store

    orig = store.add_lesson
    try:
        store.add_lesson = lambda **kw: (lessons.append(kw), "L_test")[1]  # type: ignore[assignment]
        _induce_source_pref(rows, pol)
    finally:
        store.add_lesson = orig  # type: ignore[assignment]

    assert lessons[0]["payload"] == {"field": "beds", "order": ["S2", "S1"]}
    assert lessons[0]["node"] == "enrich_registry"
    assert "S1" in lessons[0]["rationale"]


def test_one_correction_is_an_override_not_a_lesson():
    created, consumed = _induce_source_pref([V(1, "beds", "f1")], baseline())
    assert created == [] and consumed == []


def test_avg_monthly_fee_never_induces_a_source_pref():
    """It is modelled, not retrieved. There is no source to demote, so a lesson here would
    be inert while looking like learning."""
    rows = [V(1, "avg_monthly_fee", "f1", before=None, after=5200),
            V(2, "avg_monthly_fee", "f2", before=None, after=6100)]
    created, _ = _induce_source_pref(rows, baseline())
    assert created == []
    assert "avg_monthly_fee" not in induce.RETRIEVED_FIELDS


def test_no_lesson_when_the_source_is_already_last():
    """Demoting S2 in ["S1","S2"] compiles to the identical policy. Refuse it."""
    rows = [V(1, "beds", "f3"), V(2, "beds", "f3")]
    created, consumed = _induce_source_pref(rows, baseline())
    assert created == [] and consumed == []


def test_no_lesson_when_the_field_has_only_one_source():
    pol = baseline().model_copy(update={"source_pref": {"beds": ["S1"]}})
    created, _ = _induce_source_pref([V(1, "beds", "f1"), V(2, "beds", "f2")], pol)
    assert created == []


def test_confirmations_are_not_corrections():
    rows = [V(1, "beds", "f1", action="confirm"), V(2, "beds", "f2", action="confirm")]
    created, _ = _induce_source_pref(rows, baseline())
    assert created == []


def test_acos_is_left_to_the_threshold_path():
    """`acos` is inferred, not retrieved -- it must not be swept into source_pref."""
    rows = [V(1, "acos", "f1"), V(2, "acos", "f2")]
    created, _ = _induce_source_pref(rows, baseline())
    assert created == []
    assert "acos" not in induce.RETRIEVED_FIELDS
