// lib/hydro.js
// Surface water from the USGS National Hydrography Dataset.
//
// Why it matters here: Tennessee septic regulations impose setbacks from
// streams, so a creek near the parcel compounds an already "Very limited"
// soil septic rating. It also flags flood/creek-bottom acreage that looks
// usable on a plat but is not.
//
// Free, no key. Layer 6 = Flowline (streams, large scale), layer 12 =
// Waterbody. Note the field casing differs between them: layer 6 is
// lowercase (gnis_name, ftype), layer 12 is uppercase.

const NHD = "https://hydro.nationalmap.gov/arcgis/rest/services/nhd/MapServer";

// NHD FTYPE codes worth naming. Anything else is reported by its raw code
// rather than guessed at.
const FTYPE = {
  334: "connector",
  336: "canal/ditch",
  390: "lake or pond",
  436: "swamp/marsh",
  460: "stream or river",
  558: "artificial path",
};

const ESCALATING_FEET = [100, 250, 500, 1000, 2640];

async function nhdQuery(layer, params) {
  const r = await fetch(`${NHD}/${layer}/query?${new URLSearchParams(params)}`, {
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "NHD query failed");
  return j.features || [];
}

function label(attrs) {
  const name = attrs.gnis_name || attrs.GNIS_NAME || null;
  const ft = attrs.ftype ?? attrs.FTYPE;
  const kind = FTYPE[ft] || `type ${ft}`;
  return { name: name || null, kind };
}

/** Does a mapped stream cross the parcel itself? */
async function streamsOnParcel(rings) {
  if (!rings?.length) return null;
  try {
    const feats = await nhdQuery(6, {
      geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }),
      geometryType: "esriGeometryPolygon",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "gnis_name,ftype",
      returnGeometry: "false",
      f: "json",
    });
    return feats.map((f) => label(f.attributes));
  } catch {
    return null;
  }
}

/**
 * Nearest mapped stream, found by widening the search radius rather than
 * pulling geometry and computing distances client-side. Returns the bracket
 * ("within 500 ft"), which is the precision the setback question needs.
 */
async function nearestStream(lat, lng) {
  for (const feet of ESCALATING_FEET) {
    try {
      const feats = await nhdQuery(6, {
        geometry: JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }),
        geometryType: "esriGeometryPoint",
        inSR: "4326",
        distance: String(feet),
        units: "esriSRUnit_Foot",
        spatialRel: "esriSpatialRelIntersects",
        outFields: "gnis_name,ftype",
        returnGeometry: "false",
        resultRecordCount: "5",
        f: "json",
      });
      // Artificial paths are routing lines through waterbodies, not creeks.
      const real = feats.map((f) => label(f.attributes)).filter((x) => x.kind !== "artificial path");
      if (real.length) {
        const named = real.find((x) => x.name) || real[0];
        return { withinFeet: feet, name: named.name, kind: named.kind, count: real.length };
      }
    } catch {
      return null;
    }
  }
  return { withinFeet: null, name: null, kind: null, count: 0 };
}

export async function hydroIntel({ rings, lat, lng }) {
  if (lat == null || lng == null) return null;
  try {
    const [onParcel, nearest] = await Promise.all([
      streamsOnParcel(rings),
      nearestStream(lat, lng),
    ]);
    return {
      onParcel: onParcel || [],
      crossesParcel: Array.isArray(onParcel) && onParcel.length > 0,
      nearest,
      source: "USGS National Hydrography Dataset",
    };
  } catch {
    return null;
  }
}

/** Human phrasing for the report and note. */
export function hydroSummary(h) {
  if (!h) return null;
  if (h.crossesParcel) {
    const names = [...new Set(h.onParcel.map((x) => x.name).filter(Boolean))];
    return names.length
      ? `${names.join(", ")} crosses the parcel`
      : `A mapped stream crosses the parcel`;
  }
  if (h.nearest?.withinFeet) {
    return `No stream on the parcel; nearest (${h.nearest.name || "unnamed " + h.nearest.kind}) within ${h.nearest.withinFeet.toLocaleString()} ft`;
  }
  return "No mapped stream within 1/2 mile";
}
