// api/radar-probe.js
// Secret-guarded diagnostic for the PropertyRadar API.
//
// Defaults to Purchase=0 (count only, free, no quota impact). Spending an
// export requires an explicit "purchase": true in the body, so this can be
// used to explore criteria and response shapes without burning records.
//
// Examples:
//   {"address":"124 Mays Ln","city":"Sevierville","state":"TN"}        -> count
//   {"address":"124 Mays Ln","city":"Sevierville","purchase":true}      -> 1 export
//   {"owner":"WILSON GLADYS","state":"TN"}                              -> portfolio count
//   {"criteria":[{"name":"APN","value":["048-094.02"]}]}                -> raw criteria

import {
  radarConfigured,
  searchProperties,
  byAddress,
  byApn,
  byOwnerName,
  summarizeProperty,
} from "../lib/propertyradar.js";

export default async (req, res) => {
  if ((req.query.key || "") !== process.env.LAND_ANALYSIS_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!radarConfigured()) {
    return res.status(500).json({ error: "PropertyRadar token not configured" });
  }

  const b = req.body || {};
  const purchase = b.purchase === true;

  // Raw path escape hatch — lets us discover endpoints (e.g. the Persons model
  // that links an owner to every property they hold) without guessing.
  if (b.path) {
    try {
      const t =
        process.env.PropertyRadarapi ||
        process.env.PROPERTY_RADAR_TOKEN ||
        process.env.PROPERTYRADAR_API_KEY;
      const qs = new URLSearchParams({ Purchase: String(purchase ? 1 : 0) });
      if (b.limit != null) qs.set("Limit", String(b.limit));
      if (b.fields) qs.set("Fields", b.fields);
      const url = `https://api.propertyradar.com/v1${b.path}?${qs}`;
      const rr = await fetch(url, {
        method: b.method || "GET",
        headers: {
          Authorization: `Bearer ${t}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: b.method === "POST" ? JSON.stringify(b.body || {}) : undefined,
      });
      const txt = await rr.text();
      let parsed;
      try {
        parsed = JSON.parse(txt);
      } catch {
        parsed = { nonJson: txt.slice(0, 400) };
      }
      return res.status(200).json({ ok: rr.ok, status: rr.status, url, response: parsed });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  let criteria;
  if (Array.isArray(b.criteria)) criteria = b.criteria;
  else if (b.apn) criteria = byApn(b.apn, b.state || "TN");
  else if (b.owner) criteria = byOwnerName(b.owner, b.state || "TN");
  else if (b.address)
    criteria = byAddress({ address: b.address, city: b.city, state: b.state || "TN", zip: b.zip });
  else return res.status(400).json({ error: "supply address, apn, owner, or criteria" });

  try {
    const raw = await searchProperties(criteria, {
      purchase,
      limit: b.limit ?? (purchase ? 10 : undefined),
      fields: b.fields,
    });
    const rows = raw?.results || raw?.Results || raw?.data || [];
    return res.status(200).json({
      ok: true,
      purchased: purchase,
      criteria,
      topLevelKeys: Object.keys(raw || {}),
      count: raw?.totalResultCount ?? raw?.totalCount ?? raw?.resultCount ?? rows.length,
      freeRemaining: raw?.quantityFreeRemaining ?? null,
      cost: raw?.totalCost ?? null,
      rowCount: rows.length,
      firstRowKeys: rows[0] ? Object.keys(rows[0]) : [],
      summarized: rows.slice(0, 10).map(summarizeProperty),
      raw: b.raw === true ? raw : undefined,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message, criteria });
  }
};
