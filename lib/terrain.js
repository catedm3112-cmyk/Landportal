// lib/terrain.js
// Terrain and utility-proximity facts from free public data and TruTerra's own
// local GIS exports. This replaces the Land Portal dependency for slope, flood
// and utilities — that vendor exhausted its daily quota mid-analysis and took
// the whole fact chain down with it.
//
// Sources:
//   Slope     — USGS 3DEP Elevation ImageServer (10m DEM, statistics over the
//               actual parcel polygon, not a single point).
//   Sewer     — Sevier County / Sevierville manhole exports (data/, Nov 2023).
//   Water     — Sevier County fire-hydrant export (data/, Nov 2023).
//   Flood     — FEMA / SCGIS 100-year flood polygons (data/, Nov 2023).
//
// Local layers are Sevier County only; outside Sevier these return null and the
// caller reports the field as unconfirmed rather than guessing.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

const USGS_3DEP =
  "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/computeStatisticsHistograms";

let _cache = {};
function load(name) {
  if (_cache[name] === undefined) {
    try {
      _cache[name] = JSON.parse(readFileSync(join(DATA, name), "utf8"));
    } catch {
      _cache[name] = null;
    }
  }
  return _cache[name];
}

const degToPercent = (deg) => Math.tan((deg * Math.PI) / 180) * 100;

/**
 * Slope statistics across the whole parcel from the USGS 3DEP 10m DEM.
 * Returned in BOTH degrees and percent grade — the two are routinely confused,
 * and Land Portal reported percent while the raster is degrees.
 */
export async function parcelSlope(rings) {
  if (!rings?.length) return null;
  try {
    const body = new URLSearchParams({
      geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPolygon",
      renderingRule: JSON.stringify({ rasterFunction: "Slope Degrees" }),
      f: "json",
    });
    const r = await fetch(USGS_3DEP, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const j = await r.json();
    const s = (j.statistics || [])[0];
    if (!s || s.mean == null) return null;
    return {
      meanDegrees: Math.round(s.mean * 10) / 10,
      maxDegrees: Math.round(s.max * 10) / 10,
      minDegrees: Math.round(s.min * 10) / 10,
      meanPercent: Math.round(degToPercent(s.mean) * 10) / 10,
      maxPercent: Math.round(degToPercent(s.max) * 10) / 10,
      samples: s.count ?? null,
      source: "USGS 3DEP 10m elevation model",
    };
  } catch {
    return null;
  }
}

// ---- distance helpers -------------------------------------------------

const FT_PER_DEG_LAT = 364000; // ~= 111320 m in feet

function feetBetween(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * FT_PER_DEG_LAT;
  const dLng = (lng2 - lng1) * FT_PER_DEG_LAT * Math.cos((lat1 * Math.PI) / 180);
  return Math.hypot(dLat, dLng);
}

function nearestPoint(points, lat, lng) {
  let best = null;
  for (const [plng, plat] of points) {
    // Cheap bounding reject before the trig — these lists run to thousands.
    if (Math.abs(plat - lat) > 0.05 || Math.abs(plng - lng) > 0.05) continue;
    const d = feetBetween(lat, lng, plat, plng);
    if (best === null || d < best) best = d;
  }
  return best === null ? null : Math.round(best);
}

function pointInRing(lat, lng, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- local Sevier layers ----------------------------------------------

/** Straight-line distance in feet to the nearest mapped sewer manhole. */
export function nearestSewer(lat, lng, county) {
  if (!/sevier/i.test(county || "")) return null;
  const d = load("sevier-sewer-manholes.json");
  if (!d?.points) return null;
  const ft = nearestPoint(d.points, lat, lng);
  return ft === null ? null : { feet: ft, source: d.source };
}

/** Straight-line distance in feet to the nearest mapped fire hydrant. */
export function nearestHydrant(lat, lng, county) {
  if (!/sevier/i.test(county || "")) return null;
  const d = load("sevier-hydrants.json");
  if (!d?.points) return null;
  const ft = nearestPoint(d.points, lat, lng);
  return ft === null ? null : { feet: ft, source: d.source };
}

/** Whether the parcel centroid falls inside a mapped 100-year flood polygon. */
export function floodStatus(lat, lng, county) {
  if (!/sevier/i.test(county || "")) return null;
  const d = load("sevier-flood-100yr.json");
  if (!d?.polygons) return null;
  for (const p of d.polygons) {
    const [minX, minY, maxX, maxY] = p.bbox;
    if (lng < minX || lng > maxX || lat < minY || lat > maxY) continue;
    if (pointInRing(lat, lng, p.ring)) {
      return { inFloodplain: true, source: d.source };
    }
  }
  return { inFloodplain: false, source: d.source };
}

/**
 * Everything terrain/utility related for one parcel.
 * `rings` is the parcel polygon (for slope); lat/lng the centroid.
 */
export async function terrainIntel({ rings, lat, lng, county }) {
  const [slope] = await Promise.all([parcelSlope(rings)]);
  return {
    slope,
    sewer: lat != null ? nearestSewer(lat, lng, county) : null,
    hydrant: lat != null ? nearestHydrant(lat, lng, county) : null,
    flood: lat != null ? floodStatus(lat, lng, county) : null,
  };
}
