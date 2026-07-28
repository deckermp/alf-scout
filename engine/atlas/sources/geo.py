"""S6 + S7 -- geography.

Distance is the one sort key we can compute exactly and for free, so we do it properly:
ZIP centroid from the Census ZCTA gazetteer as the origin, Census geocoder for each
facility's own coordinates, haversine between them.

Where a facility address will not geocode we fall back to its ZIP centroid and say so in
the cell note -- a centroid-to-centroid distance is a different measurement and the row
should admit it.
"""

from __future__ import annotations

import csv
import io
import json
import math
import zipfile
from pathlib import Path

from .cache import DATA_DIR, get_bytes, get_json

GAZETTEER_URL = "https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2024_Gazetteer/2024_Gaz_zcta_national.zip"
GEOCODER = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"

_ZIPS: dict[str, tuple[float, float]] | None = None
_GEOCACHE_PATH = DATA_DIR / "geocode.json"
_GEOCACHE: dict[str, list[float] | None] | None = None


def _load_zips() -> dict[str, tuple[float, float]]:
    global _ZIPS
    if _ZIPS is not None:
        return _ZIPS
    raw = get_bytes(GAZETTEER_URL, ttl=60 * 60 * 24 * 90)
    out: dict[str, tuple[float, float]] = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as zf:
        name = next(n for n in zf.namelist() if n.lower().endswith(".txt"))
        text = zf.read(name).decode("utf-8", errors="replace")
    for row in csv.DictReader(io.StringIO(text), delimiter="\t"):
        clean = {k.strip(): (v.strip() if isinstance(v, str) else v) for k, v in row.items()}
        z = clean.get("GEOID")
        try:
            out[z] = (float(clean["INTPTLAT"]), float(clean["INTPTLONG"]))
        except (TypeError, ValueError, KeyError):
            continue
    _ZIPS = out
    return out


def zip_centroid(zipcode: str) -> tuple[float, float] | None:
    return _load_zips().get(zipcode.strip()[:5])


def haversine_mi(a: tuple[float, float], b: tuple[float, float]) -> float:
    r = 3958.7613
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(h))


def zips_within(zipcode: str, radius_mi: float) -> list[str]:
    """Every ZCTA whose centroid is inside the radius. This is how we widen the search."""
    origin = zip_centroid(zipcode)
    if origin is None:
        return [zipcode.strip()[:5]]
    return [z for z, c in _load_zips().items() if haversine_mi(origin, c) <= radius_mi]


def _geocache() -> dict:
    global _GEOCACHE
    if _GEOCACHE is None:
        if _GEOCACHE_PATH.exists():
            try:
                _GEOCACHE = json.loads(_GEOCACHE_PATH.read_text())
            except json.JSONDecodeError:
                _GEOCACHE = {}
        else:
            _GEOCACHE = {}
    return _GEOCACHE


def _flush() -> None:
    _GEOCACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    _GEOCACHE_PATH.write_text(json.dumps(_geocache()))


def geocode(address: str, city: str, state: str, zipcode: str) -> tuple[float, float] | None:
    """Exact coordinates via the Census geocoder. Cached hard -- addresses do not move."""
    one_line = f"{address}, {city}, {state} {zipcode}".strip(", ")
    cache = _geocache()
    if one_line in cache:
        hit = cache[one_line]
        return (hit[0], hit[1]) if hit else None
    try:
        data = get_json(
            GEOCODER,
            {"address": one_line, "benchmark": "Public_AR_Current", "format": "json"},
            ttl=60 * 60 * 24 * 180,
            timeout=25.0,
        )
        matches = data.get("result", {}).get("addressMatches", [])
        if matches:
            c = matches[0]["coordinates"]
            cache[one_line] = [c["y"], c["x"]]
            _flush()
            return (c["y"], c["x"])
    except Exception:  # noqa: BLE001 -- a geocoder failure degrades to centroid, never fatal
        pass
    cache[one_line] = None
    _flush()
    return None
