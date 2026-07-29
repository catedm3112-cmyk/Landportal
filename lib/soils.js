// lib/soils.js
// USDA NRCS soil facts via Soil Data Access (SSURGO).
//
// Why this matters more than it sounds: on a rural East Tennessee parcel with
// no public sewer, septic feasibility IS the deal. A "Very limited" septic
// rating with shallow bedrock and steep slope can make a lot effectively
// unbuildable, and no assessor or listing feed will tell you that.
//
// No API key, no quota. Endpoint accepts SQL over the national SSURGO tables.
//
// Ratings live in `cointerp`: ruledepth 0 is the headline class
// ("Very limited" / "Somewhat limited" / "Not limited"); ruledepth 1 rows are
// the limiting factors ("Too steep", "Shallow depth to bedrock").

const SDA = "https://sdmdataaccess.nrcs.usda.gov/Tabular/post.rest";

// Tennessee publishes its own conventional-septic interpretation; prefer it
// over the national absorption-field rule when present.
const SEPTIC_RULES = [
  "ENG - Conventional On-Site Septic Systems (TN)",
  "ENG - Septic Tank Absorption Fields",
];
const BUILD_RULES = ["ENG - Dwellings W/O Basements", "ENG - Local Roads and Streets"];

async function sda(query, timeoutMs = 20000) {
  const r = await fetch(SDA, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, format: "JSON+COLUMNNAME" }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await r.text();
  // SDA reports SQL errors as an OGC XML exception with a 400.
  if (text.trim().startsWith("<")) {
    const m = text.match(/<ServiceException>([\s\S]*?)</);
    throw new Error(`SDA: ${(m?.[1] || "query failed").trim()}`);
  }
  const j = JSON.parse(text);
  if (!j?.Table) return [];
  const [cols, ...rows] = j.Table;
  return rows.map((row) => Object.fromEntries(cols.map((c, i) => [c, row[i]])));
}

const q = (s) => String(s).replace(/'/g, "''");

/** Map unit key covering a point. */
async function mukeyAt(lat, lng) {
  const rows = await sda(
    `SELECT mukey FROM SDA_Get_Mukey_from_intersection_with_WktWgs84('point(${lng} ${lat})')`
  );
  return rows[0]?.mukey || null;
}

/**
 * Soil facts for a parcel. Uses the dominant component (highest comppct_r) —
 * map units are mixtures, and the dominant component is what a septic
 * evaluation will most likely encounter.
 */
export async function soilIntel(lat, lng) {
  if (lat == null || lng == null) return null;
  try {
    const mukey = await mukeyAt(lat, lng);
    if (!mukey) return null;

    const [mu] = await sda(`SELECT muname, farmlndcl FROM mapunit WHERE mukey='${q(mukey)}'`);
    const comps = await sda(
      `SELECT TOP 4 cokey, compname, comppct_r, drainagecl, hydricrating, slope_l, slope_h FROM component WHERE mukey='${q(mukey)}' ORDER BY comppct_r DESC`
    );
    const dom = comps[0];
    if (!dom) return null;

    const wanted = [...SEPTIC_RULES, ...BUILD_RULES].map((r) => `'${q(r)}'`).join(",");
    const interp = await sda(
      `SELECT mrulename, ruledepth, interphrc FROM cointerp WHERE cokey='${q(dom.cokey)}' AND mrulename IN (${wanted})`
    );

    const rating = (name) => {
      const rows = interp.filter((r) => r.mrulename === name);
      const head = rows.find((r) => String(r.ruledepth) === "0");
      if (!head) return null;
      return {
        rule: name,
        rating: head.interphrc,
        reasons: rows
          .filter((r) => String(r.ruledepth) !== "0")
          .map((r) => r.interphrc)
          .filter(Boolean),
      };
    };

    const septic = SEPTIC_RULES.map(rating).find(Boolean) || null;
    const dwellings = rating("ENG - Dwellings W/O Basements");
    const roads = rating("ENG - Local Roads and Streets");

    return {
      mukey,
      mapUnit: mu?.muname || null,
      farmlandClass: mu?.farmlndcl || null,
      dominant: {
        name: dom.compname,
        percent: dom.comppct_r,
        drainage: dom.drainagecl,
        hydric: dom.hydricrating,
        slopeLow: dom.slope_l,
        slopeHigh: dom.slope_h,
      },
      components: comps.map((c) => ({ name: c.compname, percent: c.comppct_r })),
      septic,
      dwellings,
      roads,
      source: "USDA NRCS SSURGO via Soil Data Access",
    };
  } catch {
    return null; // soils are enrichment; never fail an analysis over them
  }
}

/** One-line summary for the GHL note. */
export function soilSummary(s) {
  if (!s) return null;
  const bits = [];
  if (s.mapUnit) bits.push(s.mapUnit);
  if (s.septic) {
    bits.push(
      `septic ${String(s.septic.rating || "").toUpperCase()}${s.septic.reasons.length ? ` (${s.septic.reasons.join(", ")})` : ""}`
    );
  }
  if (s.dominant?.drainage) bits.push(`${s.dominant.drainage}`);
  if (s.farmlandClass) bits.push(s.farmlandClass);
  return bits.join(" | ");
}
