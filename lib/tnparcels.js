/**
 * Tennessee statewide parcel layer client (free TNMap / Comptroller ArcGIS layer).
 *
 * The Land Analysis engine deliberately avoids metered Land Portal calls: the
 * subject parcel and its adjoiners come from the free TN statewide cadastral
 * layer, and comps come from Claude web search. This module is the ArcGIS half.
 *
 * The layer's exact URL and field names vary by publish, so nothing is
 * hard-coded: the query endpoint is env-configurable and the client reads the
 * layer's own metadata once to discover which fields carry owner / address /
 * acreage / parcel-id / value, then builds queries against whatever it finds.
 *
 *   TN_PARCEL_LAYER_URL  — full REST layer URL (…/MapServer/0 or …/FeatureServer/0)
 *
 * All geometry is requested in WGS84 (outSR=4326) so callers get lon/lat back for
 * map links and can feed the subject polygon straight into the adjoiner query.
 */

const DEFAULT_LAYER =
  "https://tnmap.tn.gov/arcgis/rest/services/CADASTRAL/PARCELS/MapServer/0";

function layerUrl() {
  return (process.env.TN_PARCEL_LAYER_URL || DEFAULT_LAYER).replace(/\/+$/, "");
}

// ── metadata (cached across warm invocations) ──────────────────────────────────
let _fieldsCache = null;
let _fieldsCacheUrl = null;

function pickField(names, ...regexes) {
  for (const re of regexes) {
    const hit = names.find((n) => re.test(n));
    if (hit) return hit;
  }
  return null;
}

async function getFields() {
  const url = layerUrl();
  if (_fieldsCache && _fieldsCacheUrl === url) return _fieldsCache;

  const res = await fetch(`${url}?f=json`, { headers: { Accept: "application/json" } });
  const meta = await res.json().catch(() => null);
  const names = (meta?.fields || []).map((f) => f.name);

  const fields = {
    all: names,
    oid: meta?.objectIdField || pickField(names, /^objectid$/i, /^fid$/i) || "OBJECTID",
    owner: pickField(names, /^owner$/i, /own.*name/i, /owner/i, /^own/i),
    owner2: pickField(names, /owner.?2/i, /co.?owner/i),
    address: pickField(names, /par.?addr/i, /situs/i, /prop.?add/i, /^address$/i, /addr/i),
    city: pickField(names, /par.?city/i, /situs.?city/i, /^city$/i, /city/i),
    county: pickField(names, /cnty.?name/i, /county/i, /^cnty/i),
    acres: pickField(names, /calc.?acre/i, /gis.?acre/i, /^acres?$/i, /acre/i, /deed.?acre/i),
    pin: pickField(names, /^parid$/i, /^pin$/i, /parcel.?id/i, /^prop_id$/i, /^gpin$/i, /par.?num/i, /parcel/i),
    value: pickField(names, /appr.*(totl|total|value)/i, /assess.*(total|value)/i, /market.*value/i, /totl.?appr/i, /^value$/i),
    zip: pickField(names, /par.?zip/i, /situs.?zip/i, /^zip/i),
  };

  _fieldsCache = fields;
  _fieldsCacheUrl = url;
  return fields;
}

