"""The ACO join.

Every case here is a real name pair pulled from the live CMS files on 2026-07-28, not a
synthetic fixture. The false positives were found by running the pipeline; they are
regression tests for defects that actually shipped in the first draft.
"""

from __future__ import annotations

import pytest
from rapidfuzz import fuzz

from atlas.sources.aco import is_identifying, normalize, soft_normalize


def score(a: str, b: str) -> float:
    return fuzz.token_sort_ratio(soft_normalize(a), soft_normalize(b)) / 100.0


def test_soft_normalize_keeps_industry_words():
    assert soft_normalize("ABINGDON HEALTH CARE LLC") == "abingdon health care"


def test_core_normalize_strips_to_the_identifying_core():
    assert normalize("ABINGDON HEALTH CARE LLC") == "abingdon"


def test_legal_forms_are_equivalent():
    assert soft_normalize("HOMELIFE SENIOR LIVING, LLC") == soft_normalize("Homelife Senior Living Inc")


@pytest.mark.parametrize(
    "facility,affiliate",
    [
        # Verified: CMS provider legal_business_name appears verbatim as an Aff_LBN.
        ("BRISTOL BAY HOLDINGS LLC", "BRISTOL BAY HOLDINGS LLC"),
        ("HEARTWOOD AVENUE LLC", "HEARTWOOD AVENUE LLC"),
        ("1527 SPRINGS ROAD LLC", "1527 SPRINGS ROAD LLC"),
    ],
)
def test_true_positives_score_at_ceiling(facility, affiliate):
    assert score(facility, affiliate) == 1.0


@pytest.mark.parametrize(
    "facility,affiliate,why",
    [
        (
            "SUNSHINE MANOR",
            "SUNSHINE HEALTH FACILITIES, INC",
            "the original normalizer stripped both to the single token 'sunshine' and scored 1.000",
        ),
        (
            "OAKVIEW",
            "ALLIED SERVICES INSTITUTE OF REHABILITATION MEDICINE",
            "partial_ratio on a 7-character key scored 0.923",
        ),
        (
            "OAKVIEW",
            "FAIRVIEW HEALTH SERVICES",
            "shared 'view' suffix",
        ),
    ],
)
def test_known_false_positives_now_score_low(facility, affiliate, why):
    assert score(facility, affiliate) < 0.70, why


def test_soleta_violet_is_the_case_the_reviewer_rejected():
    """Distinct companies inflated by the shared generic token 'holdings'.

    It scores 0.867 -- high enough to pass a 0.86 threshold, which is exactly why the
    reviewer had to catch it and why the induced lesson moves the threshold to 0.872.
    """
    s = score("SOLETA HOLDINGS, INC.", "VIOLET HOLDINGS, LLC")
    assert 0.85 < s < 0.88
    assert s < 0.872, "the promoted threshold must exclude this pair"


def test_building_name_alone_misses_an_address_named_entity():
    """Why the legal-entity key exists at all.

    'Springs Road Healthcare' vs its own certified entity '1527 SPRINGS ROAD LLC' scores
    only 0.65 -- unreachable at any usable threshold. The match is only findable because
    we join on legal_business_name, not the building's trading name.
    """
    assert score("Springs Road Healthcare", "1527 SPRINGS ROAD LLC") < 0.70


def test_is_identifying_rejects_bare_initialisms():
    assert not is_identifying(soft_normalize("ALGD, LLC"), 2, 11)
    assert is_identifying(soft_normalize("THE VINEYARDS HEALTHCARE CENTER"), 2, 11)
