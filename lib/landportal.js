/**
 * Land Portal API v2 client.
 * Base: https://api.landportal.com/v2  —  Bearer token auth.
 *
 * Replaces the old v1 WordPress endpoint (landportal.com/wp-json/lp-rest-api/v1).
 * v2 returns a complete deal picture in a single property-detail call: owner +
 * mailing address, acreage, flood/wetlands/water, assessed + market value,
 * comps ("similars"), Land Portal value estimate, and full slope/buildability.
 */

const LAND_PORTAL_BASE_URL = "https://api.landportal.com/v2";

function getToken() {
  const token = process.env.LAND_PORTAL_API_V2_KEY;
  if (!token) throw new Error("Missing LAND_PORTAL_API_V2_KEY");
  return token;
}

async function landPortalGet(path) {
  const res = await fetch(`${LAND_PORTAL_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const detail = data?.error?.message || data?.message || `HTTP ${res.status}`;
    throw new Error(`Land Portal request failed: ${detail}`);
  }

  return data;
}

// ─── NORMALIZE ───────────────────────────────────────────────────────────────
// Maps a v2 property-detail object into the shape the rest of the app expects.
// `fallback` is the lightweight search-result `properties` object, which carries
// the situs street address/city/zip that the detail payload omits.
export function normalizeProperty(property, fallback) {
  const p = property || {};
  const f = fallback || {};

  const acres = p.lot_size_acres ?? p.calc_acres ?? f.lot_size_acres ?? null;

  return {
    // ── identity ──
    propertyId: p.property_id ?? f.property_id ?? null,
    fips: p.fips ?? f.fips ?? null,
    apn: p.apn ?? f.apn ?? null,

    // ── situs (location of the land) ──
    situsAddress: f.street_address ?? null,
    situsCity: f.city ?? null,
    situsState: p.state ?? f.state ?? null,
    situsZip: f.zip_code ?? null,
    situsCounty: p.county ?? f.county ?? null,
    latitude: p.latitude ?? null,
    longitude: p.longitude ?? null,

    // ── owner + mailing ──
    ownerName: p.owner_full_name ?? f.owner_full_name ?? null,
    ownerFirstName: p.owner_first_name ?? null,
    ownerLastName: p.owner_last_name ?? null,
    mailingAddress: p.mailing_street_address ?? null,
    mailingCity: p.mailing_city ?? null,
    mailingState: p.mailing_state ?? null,
    mailingZip: p.mailing_zip_code ?? null,

    // ── land characteristics ──
    legalDescription: p.legal_description ?? null,
    subdivision: p.subdivision_name ?? null,
    lotSizeAcres: acres,
    calcAcres: p.calc_acres ?? null,
    landUseCode: p.land_use_code ?? null,
    landUseDescription: p.land_use_description ?? null,
    zoning: p.land_use_description ?? p.land_use_code ?? null,

    // ── value ──
    assessedTotalValue: p.assessed_total_value ?? null,
    assessedLandValue: p.assessed_land_value ?? null,
    marketTotalValue: p.market_total_value ?? null,
    marketLandValue: p.market_value_land ?? null,
    taxAmount: p.tax_amount ?? null,
    tlpEstimate: p.tlp_estimate ?? null,
    tlpPricePerAcre: p.tlp_ppa ?? null,

    // ── physical / risk ──
    landLocked: p.land_locked ?? null,
    roadFrontage: p.road_frontage ?? null,
    floodZone: p.flood_zone ?? null,
    femaCoverPercentage: p.fema_cover_percentage ?? null,
    wetlandsCoverPercentage: p.wetlands_cover_percentage ?? null,
    waterFeaturePresent: p.water_feature_present ?? null,
    nearbyWaterTypes: p.nearby_water_types ?? null,

    // ── slope / buildability ──
    slopeAverage: p.slope_average ?? null,
    slopeMin: p.slope_min ?? null,
    slopeMax: p.slope_max ?? null,
    elevationAverage: p.elevation_average ?? null,
    buildabilityPercentage: p.buildability_total_perc ?? null,
    buildabilityAcres: p.buildability_area ?? null,
    slopeBreakdown: {
      flat_0_5: p.percentage_of_land_with_flat_slope_0_05 ?? null,
      minimal_5: p.percentage_of_land_with_minimal_slope_05_5 ?? null,
      moderate_5_10: p.percentage_of_land_with_moderate_slope_5_10 ?? null,
      heavy_10_15: p.percentage_of_land_with_heavy_slope_10_15 ?? null,
      extreme_15: p.percentage_of_land_with_extreme_slope_15 ?? null,
    },

    // ── comps ──
    comps: Array.isArray(p.similars) ? p.similars : [],

    raw: p,
  };
}

// ─── RAW v2 CALLS ──────────────────────────────────────────────────────────────

// Search returns a GeoJSON FeatureCollection of up to ~10 lightweight matches.
export async function searchProperties({ apn, parcel, owner, address, state } = {}) {
  const params = new URLSearchParams();
  if (apn || parcel) params.set("parcelnumb", apn || parcel);
  if (owner) params.set("owner", owner);
  if (address) params.set("address", address);
  if (state) params.set("state", state);

  if (![...params.keys()].length) {
    throw new Error("searchProperties requires apn, owner, or address.");
  }

  const data = await landPortalGet(`/properties?${params.toString()}`);
  return {
    features: data?.data?.features ?? [],
    meta: data?.meta ?? null,
  };
}

// Full detail for a single property by its Land Portal property_id.
export async function getPropertyDetail(propertyId) {
  const data = await landPortalGet(`/properties/${encodeURIComponent(String(propertyId))}`);
  return {
    property: data?.data?.properties ?? null,
    meta: data?.meta ?? null,
  };
}

// Find the property covering a lat/lng point. Returns the lightweight feature.
export async function getPropertyByPoint(lat, lng) {
  const params = new URLSearchParams({ latitude: String(lat), longitude: String(lng) });
  let data;
  try {
    data = await landPortalGet(`/properties/point?${params.toString()}`);
  } catch (err) {
    // A point with no parcel is a normal outcome, not an error — Land Portal
    // answers with a non-200 ("No property found at the specified location").
    // Return "no match" so callers post a clean note instead of throwing a 500
    // (which, in the webhook path, would let GHL retry and duplicate work).
    if (/no property found|not found|\b404\b/i.test(err.message || "")) {
      return { feature: null, meta: null };
    }
    throw err;
  }
  // /point may return a single Feature or a FeatureCollection — handle both.
  const node = data?.data;
  if (!node) return { feature: null, meta: data?.meta ?? null };
  const feature = node.type === "FeatureCollection" ? (node.features?.[0] ?? null) : node;
  return { feature, meta: data?.meta ?? null };
}

// ─── HIGH-LEVEL: search then fetch full detail ──────────────────────────────────
// Preserves the signature used by enrich-property.js and lead-intake-webhook.js.
export async function searchAndFetchProperty(params) {
  const { propertyid, propertyId, apn, parcel, owner, address, lat, lng, state = "TN" } = params || {};

  // Direct by id (v2 needs only the property_id; fips no longer required).
  const directId = propertyId || propertyid;
  if (directId) {
    const detail = await getPropertyDetail(directId);
    return {
      success: !!detail.property,
      matchType: "direct_property_id",
      searchMatch: null,
      property: detail.property ? normalizeProperty(detail.property) : null,
      meta: detail.meta,
    };
  }

  // By geographic point.
  if (lat != null && lng != null) {
    const { feature } = await getPropertyByPoint(lat, lng);
    const match = feature?.properties;
    if (!match?.property_id) {
      return { success: false, matchType: "point", searchMatch: null, property: null, message: "No parcel at coordinates.", meta: null };
    }
    const detail = await getPropertyDetail(match.property_id);
    return {
      success: !!detail.property,
      matchType: "point",
      searchMatch: match,
      property: normalizeProperty(detail.property, match),
      meta: detail.meta,
    };
  }

  // By APN / parcel / owner / address text search.
  const { features } = await searchProperties({ apn, parcel, owner, address, state });
  if (!features.length) {
    return {
      success: false,
      matchType: owner ? "owner" : apn || parcel ? "parcelnumb" : "address",
      searchMatch: null,
      property: null,
      message: "No matching parcel found.",
      meta: null,
    };
  }

  const match = features[0].properties;
  if (!match?.property_id) {
    throw new Error("Land Portal match missing property_id.");
  }

  const detail = await getPropertyDetail(match.property_id);
  return {
    success: !!detail.property,
    matchType: owner ? "owner" : apn || parcel ? "parcelnumb" : "address",
    searchMatch: match,
    property: normalizeProperty(detail.property, match),
    meta: detail.meta,
  };
}
