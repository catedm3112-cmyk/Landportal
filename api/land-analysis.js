// api/land-analysis.js
// TruTerra Land Analysis Engine
// Trigger: GHL "Land Analysis" workflow webhook OR manual tag webhook.
// Flow: hydrate contact -> resolve parcel (TN statewide) -> adjoiners ->
//       Claude (web search) comps + valuation -> write custom fields -> status "ready"
//
// Env required (existing): GHL_API_KEY, ANTHROPIC_API_KEY
// Env NEW: LAND_ANALYSIS_SECRET (any random string; used as ?key= on the webhook URL)
// Optional: REPORT_BASE_URL (default https://landportal-coral.vercel.app)

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_KEY = process.env.GHL_API_KEY;
const LOCATION_ID = "EHl75N7YlN7nOMP30CYm"; // TruTerra
const TN_PARCELS =
  "https://services1.arcgis.com/YuVBSS7Y1of2Qud1/arcgis/rest/services/Tennessee_Property_Boundaries_Public_Use/FeatureServer/0/query";

// Custom field IDs (created 2026-07-28 via API)
const CF = {
  reportUrl: "gjiHDIBFPD7orJJ4Zu8C",
  valueRange: "ESSwcgMa05dRJbCkfDnY",
  status: "v38gufyBCk4NQWps4kua",
  json: "u1nD05qbxNDboQQgsnrH",
};

const ghlHeaders = {
  Authorization: `Bearer ${GHL_KEY}`,
  Version: "2021-07-28",
  "Content-Type": "application/json",
};

async function getContact(contactId) {
  const r = await fetch(`${GHL_BASE}/contacts/${contactId}`, { headers: ghlHeaders });
  const j = await r.json();
  return j.contact || null;
}

function cfValue(contact, key) {
  const f = (contact.customFields || []).find(
    (x) => x.id === key || (x.fieldKey || "").endsWith(key)
  );
  return f ? f.value : null;
}

async function updateContactFields(contactId, fields) {
  await fetch(`${GHL_BASE}/contacts/${contactId}`, {
    method: "PUT",
    headers: ghlHeaders,
    body: JSON.stringify({
      customFields: Object.entries(fields).map(([id, value]) => ({ id, value })),
    }),
  });
}

async function addNote(contactId, body) {
  await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: ghlHeaders,
    body: JSON.stringify({ body, userId: "vEkFZMkHecUPXltiehzW" }),
  });
}

// ---------- Parcel resolution (TN statewide, free/unmetered) ----------

async function queryParcels(where, geometry) {
  const params = new URLSearchParams({
    where: where || "1=1",
    outFields: "PARCELID,CMAP,PARCEL,ADDRESS,DEEDAC,OWNER,OWNER2,COUNTY_NAME,GISLINK",
    returnGeometry: "true",
    outSR: "4326",
    f: "json",
  });
  if (geometry) {
    params.set("geometry", JSON.stringify(geometry));
    params.set("geometryType", "esriGeometryPolygon");
    params.set("inSR", "4326");
    params.set("spatialRel", "esriSpatialRelIntersects");
  }
  const r = await fetch(`${TN_PARCELS}?${params}`);
  const j = await r.json();
  return j.features || [];
}

function parseApn(raw) {
  // "032-026.07-000" | "032 026.07" | "032-026.07"
  const m = String(raw || "").match(/(\d{3})[\s-]+(\d{3}\.?\d*)/);
  return m ? { cmap: m[1], parcel: m[2] } : null;
}

function parseAddress(raw) {
  // "422 County Line Rd, Dandridge TN" -> num=422, road=COUNTY LINE
  const m = String(raw || "").match(/^(\d+)\s+(.+?)(?:\s+(?:RD|ROAD|DR|DRIVE|LN|LANE|HWY|WAY|CIR|CT|PIKE|TRL))?\s*(?:,|$)/i);
  if (!m) return null;
  return { num: m[1], road: m[2].toUpperCase().replace(/\s+(RD|ROAD|DR|LN|HWY|WAY|CIR|CT|PIKE|TRL)\.?$/i, "").trim() };
}

async function resolveParcel(apnRaw, addressRaw, county) {
  const apn = parseApn(apnRaw);
  const addr = parseAddress(addressRaw);
  if (apn) {
    const feats = await queryParcels(
      `CMAP='${apn.cmap}' AND PARCEL LIKE '${apn.parcel}%'` +
        (county ? ` AND UPPER(COUNTY_NAME)='${county.toUpperCase()}'` : "")
    );
    if (feats.length === 1) return feats[0];
    if (feats.length > 1) {
      // Disambiguate multi-county APN hits by road name if we have one
      if (addr) {
        const match = feats.find((f) =>
          (f.attributes.ADDRESS || "").toUpperCase().includes(addr.road)
        );
        if (match) return match;
      }
      if (county) return feats[0];
    }
  }
  if (addr) {
    // TN layer format: "COUNTY LINE RD 422" — number is LAST, so end-anchor it
    // (LIKE '% 422' with no trailing % only matches strings ENDING in " 422",
    //  which prevents the 422-vs-4226 false match caught in pre-deploy testing)
    const feats = await queryParcels(
      `UPPER(ADDRESS) LIKE '%${addr.road}%' AND UPPER(ADDRESS) LIKE '% ${addr.num}'` +
        (county ? ` AND UPPER(COUNTY_NAME)='${county.toUpperCase()}'` : "")
    );
    if (feats.length === 1) return feats[0];
    if (feats.length > 1 && county) return feats[0];
  }
  return null;
}

