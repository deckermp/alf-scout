"""The DAG nodes.

Each node does one thing, records what it did in `trace`, and reads its parameters from
the compiled `policy` rather than from constants. That last part is what makes the
pipeline evolvable: a lesson changes a policy field, and the node behaves differently on
the next run without anyone editing this file.

Nodes never invent a value. Where a fact cannot be established the cell is
`Cell.unknown(source, reason)` -- and the reason is written for a human who will read it
in the table, not for a log.
"""

from __future__ import annotations

import time
from typing import Any

from rapidfuzz import fuzz

from ..meta import store
from ..schema import Cell, Confidence, Facility, ServiceType, stable_id
from ..sources import aco as aco_src
from ..sources import cms, geo
from ..sources import states as state_registry
from .state import AtlasState


def _trace(state: AtlasState, node: str, /, **fields: Any) -> list[dict]:
    # Positional-only: trace fields are arbitrary, and a field named `state` or `node`
    # would otherwise collide with the parameters.
    entry = {"node": node, "at": time.time(), **fields}
    return [*state.get("trace", []), entry]


# --------------------------------------------------------------- 1. resolve_zip

def resolve_zip(state: AtlasState) -> dict:
    z = state["zip"].strip()[:5]
    origin = geo.zip_centroid(z)
    radius = float(state.get("radius_mi", 15.0))
    nearby = geo.zips_within(z, radius) if origin else [z]

    # Which state are we in? Take it from whichever CMS provider or state file answers
    # first; ZCTAs do not carry a state code in the gazetteer.
    state_code = ""
    for row in cms.providers_in_zip(z):
        state_code = (row.get("state") or "").upper()
        break
    if not state_code:
        for sc in state_registry.supported():
            conn = state_registry.connector_for(sc)
            if conn and conn.facilities_in_zips([z]):
                state_code = sc
                break

    return {
        "origin": origin,
        "nearby_zips": nearby,
        "state_code": state_code,
        "radius_mi": radius,
        "trace": _trace(
            state,
            "resolve_zip",
            zip=z,
            origin=origin,
            nearby_zip_count=len(nearby),
            state=state_code or "unresolved",
            source="S7 Census ZCTA gazetteer",
        ),
    }


# ------------------------------------------------------------------ 2. discover

def discover(state: AtlasState) -> dict:
    """Pull every candidate facility from the real registries. No filtering yet."""
    zips = state.get("nearby_zips") or [state["zip"][:5]]
    sc = state.get("state_code", "")
    raw: list[dict] = []
    gaps: list[dict] = []

    connector = state_registry.connector_for(sc) if sc else None
    if connector:
        alf = connector.facilities_in_zips(zips)
        raw.extend(alf)
        alf_n, alf_src = len(alf), connector.SOURCE_NAME
    else:
        alf_n, alf_src = 0, "none"
        if sc:
            gaps.append(state_registry.gap_for(sc).model_dump())

    for p in cms.providers_in_zips(zips):
        raw.append(
            {
                "source_id": "S2",
                "cms_ccn": p.get("cms_certification_number_ccn"),
                "name": (p.get("provider_name") or "").strip(),
                "legal_business_name": (p.get("legal_business_name") or "").strip(),
                "address": (p.get("provider_address") or "").strip(),
                "city": (p.get("citytown") or "").strip(),
                "state": (p.get("state") or "").strip(),
                "zip": (p.get("zip_code") or "").strip()[:5],
                "certified_beds": cms.parse_int(p.get("number_of_certified_beds")),
                "avg_residents_per_day": p.get("average_number_of_residents_per_day"),
                "ownership_type": p.get("ownership_type"),
                "chain_name": (p.get("chain_name") or "").strip(),
                "overall_rating": p.get("overall_rating"),
                "facility_type": "SKILLED NURSING FACILITY",
            }
        )

    return {
        "raw": raw,
        "gaps": gaps,
        "trace": _trace(
            state,
            "discover",
            alf_rows=alf_n,
            alf_source=alf_src,
            cms_rows=sum(1 for r in raw if r["source_id"] == "S2"),
            total=len(raw),
            zips_searched=len(zips),
        ),
    }


# ---------------------------------------------------------- 3. enrich_registry

