"""S1 -- California CCL, Residential Care Facilities for the Elderly.

The real ALF spine. ~12.5k rows statewide, of which ~7.9k are currently LICENSED.
Published by CDSS Community Care Licensing on the CHHS open data portal.

What it gives us that no national source does: licensed capacity (beds), the licensee,
the administrator, and a facility type that distinguishes a CCRC from a standalone RCFE.

What it does not give us -- and it is important to say it rather than infer it -- is the
service mix. California licenses "Residential Care Facility for the Elderly"; it does not
license "memory care" or "independent living" as separate categories. So IL/AL/MC cannot
be read off this file for a plain RCFE, and the pipeline must not pretend otherwise.

We resolve the CSV through the CKAN package API rather than hardcoding the download URL,
because the portal serves it under a generated filename that rotates.
"""

from __future__ import annotations

import csv
import io
from collections import defaultdict
from functools import lru_cache

from ..cache import get_json, get_text
from . import register

PACKAGE = "https://data.chhs.ca.gov/api/3/action/package_show"
PACKAGE_ID = "46ffcbdf-4874-4cc1-92c2-fb715e3ad014"
RESOURCE_NAME = "residential care facilities for the elderly"

# Fallback if the portal's package API is unreachable; the resource id is stable even
# when the trailing filename is not.
FALLBACK_CSV = (
    "https://data.chhs.ca.gov/dataset/46ffcbdf-4874-4cc1-92c2-fb715e3ad014/"
    "resource/744d1583-f9eb-45b6-b0f8-b9a9dab936a6/download/tmpacjmwy9v.csv"
)


def _resolve_csv_url() -> str:
    try:
        pkg = get_json(PACKAGE, {"id": PACKAGE_ID}, ttl=60 * 60 * 24 * 7)
        for r in pkg["result"]["resources"]:
            if RESOURCE_NAME in (r.get("name") or "").lower() and (r.get("format") or "").upper() == "CSV":
                return r["url"]
    except Exception:  # noqa: BLE001
        pass
    return FALLBACK_CSV


@lru_cache(maxsize=1)
def _by_zip() -> dict[str, list[dict]]:
    text = get_text(_resolve_csv_url(), ttl=60 * 60 * 24 * 7)
    index: dict[str, list[dict]] = defaultdict(list)
    for row in csv.DictReader(io.StringIO(text)):
        if (row.get("facility_status") or "").strip().upper() != "LICENSED":
            continue  # closed and pending facilities are not in the market
        z = (row.get("facility_zip") or "").strip()[:5]
        if z:
            index[z].append(row)
    return dict(index)


class CaliforniaRCFE:
    STATE = "CA"
    SOURCE_ID = "S1"
    SOURCE_NAME = "CA CDSS Community Care Licensing -- Residential Care Facilities for the Elderly"

    def facilities_in_zips(self, zips: list[str]) -> list[dict]:
        idx = _by_zip()
        out: list[dict] = []
        for z in zips:
            for r in idx.get(z.strip()[:5], []):
                cap = r.get("facility_capacity")
                try:
                    cap_i = int(str(cap).strip())
                except (TypeError, ValueError):
                    cap_i = None
                out.append(
                    {
                        "source_id": self.SOURCE_ID,
                        "license_id": (r.get("facility_number") or "").strip(),
                        "name": (r.get("facility_name") or "").strip(),
                        "address": (r.get("facility_address") or "").strip(),
                        "city": (r.get("facility_city") or "").strip(),
                        "state": "CA",
                        "zip": (r.get("facility_zip") or "").strip()[:5],
                        "county": (r.get("county_name") or "").strip(),
                        "phone": (r.get("facility_telephone_number") or "").strip(),
                        "capacity": cap_i,
                        "licensee": (r.get("licensee") or "").strip(),
                        "administrator": (r.get("facility_administrator") or "").strip(),
                        "facility_type": (r.get("facility_type") or "").strip(),
                        "licensed_since": (r.get("license_first_date") or "").strip(),
                    }
                )
        return out


register("CA", CaliforniaRCFE)