async function getAdjoiners(subjectFeature) {
  const geom = { ...subjectFeature.geometry, spatialReference: { wkid: 4326 } };
  const feats = await queryParcels(null, geom);
  const subjId = subjectFeature.attributes.PARCELID;
  return feats
    .filter((f) => f.attributes.PARCELID !== subjId)
    .map((f) => ({
      owner: `${(f.attributes.OWNER || "").trim()} ${(f.attributes.OWNER2 || "").trim()}`.trim(),
      address: (f.attributes.ADDRESS || "").trim(),
      acres: f.attributes.DEEDAC,
    }));
}

// ---------- Claude valuation (web search for live comps) ----------

async function runValuation({ parcel, adjoiners, contactName }) {
  const a = parcel.attributes;
  const prompt = `You are a Tennessee land valuation analyst for TruTerra Land Advisory.
Subject property:
- Address: ${a.ADDRESS}, ${a.COUNTY_NAME} County, TN
- Parcel: ${a.CMAP}-${a.PARCEL} | Deeded acres: ${a.DEEDAC}
- Owner of record: ${(a.OWNER || "").trim()} ${(a.OWNER2 || "").trim()}
Adjoining parcels (owner | acres): ${adjoiners.map((x) => `${x.owner} | ${x.acres} ac`).join("; ")}

TASK: Search the web for 3 current comparable land listings/sales in the immediate corridor (same road, same zip, or adjacent zips). Then produce a conservative broker-opinion value range for the subject.
Also analyze the adjoiner list for a "strategic note": large single owners surrounding the parcel, corporate/institutional neighbors, or assemblage angles. If nothing notable, note the general buyer profile for the corridor instead. Never name private adjoining owners in client-facing text — describe them generically.

Respond with ONLY valid JSON, no markdown fences:
{
 "value_low": <number>, "value_high": <number>,
 "comps": [{"location":"","desc":"","price":"$X","per_acre":"$Xk / acre"}],
 "market_note": "<1-2 sentence per-acre curve explanation for this size>",
 "strategic_note": "<client-safe paragraph>",
 "facts": {"acreage":"","zoning_guess":"","utilities_guess":""},
 "confidence": "high|medium|low",
 "internal_flags": "<anything Dillon should verify before approving>"
}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 2000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const j = await r.json();
  const text = (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
  const clean = text.replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  return JSON.parse(clean.slice(start, end + 1));
}

// ---------- Handler ----------

export default async (req, res) => {
  if ((req.query.key || "") !== process.env.LAND_ANALYSIS_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const contactId =
    req.body?.contactId || req.body?.contact_id || req.query.contactId;
  if (!contactId) return res.status(400).json({ error: "contactId required" });

  const base = process.env.REPORT_BASE_URL || "https://landportal-coral.vercel.app";

  try {
    await updateContactFields(contactId, { [CF.status]: "processing" });

    const contact = await getContact(contactId);
    if (!contact) throw new Error("contact not found");
    // Body overrides support manual runs when the contact record lacks property data
    const apn = req.body?.apn || cfValue(contact, "property_address_or_apn");
    const fullAddr = req.body?.address || cfValue(contact, "full_property_address");
    const county = req.body?.county || cfValue(contact, "county");

    const parcel = await resolveParcel(apn, fullAddr || apn, county);
    if (!parcel) {
      await updateContactFields(contactId, { [CF.status]: "needs-parcel" });
      await addNote(contactId, `LAND ANALYSIS ENGINE: could not resolve parcel from "${apn || fullAddr}". Verify APN/address and re-tag run-land-analysis.`);
      return res.status(200).json({ ok: false, reason: "parcel-unresolved" });
    }

    const adjoiners = await getAdjoiners(parcel);
    const val = await runValuation({ parcel, adjoiners, contactName: contact.firstName });

    const a = parcel.attributes;
    const report = {
      generated: new Date().toISOString(),
      prepared_for: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      address: a.ADDRESS,
      county: a.COUNTY_NAME,
      parcel_id: `${a.CMAP}-${a.PARCEL}`,
      acres: a.DEEDAC,
      owner: `${(a.OWNER || "").trim()} ${(a.OWNER2 || "").trim()}`.trim(),
      adjoiners,
      ...val,
    };

    const reportUrl = `${base}/r/${contactId}`;
    const range = `$${Math.round(val.value_low / 1000)}K – $${Math.round(val.value_high / 1000)}K`;

    await updateContactFields(contactId, {
      [CF.json]: JSON.stringify(report),
      [CF.reportUrl]: reportUrl,
      [CF.valueRange]: range,
      [CF.status]: "ready",
    });

    await addNote(
      contactId,
      `LAND ANALYSIS READY — ${a.ADDRESS} (${a.COUNTY_NAME} Co.) | ${a.DEEDAC} ac | Range ${range} | Confidence: ${val.confidence}\nFlags: ${val.internal_flags || "none"}\nReport: ${reportUrl}\nApprove by adding tag: send-land-analysis`
    );

    return res.status(200).json({ ok: true, reportUrl, range });
  } catch (err) {
    await updateContactFields(contactId, { [CF.status]: "error" }).catch(() => {});
    await addNote(contactId, `LAND ANALYSIS ENGINE ERROR: ${err.message}`).catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