def _services_from_rules(row: dict, policy) -> tuple[list[str], list[str]]:
    hits, bases = [], []
    for rule in policy.service_rules:
        w = rule.get("when", {})
        field, op, val = w.get("field"), w.get("op"), str(w.get("value", ""))
        actual = str(row.get(field, "") or "").upper()
        ok = (val.upper() in actual) if op == "contains" else (actual == val.upper())
        if ok:
            for s in rule.get("add", []):
                if s not in hits:
                    hits.append(s)
            bases.append(f"{rule.get('id')}: {rule.get('basis','')}")
    return hits, bases


def _link_cms(row: dict, cms_rows: list[dict]) -> dict | None:
    """Find a CMS-certified provider co-located with a state-licensed ALF.

    Many CA campuses hold an RCFE licence and a separate SNF certification at the same
    address. Linking them lets the ALF row inherit CMS's real ownership data -- but it is
    a *link*, not an identity, so everything it yields is labelled as coming via the
    co-located provider.
    """
    addr = (row.get("address") or "").upper()
    name = row.get("name") or ""
    best, score = None, 0.0
    for c in cms_rows:
        if c.get("zip") != row.get("zip"):
            continue
        s = 0.0
        if addr and c.get("address", "").upper() == addr:
            s = 0.97
        else:
            s = fuzz.token_sort_ratio(aco_src.normalize(name), aco_src.normalize(c.get("name", ""))) / 100.0
        if s > score:
            best, score = c, s
    return best if score >= 0.90 else None


