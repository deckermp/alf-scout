"""S4 + S5 -- Medicare Shared Savings Program ACOs and their SNF affiliates.

This is the only public dataset that links a named ACO to a named facility, and it is the
reason the ACO column is real rather than invented.

Its shape is also the sharpest problem in the build. The affiliate file keys on
`Aff_LBN` -- a legal business name -- not on a CCN. So joining it to a facility is *name
matching*, and name matching is exactly the kind of judgement that looks fine at a
threshold picked by taste and quietly produces false positives. That is why this join is
the node the meta-learning loop is pointed at.

The whole affiliate file is ~3.2k rows, so we pull it once and index in memory rather
than issuing a query per facility.
"""

from __future__ import annotations

import re
from functools import lru_cache
from typing import Any

from rapidfuzz import fuzz

from .cache import get_json

AFFILIATES = "https://data.cms.gov/data-api/v1/dataset/5b227bd9-82d4-4145-86fd-809e02ca7f18/data"
ACO_MASTER = "https://data.cms.gov/data-api/v1/dataset/69ec2609-5ce5-4ce1-b14c-1f8809fda2c2/data"

# Legal-form suffixes only. These genuinely carry no signal: 'Foo LLC' and 'Foo, Inc.'
# are the same market entity for our purposes.
_LEGAL = re.compile(r"\b(inc|llc|l\.l\.c|lp|llp|plc|corp|corporation|co|company|the|dba)\b", re.I)

# Industry words. These DO carry signal -- 'Vineyards Healthcare Center' and 'Vineyards
# Senior Living' are plausibly different buildings -- so they are stripped only to build a
# cheap blocking key, never to score a match. Stripping them before scoring is what made
# 'SUNSHINE MANOR' collide with 'SUNSHINE HEALTH FACILITIES, INC'.
_INDUSTRY = re.compile(
    r"\b(health|healthcare|health\s*care|care|center|centre|ctr|facility|facilities"
    r"|nursing|rehabilitation|rehab|convalescent|skilled|snf|hospital|post|acute"
    r"|senior|seniors|living|community|communities|home|homes|house|manor|villa|village"
    r"|of|a|an|and|at)\b",
    re.I,
)
_PUNCT = re.compile(r"[^a-z0-9\s]")
_WS = re.compile(r"\s+")


def soft_normalize(name: str) -> str:
    """Legal form removed, everything else kept. This is what we SCORE on.

    'ABINGDON HEALTH CARE LLC' -> 'abingdon health care'
    """
    s = _PUNCT.sub(" ", (name or "").lower())
    s = _LEGAL.sub(" ", s)
    return _WS.sub(" ", s).strip()


def normalize(name: str) -> str:
    """Aggressive: down to the identifying core. Used as a blocking key, an alias key and
    a blocklist key -- never as the thing a score is computed on.

    'ABINGDON HEALTH CARE LLC' -> 'abingdon'
    """
    s = soft_normalize(name)
    s = _INDUSTRY.sub(" ", s)
    return _WS.sub(" ", s).strip()


@lru_cache(maxsize=1)
def _affiliates() -> list[dict[str, Any]]:
    try:
        rows = get_json(AFFILIATES, {"size": "10000"}, ttl=60 * 60 * 24 * 30)
        return rows if isinstance(rows, list) else []
    except Exception:  # noqa: BLE001
        return []


@lru_cache(maxsize=1)
def _acos() -> list[dict[str, Any]]:
    try:
        rows = get_json(ACO_MASTER, {"size": "10000"}, ttl=60 * 60 * 24 * 30)
        return rows if isinstance(rows, list) else []
    except Exception:  # noqa: BLE001
        return []


def affiliates_for_state(state: str) -> list[dict[str, Any]]:
    """Affiliate rows whose ACO serves this state. Narrowing before matching cuts the
    false-positive surface far more than tightening the threshold does."""
    st = (state or "").upper()
    return [r for r in _affiliates() if st in (r.get("ACO_Service_Area") or "").upper()]


def acos_serving_state(state: str) -> list[dict[str, Any]]:
    st = (state or "").upper()
    return [r for r in _acos() if st in (r.get("aco_service_area") or "").upper()]