// ── low-level query ─────────────────────────────────────────────────────────────
async function arcgisQuery(params) {
  const url = `${layerUrl()}/query`;
  const search = new URLSearchParams({ f: "json", ...params });
  const res = await fetch(`${url}?${search.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const data = await res.json().catch(() => null);
  if (data?.error) {
    throw new Error(`TN parcel layer error: ${data.error?.message || "unknown"}`);
  }
  return data;
}

function sqlEscape(v) {
  return String(v).replace(/'/g, "''");
}

// Rough centroid of an esri polygon (average of the outer-ring vertices).
function ringCentroid(geometry) {
  const ring = geometry?.rings?.[0];
  if (!ring || !ring.length) return { lat: null, lng: null };
  let sx = 0;
  let sy = 0;
  for (const [x, y] of ring) {
    sx += x;
    sy += y;
  }
  return { lng: sx / ring.length, lat: sy / ring.length };
}

function normalizeParcel(feature, fields) {
  const a = feature?.attributes || {};
  const centroid = ringCentroid(feature?.geometry);
  const num = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    pin: fields.pin ? a[fields.pin] ?? null : null,
    owner: fields.owner ? a[fields.owner] ?? null : null,
    owner2: fields.owner2 ? a[fields.owner2] ?? null : null,
    address: fields.address ? a[fields.address] ?? null : null,
    city: fields.city ? a[fields.city] ?? null : null,
    county: fields.county ? a[fields.county] ?? null : null,
    zip: fields.zip ? a[fields.zip] ?? null : null,
    acres: fields.acres ? num(a[fields.acres]) : null,
    value: fields.value ? num(a[fields.value]) : null,
    lat: centroid.lat,
    lng: centroid.lng,
    geometry: feature?.geometry || null,
    raw: a,
  };
}

// ── public: resolve the subject parcel ──────────────────────────────────────────

// Parcel that contains a WGS84 point.
export async function parcelAtPoint(lat, lng) {
  const fields = await getFields();
  const data = await arcgisQuery({
    geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPoint",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "true",
    resultRecordCount: "1",
  });
  const f = data?.features?.[0];
  return f ? normalizeParcel(f, fields) : null;
}

// Parcel by APN/PIN, owner name, and/or address text (LIKE match, best acreage
// first). A confident APN match short-circuits the softer owner/address search.
export async function parcelByText({ apn, owner, address, county } = {}) {
  const fields = await getFields();

  if (apn && fields.pin) {
    const data = await arcgisQuery({
      where: `UPPER(${fields.pin}) LIKE '%${sqlEscape(String(apn).toUpperCase().replace(/\s+/g, ""))}%'`,
      outFields: "*",
      outSR: "4326",
      returnGeometry: "true",
      resultRecordCount: "1",
    });
    const f = data?.features?.[0];
    if (f) return normalizeParcel(f, fields);
  }

  const clauses = [];
  if (owner && fields.owner) clauses.push(`UPPER(${fields.owner}) LIKE '%${sqlEscape(owner.toUpperCase())}%'`);
  if (address && fields.address) {
    // Match on the house number + first street token, which is the most stable
    // signal across the statewide layer's inconsistent address formatting.
    const toks = String(address).toUpperCase().replace(/[.,]/g, "").split(/\s+/).filter(Boolean);
    for (const t of toks.slice(0, 2)) clauses.push(`UPPER(${fields.address}) LIKE '%${sqlEscape(t)}%'`);
  }
  if (!clauses.length) return null;
  if (county && fields.county) clauses.push(`UPPER(${fields.county}) LIKE '%${sqlEscape(county.toUpperCase())}%'`);

  const data = await arcgisQuery({
    where: clauses.join(" AND "),
    outFields: "*",
    outSR: "4326",
    returnGeometry: "true",
    orderByFields: fields.acres ? `${fields.acres} DESC` : fields.oid,
    resultRecordCount: "5",
  });
  const f = data?.features?.[0];
  return f ? normalizeParcel(f, fields) : null;
}

// ── public: adjoiners ────────────────────────────────────────────────────────────
// Every parcel whose polygon intersects the subject polygon (shared boundary
// counts), minus the subject itself. Geometry is not returned — only attributes.
export async function adjoiners(subject) {
  if (!subject?.geometry?.rings) return [];
  const fields = await getFields();
  const data = await arcgisQuery({
    geometry: JSON.stringify({ rings: subject.geometry.rings, spatialReference: { wkid: 4326 } }),
    geometryType: "esriGeometryPolygon",
    inSR: "4326",
    outSR: "4326",
    spatialRel: "esriSpatialRelIntersects",
    outFields: "*",
    returnGeometry: "false",
    resultRecordCount: "50",
  });
  const list = (data?.features || []).map((f) => normalizeParcel(f, fields));
  // Drop the subject: match on PIN when we have one, else on identical owner+address.
  return list.filter((p) => {
    if (subject.pin && p.pin) return String(p.pin) !== String(subject.pin);
    return !(p.owner === subject.owner && p.address === subject.address);
  });
}

export { normalizeParcel };