def enrich_registry(state: AtlasState) -> dict:
    policy = state["policy"]
    origin = state.get("origin")
    raw = state.get("raw", [])
    cms_rows = [r for r in raw if r["source_id"] == "S2"]
    out: list[dict] = []
    geocoded = centroid_fallback = linked = 0

    for row in raw:
        src = row["source_id"]
        name = row.get("name", "")
        fid = stable_id(name, row.get("address", ""), row.get("zip", ""))

        # --- distance (S6/S7) -------------------------------------------------
        coords = geo.geocode(row.get("address", ""), row.get("city", ""), row.get("state", ""), row.get("zip", ""))
        exact = coords is not None
        if coords is None:
            coords = geo.zip_centroid(row.get("zip", "") or "")
            if coords:
                centroid_fallback += 1
        else:
            geocoded += 1
        same_zip = (row.get("zip", "") or "")[:5] == state["zip"].strip()[:5]
        if origin and coords and exact:
            distance = Cell(
                value=round(geo.haversine_mi(origin, coords), 2),
                confidence=Confidence.DERIVED,
                source="S6",
                note="street address geocoded to the origin ZIP's centroid",
            )
        elif origin and coords and not same_zip:
            # Centroid-to-centroid is a real but coarser measurement. Say which one it is.
            distance = Cell(
                value=round(geo.haversine_mi(origin, coords), 2),
                confidence=Confidence.INFERRED,
                source="S7",
                note="address did not geocode; this is ZIP-centroid to ZIP-centroid, not door to door",
            )
        elif coords:
            # Same ZIP as the origin and no street geocode: the centroid distance is 0.00,
            # which reads as "next door" and is not what we know. We know it is in the ZIP.
            distance = Cell.unknown(
                "S6",
                "address did not geocode; the facility is inside the origin ZIP but its distance "
                "is not established. Reported as unknown rather than the 0.00 the centroid would imply.",
            )
        else:
            distance = Cell.unknown("S6", "neither the facility nor the origin ZIP could be located")

        # --- beds -------------------------------------------------------------
        if src == "S2":
            n = row.get("certified_beds")
            beds = (
                Cell(value=n, confidence=Confidence.REGISTRY, source="S2")
                if n is not None
                else Cell.unknown("S2", "CMS reported no certified bed count for this provider")
            )
            basis = Cell(value="Medicare-certified beds", confidence=Confidence.REGISTRY, source="S2")
        else:
            n = row.get("capacity")
            beds = (
                Cell(value=n, confidence=Confidence.REGISTRY, source="S1")
                if n is not None
                else Cell.unknown("S1", "state licence file carried no capacity for this facility")
            )
            basis = Cell(
                value="State-licensed capacity",
                confidence=Confidence.REGISTRY,
                source="S1",
                note="licensed capacity is not the same measure as Medicare-certified beds; do not compare across rows without reading this column",
            )

        # --- CMS link for state-licensed rows ---------------------------------
        ccn = row.get("cms_ccn")
        link_note = None
        if src != "S2":
            hit = _link_cms(row, cms_rows)
            if hit:
                ccn = hit.get("cms_ccn")
                linked += 1
                link_note = f"via co-located CMS provider {hit.get('name')} (CCN {ccn})"

        # --- management (S3, S2 chain, S1 licensee) ---------------------------
        mgmt_entries: list[dict] = []
        mgmt_source, mgmt_conf, mgmt_note = "", Confidence.UNKNOWN, None
        if ccn:
            mgrs = cms.managers(ccn)
            if mgrs:
                mgmt_entries = mgrs[:6]
                mgmt_source, mgmt_conf = "S3", Confidence.REGISTRY
                mgmt_note = link_note
        if not mgmt_entries and row.get("chain_name"):
            mgmt_entries = [{"name": row["chain_name"], "role": "CHAIN", "type": "Organization", "pct": "", "since": ""}]
            mgmt_source, mgmt_conf = "S2", Confidence.REGISTRY
        if not mgmt_entries and row.get("licensee"):
            mgmt_entries = [{"name": row["licensee"], "role": "LICENSEE", "type": "", "pct": "", "since": ""}]
            mgmt_source, mgmt_conf = "S1", Confidence.REGISTRY
            mgmt_note = "licensee of record; the licensee is not necessarily the operating manager"
        management = (
            Cell(value=mgmt_entries, confidence=mgmt_conf, source=mgmt_source, note=mgmt_note)
            if mgmt_entries
            else Cell.unknown("S3", "no CMS ownership record and no licensee name for this facility")
        )

        # --- services ---------------------------------------------------------
        svc, bases = _services_from_rules({**row, "source_id": src}, policy)
        missing = [s.value for s in (ServiceType.IL, ServiceType.MC, ServiceType.HH) if s.value not in svc]
        services = (
            Cell(
                value=svc,
                confidence=Confidence.REGISTRY if src != "S2" and "CONTINUING" not in row.get("facility_type", "") else Confidence.DERIVED,
                source="S1" if src != "S2" else "S2",
                note=(
                    "licensure category only. "
                    + (f"{', '.join(missing)} are not licensure categories in this state and cannot be read from the registry." if missing else "")
                    + (" Basis: " + "; ".join(bases) if bases else "")
                ).strip(),
            )
            if svc
            else Cell.unknown("S1", "no licensure category matched a service rule")
        )

        # --- fees -------------------------------------------------------------
        fee = Cell.unknown(
            "none",
            "No public registry publishes per-facility pricing. National median AL is ~$5,900/mo "
            "(Genworth-derived, cited in R4) but that is a market statistic, not this facility's rate.",
        )

        rating = None
        if row.get("overall_rating"):
            rating = Cell(
                value=cms.parse_int(row["overall_rating"]),
                confidence=Confidence.REGISTRY,
                source="S2",
                note="CMS Five-Star overall rating, as published by CMS",
            )

        f = Facility(
            id=fid,
            name=name,
            address=row.get("address", ""),
            city=row.get("city", ""),
            state=row.get("state", ""),
            zip=row.get("zip", ""),
            lat=coords[0] if coords else None,
            lon=coords[1] if coords else None,
            distance_mi=distance,
            beds=beds,
            bed_basis=basis,
            avg_monthly_fee=fee,
            management=management,
            services=services,
            acos=Cell.unknown("S4", "ACO join has not run yet"),
            facility_kind=row.get("facility_type", ""),
            cms_ccn=ccn,
            license_id=row.get("license_id"),
            # S2 publishes the certified legal entity; in CA the licensee is the same kind
            # of object for a state-licensed facility.
            legal_business_name=(row.get("legal_business_name") or row.get("licensee") or "").strip(),
            cms_overall_rating=rating,
            source_ids=[src] + (["S3"] if mgmt_source == "S3" else []),
        )
        out.append(f.model_dump())

    if policy.min_capacity > 0:
        before = len(out)
        out = [f for f in out if (f["beds"]["value"] or 0) >= policy.min_capacity]
        dropped = before - len(out)
    else:
        dropped = 0

    return {
        "facilities": out,
        "trace": _trace(
            state,
            "enrich_registry",
            facilities=len(out),
            geocoded_exact=geocoded,
            centroid_fallback=centroid_fallback,
            cms_linked=linked,
            dropped_by_min_capacity=dropped,
            policy_version=policy.version,
        ),
    }


# ---------------------------------------------------------------- 4. join_aco

