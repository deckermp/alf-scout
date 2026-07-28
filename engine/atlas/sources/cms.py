"""S2 + S3 -- CMS Nursing Home Provider Information and Ownership.

National, keyless, and the only source in the build that covers every state. It covers
*certified* facilities only, which is the honest boundary: a Medicare-certified SNF is
not an assisted living facility, and where a campus has both we say so rather than
merging them.

S3 is where "list the management" actually gets answered. CMS distinguishes ownership
interest from `OPERATIONAL/MANAGERIAL CONTROL`; those are different questions and the
operator is usually the interesting one.
"""

from __future__ import annotations

from typing import Any

from .cache import get_json

PROVIDER_INFO = "https://data.cms.gov/provider-data/api/1/datastore/query/4pq5-n9py/0"
OWNERSHIP = "https://data.cms.gov/provider-data/api/1/datastore/query/y2hd-n93e/0"

MANAGERIAL_ROLES = ("OPERATIONAL/MANAGERIAL CONTROL", "MANAGING EMPLOYEE")


def _eq(prop: str, value: str, i: int = 0) -> dict[str, str]:
    return {
        f"conditions[{i}][property]": prop,
        f"conditions[{i}][value]": value,
        f"conditions[{i}][operator]": "=",
    }


def providers_in_zip(zipcode: str) -> list[dict[str, Any]]:
    """CMS-certified nursing homes in one ZIP."""
    params = {**_eq("zip_code", zipcode.strip()[:5]), "limit": "200"}
    try:
        return get_json(PROVIDER_INFO, params).get("results", [])
    except Exception:  # noqa: BLE001
        return []


def providers_in_zips(zips: list[str]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for z in zips:
        for r in providers_in_zip(z):
            ccn = r.get("cms_certification_number_ccn")
            if ccn and ccn not in seen:
                seen.add(ccn)
                out.append(r)
    return out


def ownership(ccn: str) -> list[dict[str, Any]]:
    params = {**_eq("cms_certification_number_ccn", ccn), "limit": "300"}
    try:
        return get_json(OWNERSHIP, params).get("results", [])
    except Exception:  # noqa: BLE001
        return []


def managers(ccn: str) -> list[dict[str, str]]:
    """Organizations and people with managerial control, plus >=5% organizational owners.

    Individuals holding managerial control are named in the CMS file, but a market-research
    table wants the operating company. We return organizations first and keep individuals
    behind them rather than dropping them -- CMS published both.
    """
    rows = ownership(ccn)
    orgs, people, owners = [], [], []
    for r in rows:
        role = (r.get("role_played_by_owner_or_manager_in_facility") or "").upper()
        name = (r.get("owner_name") or "").strip()
        if not name:
            continue
        entry = {
            "name": name,
            "role": r.get("role_played_by_owner_or_manager_in_facility", ""),
            "type": r.get("owner_type", ""),
            "pct": r.get("ownership_percentage", ""),
            "since": r.get("association_date", ""),
        }
        is_org = (r.get("owner_type") or "").upper() == "ORGANIZATION"
        if any(m in role for m in MANAGERIAL_ROLES):
            (orgs if is_org else people).append(entry)
        elif is_org and "OWNERSHIP INTEREST" in role:
            owners.append(entry)

    def dedupe(xs: list[dict]) -> list[dict]:
        seen, out = set(), []
        for x in xs:
            if x["name"].upper() not in seen:
                seen.add(x["name"].upper())
                out.append(x)
        return out

    return dedupe(orgs) + dedupe(owners) + dedupe(people)


def parse_int(v: Any) -> int | None:
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None
