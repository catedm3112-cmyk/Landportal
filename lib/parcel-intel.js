// lib/parcel-intel.js
// Parcel resolution + fact confirmation for the TruTerra Land Analysis Engine.
//
// Design rule: this module NEVER guesses. Every fact it returns carries a
// `source` and `confirmed` flag. If a value cannot be confirmed from an
// authoritative dataset, it comes back as null with `confirmed: false` and a
// `verifyWith` string naming who can confirm it. Downstream code and the LLM
// are forbidden from inventing values for unconfirmed fields.
//
// Sources, in order of authority:
//   1. Sevier County CAMA parcel layer (assessor record: zoning, buildings,
//      utilities, sale history). Sevier County ONLY.
//   2. Land Portal API v2 (statewide: values, slope, flood, coords, land use).
//   3. TN statewide parcel boundaries (geometry + adjoiners; no attributes
//      beyond owner/acreage).

import { searchAndFetchProperty } from "./landportal.js";

const TN_PARCELS =
  "https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/Tennessee_Property_Boundaries_Public_Use/FeatureServer/0/query";

// ---------------------------------------------------------------------------
// COUNTY SOURCE REGISTRY
//
// Each county is a config entry, not code. To add a county: find its public
// ArcGIS REST service, add a block here, and it takes effect everywhere —
// resolution, facts, notes and the client report. Counties absent from this
// registry are handled honestly: their zoning/utilities come back unconfirmed
// with a "verify with <County> Planning & Zoning" pointer rather than a guess.
//
// `cama`    — full assessor/CAMA parcel record (zoning + buildings + utilities
//             + sale history). Richest source; currently Sevier only.
// `zoning`  — dedicated zoning polygon layer, mapped via `fields`.
// `cityLimits` — presence of a feature means the point is inside city limits.
//
// Verified working 2026-07-29 against live points in each county.
// ---------------------------------------------------------------------------
const SEVIER_MAP =
  "https://gis.seviervilletn.org/arcgis/rest/services/PublicMaps/Sevierville_Zoning_Map/MapServer";

export const COUNTY_SOURCES = {
  sevier: {
    label: "Sevier",
    cama: {
      url: `${SEVIER_MAP}/3`,
      source: "Sevier County Assessor (CAMA record)",
    },
    cityLimits: {
      url: `${SEVIER_MAP}/4`,
      source: "Sevierville GIS city-limits layer",
    },
    overlay: {
      url: `${SEVIER_MAP}/12`,
      label: "Interstate Overlay District",
      source: "Sevierville GIS overlay layer",
    },
  },
  blount: {
    label: "Blount",
    // Covers unincorporated Blount plus Alcoa, Maryville, Rockford,
    // Friendsville, Louisville and Townsend.
    zoning: {
      url: "https://bc.blountgis.org/server/rest/services/LandUsePlanning/Zoning/MapServer/0",
      source: "Blount County GIS zoning layer",
      fields: {
        code: "ZONECLASS",
        description: "ZONEDESC",
        authority: "ADMINNAME",
        ordinanceUrl: "WebURL",
      },
    },
  },
};

export function countySource(countyName) {
  const key = String(countyName || "").toLowerCase().replace(/\s*county\s*$/i, "").trim();
  return COUNTY_SOURCES[key] || null;
}

const TN_OUT_FIELDS =
  "PARCELID,CMAP,PARCEL,ADDRESS,DEEDAC,OWNER,OWNER2,COUNTY_NAME,GISLINK,SUBDIV,LOT";

// ---------------------------------------------------------------- helpers

async function arcgisQuery(url, params) {
  const r = await fetch(`${url}?${new URLSearchParams(params)}`);
  const j = await r.json();
  if (j.error) throw new Error(`ArcGIS: ${j.error.message || "query failed"}`);
  return j.features || [];
}

function pointParams(lat, lng, outFields = "*", returnGeometry = false) {
  return {
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields,
    returnGeometry: String(returnGeometry),
    outSR: "4326",
    f: "json",
  };
}

// Assessor codes arrive as "11 Individual/Individual" — the numeric prefix is an
// internal code, the remainder is the human label. We keep the label verbatim
// rather than re-interpreting it.
function codeLabel(raw) {
  const s = String(raw ?? "").trim();
  if (!s || s === "0" || /^0+$/.test(s)) return null;
  const m = s.match(/^\d+\s+(.*)$/);
  const label = (m ? m[1] : s).trim();
  return label && label.toLowerCase() !== "none" ? label : m ? m[1].trim() : null;
}

