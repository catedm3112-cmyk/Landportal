/**
 * TEMPORARY DIAGNOSTIC — compare every Land Portal parcel-resolution strategy
 * side-by-side for a given lead, so we can see WHY the pipeline found nothing
 * and which strategy (if any) actually returns the right parcel.
 *
 *   GET /api/parcel-debug?address=7331 East Emory Rd Corryton&state=TN&owner=Ruane
 *
 * Returns, per strategy: ok/error, candidate count, and the first candidates.
 * Safe: read-only, writes nothing to GHL. Delete after diagnosis.
 */
import {
  searchProperties,
  getPropertyByPoint,
} from "../lib/landportal.js";

async function geocodeOneLine(oneline) {
  try {
    const p = new URLSearchParams({ address: oneline, benchmark: "2020", format: "json" });
    const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${p}`);
    const j = await r.json().catch(() => null);
    const m = j?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lng: m.coordinates.x, matchedAddress: m.matchedAddress } : null;
  } catch (e) {
    return { error: String(e?.message || e) };
  }
}

// Trim a raw Land Portal feature to the fields we care about for judging a match.
function slim(features) {
  return (features || []).slice(0, 8).map((f) => {
    const p = f?.properties || {};
    return {
      property_id: p.property_id,
      apn: p.apn ?? p.parcelnumb,
      owner: p.owner_full_name ?? p.owner,
      street: p.street_address ?? p.address,
      city: p.city,
      county: p.county,
      state: p.state,
      acres: p.lot_size_acres ?? p.calc_acres,
    };
  });
}

async function tryStrategy(fn) {
  try {
    const out = await fn();
    return { ok: true, ...out };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export default async function handler(req, res) {
  const q = req.query || {};
  const address = q.address || "";
  const owner = q.owner || "";
  const state = q.state || "TN";

  const result = { input: { address, owner, state } };

  // 1) Geocode the address (Census one-line) → then Land Portal point lookup there.
  const geo = address ? await geocodeOneLine(address) : null;
  result.geocode = geo;
  if (geo?.lat && geo?.lng) {
    result.pointLookup = await tryStrategy(async () => {
      const { feature } = await getPropertyByPoint(geo.lat, geo.lng);
      return { matched: !!feature?.properties?.property_id, candidate: feature ? slim([feature])[0] : null };
    });
  }

  // 2) Land Portal NATIVE address text search (the "unreliable" one — test it).
  if (address) {
    result.addressSearch = await tryStrategy(async () => {
      const { features } = await searchProperties({ address, state });
      return { count: features.length, candidates: slim(features) };
    });
    // Also try a cleaned variant: drop the town word, normalize E/East etc.
    const cleaned = address.replace(/\bEast\b/i, "E").replace(/\bWest\b/i, "W")
      .replace(/\bNorth\b/i, "N").replace(/\bSouth\b/i, "S");
    if (cleaned !== address) {
      result.addressSearchCleaned = await tryStrategy(async () => {
        const { features } = await searchProperties({ address: cleaned, state });
        return { input: cleaned, count: features.length, candidates: slim(features) };
      });
    }
  }

  // 3) Owner-name search (never tried by the pipeline today).
  if (owner) {
    result.ownerSearch = await tryStrategy(async () => {
      const { features } = await searchProperties({ owner, state });
      return { count: features.length, candidates: slim(features) };
    });
  }

  res.status(200).json(result);
}