def is_identifying(key: str, min_tokens: int, min_chars: int) -> bool:
    """Is this name specific enough to match on at all?

    A residual guard on the *soft* name. It catches initialisms like 'ALGD LLC' -> 'algd',
    which would otherwise match anything short. Both bounds are policy parameters so the
    loop can tune them rather than the code hardcoding a taste.
    """
    toks = key.split()
    return bool(toks) and (len(toks) >= min_tokens or len(key.replace(" ", "")) >= min_chars)


def match(
    facility_names: list[str],
    state: str,
    threshold: float,
    aliases: dict[str, str] | None = None,
    management_names: list[str] | None = None,
    legal_names: list[str] | None = None,
    min_key_tokens: int = 2,
    min_key_chars: int = 11,
) -> list[dict[str, Any]]:
    """Match a facility to ACO affiliate rows.

    Three kinds of name are kept apart on purpose, because they are three different
    strengths of claim:

    * `legal_names` -- the licensed/certified legal entity. CMS builds the affiliate file
      out of exactly this field, so an exact match here is not fuzzy matching at all; it
      is two CMS files agreeing on a string CMS itself assigned. Highest precision.
    * `facility_names` -- the building's trading name. A real signal, genuinely fuzzy.
    * `management_names` -- the operator. A weaker and *different* claim: the operator is
      in the affiliate file, which may or may not include this site. Penalised, never
      allowed to outrank a legal-entity match.

    Collapsing the three is how a join like this quietly over-reports, so the basis travels
    with every match and lands in the UI next to the score.

    `aliases` is supplied by the compiled policy -- it is where learned name equivalences
    land. An alias hit scores 1.0 and is labelled as such, so a reviewer can see that a
    match came from a previous reviewer rather than from the matcher.
    """
    aliases = aliases or {}
    cands = affiliates_for_state(state)
    if not cands:
        return []

    def keys_for(names: list[str]) -> list[str]:
        seen, out = set(), []
        for n in names or []:
            k = soft_normalize(n)
            if k and k not in seen and is_identifying(k, min_key_tokens, min_key_chars):
                seen.add(k)
                out.append(k)
        return out

    fac_keys = keys_for(facility_names)
    mgmt_keys = keys_for(management_names or [])
    legal_keys = keys_for(legal_names or [])
    core_norm = {normalize(n) for n in (facility_names or []) if n}
    aliased = {normalize(v) for k, v in aliases.items() if k in core_norm}

    out: dict[str, dict[str, Any]] = {}
    for row in cands:
        lbn = row.get("Aff_LBN") or ""
        soft_lbn, core_lbn = soft_normalize(lbn), normalize(lbn)
        if not soft_lbn or not is_identifying(soft_lbn, min_key_tokens, min_key_chars):
            continue
        best, how, basis, exact_legal = 0.0, "", "", False
        if core_lbn and core_lbn in aliased:
            best, how, basis = 1.0, "alias", "facility_name"
        else:
            for k in legal_keys:
                s = fuzz.token_sort_ratio(k, soft_lbn) / 100.0
                if s > best:
                    best, how, basis = s, "fuzzy", "legal_business_name"
                    exact_legal = k == soft_lbn
            for k in fac_keys:
                s = fuzz.token_sort_ratio(k, soft_lbn) / 100.0
                if s > best:
                    best, how, basis = s, "fuzzy", "facility_name"
            for k in mgmt_keys:
                # A management-name hit is real evidence but a weaker claim; it must clear
                # a higher bar than the facility's own name.
                s = (fuzz.token_sort_ratio(k, soft_lbn) / 100.0) * 0.95
                if s > best:
                    best, how, basis = s, "fuzzy", "management_name"
        if best >= threshold:
            aid = row.get("ACO_ID", "")
            prev = out.get(aid)
            if prev is None or best > prev["match_score"]:
                out[aid] = {
                    "aco_id": aid,
                    "aco_name": row.get("ACO_Name", ""),
                    "service_area": row.get("ACO_Service_Area", ""),
                    "match_score": round(best, 3),
                    "matched_on": lbn,
                    "matched_how": "exact-legal-entity" if exact_legal else how,
                    "match_basis": basis,
                    # Two CMS files agreeing on a CMS-assigned string is not an inference.
                    "exact_legal_entity": exact_legal,
                    "snf_3day_waiver": str(row.get("SNF_3-Day_Rule_Waiver", "0")) == "1",
                    "public_reporting_url": row.get("ACO_Public_Reporting_Website") or None,
                }
    return sorted(out.values(), key=lambda r: -r["match_score"])