function fact(value, source, verifyWith) {
  const ok = value !== null && value !== undefined && value !== "";
  return {
    value: ok ? value : null,
    confirmed: ok,
    source: ok ? source : null,
    verifyWith: ok ? null : verifyWith || null,
  };
}

export function normalizeApn(raw) {
  // Accepts every shape these datasets emit and returns a single canonical form:
  //   "060-058.00" | "060  058.00" | "060    05800 000" | "039    05703 001"
  //   -> "060-058.00" / "039-057.03"
  // The packed assessor form has no decimal point: the last two digits ARE the
  // decimal (05800 = 058.00), which a naive digit-run match gets wrong.
  const s = String(raw || "").toUpperCase().replace(/\s+/g, " ").trim();
  const m = s.match(/(\d{3})\s*[-\s]\s*(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const map = m[1];
  let p = m[2];
  if (p.includes(".")) {
    const [a, b = ""] = p.split(".");
    p = `${a.padStart(3, "0").slice(-3)}.${(b + "00").slice(0, 2)}`;
  } else {
    const packed = p.padStart(5, "0").slice(0, 5);
    p = `${packed.slice(0, 3)}.${packed.slice(3)}`;
  }
  return `${map}-${p}`;
}

// ------------------------------------------------- Sevier County CAMA record

async function pointFeature(url, lat, lng) {
  try {
    const feats = await arcgisQuery(`${url}/query`, pointParams(lat, lng));
    return feats[0]?.attributes || null;
  } catch {
    return null; // a county service being down must never fail the analysis
  }
}

/**
 * Gather every county-level record available for a point, driven entirely by
 * COUNTY_SOURCES. Counties with no registry entry return empty structures and
 * the caller reports their fields as unconfirmed.
 */
export async function countyIntel(countyName, lat, lng) {
  const cfg = countySource(countyName);
  const out = {
    county: countyName || null,
    configured: Boolean(cfg),
    cama: null,
    camaSource: null,
    zoning: null,
    inCityLimits: null,
    cityLimitsSource: null,
    overlayDistrict: null,
    overlaySource: null,
  };
  if (!cfg || lat == null || lng == null) return out;

  const jobs = [];

  if (cfg.cama) {
    jobs.push(
      pointFeature(cfg.cama.url, lat, lng).then((a) => {
        out.cama = a;
        out.camaSource = cfg.cama.source;
      })
    );
  }

  if (cfg.zoning) {
    jobs.push(
      pointFeature(cfg.zoning.url, lat, lng).then((a) => {
        if (!a) return;
        const f = cfg.zoning.fields || {};
        const code = a[f.code] ?? null;
        const desc = a[f.description] ?? null;
        out.zoning = {
          // "S — Suburbanizing" reads better than a bare code, but never
          // fabricate a description when the layer has none.
          value: desc || code || null,
          code: code || null,
          authority: a[f.authority] ?? null,
          ordinanceUrl: a[f.ordinanceUrl] ?? null,
          source: cfg.zoning.source,
        };
      })
    );
  }

  if (cfg.cityLimits) {
    jobs.push(
      pointFeature(cfg.cityLimits.url, lat, lng).then((a) => {
        out.inCityLimits = Boolean(a);
        out.cityLimitsSource = cfg.cityLimits.source;
      })
    );
  }

  if (cfg.overlay) {
    jobs.push(
      pointFeature(cfg.overlay.url, lat, lng).then((a) => {
        out.overlayDistrict = a ? cfg.overlay.label : null;
        out.overlaySource = cfg.overlay.source;
      })
    );
  }

  await Promise.all(jobs);
  return out;
}

// ------------------------------------------------------- TN statewide parcels

export async function tnParcelByPoint(lat, lng) {
  const feats = await arcgisQuery(
    TN_PARCELS,
    pointParams(lat, lng, TN_OUT_FIELDS, true)
  );
  return feats[0] || null;
}

export async function tnParcelByText({ road, num, county }) {
  const where =
    `UPPER(ADDRESS) LIKE '%${road}%' AND UPPER(ADDRESS) LIKE '% ${num}'` +
    (county ? ` AND UPPER(COUNTY_NAME)='${county.toUpperCase()}'` : "");
  return arcgisQuery(TN_PARCELS, {
    where,
    outFields: TN_OUT_FIELDS,
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
}

export async function tnAdjoiners(subjectFeature) {
  if (!subjectFeature?.geometry) return [];
  const params = {
    geometry: JSON.stringify({
      ...subjectFeature.geometry,
      spatialReference: { wkid: 4326 },
    }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: TN_OUT_FIELDS,
    returnGeometry: "false",
    outSR: "4326",
    f: "json",
  };
  const feats = await arcgisQuery(TN_PARCELS, params);
  const subjId = subjectFeature.attributes.PARCELID;
  return feats
    .filter((f) => f.attributes.PARCELID !== subjId)
    .map((f) => ({
      owner: `${(f.attributes.OWNER || "").trim()} ${(f.attributes.OWNER2 || "").trim()}`.trim(),
      address: (f.attributes.ADDRESS || "").trim(),
      acres: f.attributes.DEEDAC,
    }));
}

// ------------------------------------------------------------- resolution

function parseAddress(raw) {
  const m = String(raw || "").match(
    /^\s*(\d+)\s+(.+?)(?:\s+(?:RD|ROAD|DR|DRIVE|LN|LANE|HWY|WAY|CIR|CT|PIKE|TRL))?\s*(?:,|$)/i
  );
  if (!m) return null;
  return {
    num: m[1],
    road: m[2]
      .toUpperCase()
      .replace(/\s+(RD|ROAD|DR|LN|HWY|WAY|CIR|CT|PIKE|TRL)\.?$/i, "")
      .trim(),
  };
}

/**
 * Layered parcel resolution.
 * Land Portal is primary (it returns scored candidates); the TN boundary layer
 * supplies geometry and is used to cross-validate the APN. Any disagreement
 * between sources lowers confidence rather than being silently resolved.
 *
 * Returns { ok, confidence, method, apn, lat, lng, lp, tn, candidates, issues }
 */
export async function resolveParcel({ apn, address, county, state = "TN" }) {
  const issues = [];
  let lp = null;
  let method = null;

  // 1. Land Portal — APN first (most specific), then address.
  if (apn) {
    try {
      const r = await searchAndFetchProperty({ apn, state });
      if (r?.property) {
        lp = r;
        method = "landportal_apn";
      }
    } catch (e) {
      issues.push(`Land Portal APN lookup failed: ${e.message}`);
    }
  }
  if (!lp && address) {
    try {
      const r = await searchAndFetchProperty({ address, state });
      if (r?.property) {
        lp = r;
        method = "landportal_address";
      }
    } catch (e) {
      issues.push(`Land Portal address lookup failed: ${e.message}`);
    }
  }

  const lat = lp?.property?.latitude ?? null;
  const lng = lp?.property?.longitude ?? null;

  // 2. Geometry from the TN layer — by point when we have coordinates
  //    (point-in-polygon is exact; text matching is not), else by text.
  let tn = null;
  if (lat != null && lng != null) {
    try {
      tn = await tnParcelByPoint(lat, lng);
      if (tn) method = `${method}+tn_point`;
    } catch (e) {
      issues.push(`TN point query failed: ${e.message}`);
    }
  }
  if (!tn) {
    const parsed = parseAddress(address || apn);
    if (parsed) {
      try {
        const feats = await tnParcelByText({ ...parsed, county });
        if (feats.length === 1) {
          tn = feats[0];
          method = method ? `${method}+tn_text` : "tn_text";
        } else if (feats.length > 1) {
          issues.push(
            `TN text match ambiguous: ${feats.length} parcels matched "${parsed.num} ${parsed.road}"${county ? ` in ${county}` : " statewide (no county supplied)"}.`
          );
          if (county) {
            tn = feats[0];
            method = method ? `${method}+tn_text_first` : "tn_text_first";
          }
        }
      } catch (e) {
        issues.push(`TN text query failed: ${e.message}`);
      }
    }
  }

  // 3. Cross-validate the two sources by APN.
  const lpApn = normalizeApn(lp?.property?.apn);
  const tnApn = tn ? normalizeApn(`${tn.attributes.CMAP}-${tn.attributes.PARCEL}`) : null;
  let confidence = 0;
  if (lp && tn) {
    if (lpApn && tnApn && lpApn === tnApn) confidence = 100;
    else {
      confidence = 55;
      issues.push(
        `APN mismatch between sources — Land Portal ${lpApn || "n/a"} vs TN parcel layer ${tnApn || "n/a"}. Parcel identity NOT confirmed.`
      );
    }
  } else if (lp || tn) {
    confidence = 60;
    issues.push(
      lp
        ? "Only Land Portal resolved this parcel; no boundary match for cross-validation."
        : "Only the TN boundary layer resolved this parcel; no assessor record for cross-validation."
    );
  }

  const candidates = (lp?.candidates || []).slice(0, 5);

  return {
    ok: Boolean(lp || tn),
    confidence,
    method,
    apn: lpApn || tnApn,
    lat,
    lng,
    lp: lp?.property || null,
    tn,
    candidates,
    issues,
  };
}

// ------------------------------------------------------------- fact building

/**
 * Assemble the confirmed-fact set. Anything not backed by a dataset is returned
 * as unconfirmed with a `verifyWith` pointer — never as a guess.
 */
export function buildFacts({ lp, intel, countyName }) {
  const county = countyName || lp?.situsCounty || null;
  const cama = intel?.cama || null;
  const assessor = intel?.camaSource || `${county || "County"} County Assessor (CAMA record)`;
  const planning = `${county || "County"} County Planning & Zoning`;

  // Structures — three independent signals; any one is decisive.
  const bldgs = cama?.BLDGS ?? null;
  const viImproved = cama?.VI === "I";
  const impValue = cama?.IMPVAL ?? null;
  const lpImproved =
    lp?.marketTotalValue != null &&
    lp?.marketLandValue != null &&
    lp.marketTotalValue - lp.marketLandValue > 0;
  const improved =
    bldgs > 0 || viImproved || (impValue != null && impValue > 0) || lpImproved;

  const structures = improved
    ? {
        count: bldgs ?? null,
        type: codeLabel(cama?.IMP) || lp?.landUseDescription || null,
        yearBuilt: cama?.YRBLT || null,
        squareFeet: cama?.SFLA || null,
        stories: cama?.STORIES || null,
        condition: cama?.BLDGCOND || null,
        improvementValue: impValue ?? (lpImproved ? lp.marketTotalValue - lp.marketLandValue : null),
        mobileHomes: cama?.NUM_MH ?? null,
      }
    : null;

  // Cross-source contradictions must never pass silently. Land Portal sometimes
  // keys to a sub-record (e.g. APN "...-001") covering only part of the tract,
  // which produces a smaller acreage and a "vacant" land use even though the
  // assessor's parent parcel carries a house. The assessor record wins, but the
  // conflict is surfaced so it can be confirmed before a number is quoted.
  const discrepancies = [];
  const lpAc = Number(lp?.lotSizeAcres) || null;
  const camaAc = Number(cama?.CAMADEEDAC) || null;
  if (lpAc && camaAc) {
    const delta = Math.abs(lpAc - camaAc) / Math.max(lpAc, camaAc);
    if (delta > 0.1) {
      discrepancies.push(
        `ACREAGE CONFLICT: Land Portal reports ${lpAc} ac, ${county || "county"} assessor reports ${camaAc} ac (${Math.round(delta * 100)}% apart). Assessor figure used — confirm deeded acreage against the deed/plat before quoting.`
      );
    }
  }
  if (improved && lp?.landUseDescription && /vacant/i.test(lp.landUseDescription)) {
    discrepancies.push(
      `LAND USE CONFLICT: Land Portal classifies this parcel as "${lp.landUseDescription}", but the assessor building record shows ${bldgs ?? "≥1"} building(s)${cama?.YRBLT ? ` built ${cama.YRBLT}` : ""}. Assessor record used — verify whether the structure sits on this tract.`
    );
  }
  if (lpAc && camaAc && lp?.apn && cama?.ID && normalizeApn(lp.apn) !== normalizeApn(cama.ID)) {
    discrepancies.push(
      `PARCEL ID CONFLICT: Land Portal APN ${lp.apn} vs assessor ${String(cama.ID).trim()}.`
    );
  }

  return {
    improved,
    structures,
    discrepancies,

    // Zoning comes from a dedicated county zoning layer where one exists,
    // otherwise the assessor's zoning attribute. Never from land use.
    zoning: intel?.zoning?.value
      ? fact(String(intel.zoning.value).trim(), intel.zoning.source)
      : cama?.ZONING
      ? fact(String(cama.ZONING).trim(), assessor)
      : fact(null, null, planning),

    zoningOrdinance: intel?.zoning?.ordinanceUrl
      ? fact(intel.zoning.ordinanceUrl, intel.zoning.source)
      : fact(null, null, null),

    zoningAuthority: intel?.zoning?.authority
      ? fact(intel.zoning.authority, intel.zoning.source)
      : fact(null, null, null),

    jurisdiction:
      intel?.inCityLimits === null || intel?.inCityLimits === undefined
        ? fact(null, null, `${county || "County"} planning office`)
        : fact(
            intel.inCityLimits
              ? "Inside city limits — city zoning applies"
              : "Outside city limits — county zoning applies",
            intel.cityLimitsSource
          ),

    overlayDistrict: intel?.overlayDistrict
      ? fact(intel.overlayDistrict, intel.overlaySource)
      : fact(null, null, null),

    water: fact(codeLabel(cama?.WATERSEWER)?.split("/")[0] || null, assessor, `${county || "County"} utility district`),
    sewer: fact(codeLabel(cama?.WATERSEWER)?.split("/")[1] || null, assessor, `${county || "County"} utility district`),
    electric: fact(codeLabel(cama?.ELEC), assessor, "local electric utility"),
    gas: fact(codeLabel(cama?.GAS), assessor, "local gas utility"),

    acreage: fact(
      cama?.CAMADEEDAC ?? lp?.lotSizeAcres ?? null,
      cama?.CAMADEEDAC ? assessor : "Land Portal API v2"
    ),
    slopeAverage: fact(lp?.slopeAverage ?? null, "Land Portal API v2 (terrain model)"),
    slopeMax: fact(lp?.slopeMax ?? null, "Land Portal API v2 (terrain model)"),
    roadFrontage: fact(lp?.roadFrontage ?? null, "Land Portal API v2"),
    landLocked: fact(lp?.landLocked ?? null, "Land Portal API v2"),
    floodCoveragePct: fact(lp?.femaCoverPercentage ?? null, "FEMA via Land Portal API v2"),
    wetlandsCoveragePct: fact(lp?.wetlandsCoverPercentage ?? null, "Land Portal API v2"),

    assessorAppraisal: fact(cama?.APPRAISAL ?? lp?.marketTotalValue ?? null, assessor),
    assessorLandValue: fact(cama?.LANDVAL ?? lp?.marketLandValue ?? null, assessor),
    lastSale:
      cama?.PRICE > 0
        ? fact(
            { price: cama.PRICE, date: cama.SALEDATE || null, deed: cama.DEEDBKPG || null },
            `${assessor} sale record`
          )
        : fact(null, null, `${county || "County"} Register of Deeds`),

    subdivision: fact(cama?.SUBDIV?.trim() || lp?.subdivision || null, assessor),
    legalDescription: fact(lp?.legalDescription || null, "Land Portal API v2"),
    ownerOfRecord: fact(
      (cama?.OWNER || "").trim() || lp?.ownerName || null,
      cama?.OWNER ? assessor : "Land Portal API v2"
    ),
    // Owner-occupied when the assessor's mailing address matches the situs
    // address (both street name and house number must match, not just one).
    ownerOccupied: fact(
      (() => {
        const mail = String(cama?.MAILADDR || "").toUpperCase().replace(/\s+/g, " ").trim();
        const street = String(cama?.STREET || "").toUpperCase().trim();
        const num = String(cama?.ST_NUM || "").trim();
        if (!mail || !street || !num) return null;
        return mail.includes(street) && mail.includes(num);
      })(),
      assessor
    ),
    tlpLandEstimate: fact(lp?.tlpEstimate ?? null, "Land Portal TLP model"),
    tlpPricePerAcre: fact(lp?.tlpPricePerAcre ?? null, "Land Portal TLP model"),

    dataVintage: fact(cama?.TAXYR ? `Tax year ${cama.TAXYR}` : null, assessor),
  };
}

/** Facts the report may state as fact — everything else must be labelled unconfirmed. */
export function confirmedOnly(facts) {
  const out = {};
  for (const [k, v] of Object.entries(facts)) {
    if (v && typeof v === "object" && "confirmed" in v && v.confirmed) out[k] = v.value;
  }
  return out;
}

export function unconfirmedList(facts) {
  return Object.entries(facts)
    .filter(([, v]) => v && typeof v === "object" && "confirmed" in v && !v.confirmed && v.verifyWith)
    .map(([k, v]) => `${k} (verify with ${v.verifyWith})`);
}