def join_aco(state: AtlasState) -> dict:
    policy = state["policy"]
    sc = state.get("state_code", "")
    facilities = state.get("facilities", [])
    matched = exact_hits = 0
    blocked = set(policy.aco_blocklist)

    for f in facilities:
        names = [f["name"]]
        legal_names = [f.get("legal_business_name") or ""]
        mgmt = f["management"].get("value")
        mgmt_names = (
            [m.get("name", "") for m in mgmt if isinstance(m, dict) and (m.get("type") or "").upper() == "ORGANIZATION"]
            if isinstance(mgmt, list)
            else []
        )
        links = aco_src.match(
            names,
            sc,
            policy.aco_match_threshold,
            policy.aco_aliases,
            management_names=mgmt_names,
            legal_names=legal_names,
            min_key_tokens=policy.aco_min_key_tokens,
            min_key_chars=policy.aco_min_key_chars,
        )
        links = [x for x in links if aco_src.normalize(x["matched_on"]) not in blocked]
        if links:
            matched += 1
            exact = [x for x in links if x.get("exact_legal_entity")]
            if exact:
                exact_hits += 1
            f["acos"] = Cell(
                # An exact agreement between two CMS files on a CMS-assigned legal entity
                # name is a deterministic join, not a guess. Everything else is a proposal.
                value=[{**x, "status": "proposed"} for x in links],
                confidence=Confidence.DERIVED if exact else Confidence.INFERRED,
                source="S4",
                note=(
                    (
                        "Exact match on the certified legal business name -- the field CMS itself keys the "
                        "affiliate file on. Still shown as proposed: one legal entity can operate several sites."
                        if exact
                        else f"Name-based join at threshold {policy.aco_match_threshold:.2f}. CMS keys the "
                        "affiliate file on legal business name, not CCN, so these are proposals for review, "
                        "not confirmed affiliations."
                    )
                ),
            ).model_dump()
        else:
            f["acos"] = Cell.unknown(
                "S4",
                f"No MSSP ACO affiliate in {sc or 'this state'} matched this facility's names at threshold "
                f"{policy.aco_match_threshold:.2f}. Absence of a match is not evidence of no affiliation.",
            ).model_dump()

    return {
        "facilities": facilities,
        "trace": _trace(
            state,
            "join_aco",
            facilities_with_proposals=matched,
            exact_legal_entity_matches=exact_hits,
            threshold=policy.aco_match_threshold,
            aliases=len(policy.aco_aliases),
            blocklisted=len(blocked),
            affiliate_pool=len(aco_src.affiliates_for_state(sc)),
        ),
    }


# ------------------------------------------------------- 6. apply overrides

def apply_overrides(state: AtlasState) -> dict:
    """Re-attach everything a human already established, before the table is shown.

    A pipeline that discards last week's corrections on every run does not learn; it
    forgets in public.

    Deliberately skippable. The eval harness runs with overrides OFF, because a gate that
    sees human patches is measuring the human, not the pipeline -- and would score every
    candidate policy identically on exactly the cases a human already fixed.
    """
    if not state.get("use_overrides", True):
        return {"trace": _trace(state, "apply_overrides", skipped=True, reason="overrides disabled (eval/shadow run)")}

    facilities = state.get("facilities", [])
    ov = store.overrides_for([f["id"] for f in facilities])
    applied = 0
    for f in facilities:
        for field in ("beds", "avg_monthly_fee", "management", "services", "acos", "distance_mi"):
            hit = ov.get((f["id"], field))
            if not hit:
                continue
            prior = f[field]
            f[field] = Cell(
                value=hit["value"],
                confidence=Confidence.REGISTRY,
                source="human",
                note=hit["note"] or "value established by a reviewer on a previous run",
                human_verified=True,
                corrected_from=prior.get("value"),
            ).model_dump()
            applied += 1
    return {"facilities": facilities, "trace": _trace(state, "apply_overrides", cells_restored=applied)}


# ----------------------------------------------------------------- 7. finalize

def finalize(state: AtlasState) -> dict:
    facilities = sorted(
        state.get("facilities", []),
        key=lambda f: (f["distance_mi"]["value"] is None, f["distance_mi"]["value"] or 1e9),
    )
    known = sum(1 for f in facilities for c in ("beds", "management", "services", "acos", "avg_monthly_fee") if f[c]["value"] is not None)
    total = max(1, len(facilities) * 5)
    return {
        "facilities": facilities,
        "trace": _trace(state, "finalize", rows=len(facilities), cell_coverage=round(known / total, 3)),
    }
