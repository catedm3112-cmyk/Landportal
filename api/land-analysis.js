// api/land-analysis.js
// TruTerra Land Analysis Engine
// Trigger: GHL "Land Analysis" workflow webhook OR manual tag webhook.
// Flow: hydrate contact -> resolve parcel (Land Portal + TN boundaries, cross-
//       validated) -> confirm facts from the county assessor record -> adjoiners
//       -> Claude (web search) comps + valuation -> write custom fields -> status
//
// HARD RULE: this engine does not guess. Zoning, utilities, structures and sale
// history come from authoritative datasets or they are reported as unconfirmed
// with a named source to verify against. The LLM is given confirmed facts and is
// explicitly forbidden from inventing values for anything unconfirmed.
//
// Env required: GHL_API_KEY, ANTHROPIC_API_KEY, LAND_ANALYSIS_SECRET
// Optional: REPORT_BASE_URL (default https://landportal-coral.vercel.app)

import {
  resolveParcel,
  countyIntel,
  tnAdjoiners,
  buildFacts,
  confirmedOnly,
  unconfirmedList,
} from "../lib/parcel-intel.js";
import { terrainIntel } from "../lib/terrain.js";
import {
  radarConfigured,
  resolveProperty,
  ownerPortfolio,
} from "../lib/propertyradar.js";

const GHL_BASE = "https://services.leadconnectorhq.com";
const GHL_KEY = process.env.GHL_API_KEY;

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
  // Surface the real API failure instead of masking every error as "not found".
  if (!r.ok) throw new Error(`GHL ${r.status}: ${j?.message || "contact fetch failed"}`);
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

// ---------- Claude valuation ----------

function extractJson(text) {
  const clean = String(text || "").replace(/```json|```/g, "").trim();
  const start = clean.indexOf("{");
  const end = clean.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(clean.slice(start, end + 1));
}

async function callClaude(prompt) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 3000,
      messages: [{ role: "user", content: prompt }],
      tools: [{ type: "web_search_20250305", name: "web_search" }],
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(`Anthropic: ${j.error.message}`);
  return (j.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function buildPrompt({ facts, confirmed, unconfirmed, adjoiners, subject }) {
  const improved = facts.improved;
  const s = facts.structures;

  return `You are a Tennessee land valuation analyst for TruTerra Land Advisory preparing a client-facing opinion of value.

SUBJECT PROPERTY (confirmed from public records — treat as ground truth):
- Address: ${subject.address}, ${subject.county} County, TN
- Parcel: ${subject.apn} | Deeded acres: ${confirmed.acreage ?? "unknown"}
- Owner of record: ${confirmed.ownerOfRecord ?? "unknown"}
${Object.entries(confirmed)
  .filter(([k]) => !["acreage", "ownerOfRecord"].includes(k))
  .map(([k, v]) => `- ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
  .join("\n")}

IMPROVEMENTS: ${
    improved
      ? `THIS PARCEL IS IMPROVED — it is NOT raw land. Assessor record: ${s.count ?? "?"} building(s), type "${s.type ?? "unknown"}", built ${s.yearBuilt ?? "?"}, ${s.squareFeet ?? "?"} sq ft, ${s.stories ?? "?"} story, condition ${s.condition ?? "?"}, assessor improvement value $${(s.improvementValue ?? 0).toLocaleString()}.`
      : "No buildings found in the assessor record. Treat as vacant land."
  }

${
    facts.discrepancies?.length
      ? `SOURCE CONFLICTS on this parcel — the assessor record has been used, but you must carry these into internal_flags and lower confidence accordingly:\n- ${facts.discrepancies.join("\n- ")}\n`
      : ""
  }
UNCONFIRMED FIELDS — you must NOT invent values for these: ${unconfirmed.length ? unconfirmed.join("; ") : "(none)"}

Adjoining parcels (owner | acres): ${adjoiners.map((x) => `${x.owner} | ${x.acres} ac`).join("; ") || "(none found)"}

TASK
1. Search the web for comparable properties in the immediate corridor (same road, same zip, or adjacent zips). ${
    improved
      ? "Because the subject is IMPROVED, prioritise comparable IMPROVED residential sales of similar acreage — do NOT value this as raw land. Then state the land component and the improvement contribution separately."
      : "Prioritise vacant-land comparables of similar acreage."
  }
2. Strongly prefer SOLD comparables over active listings. Label each comp's status honestly as "sold", "under_contract" or "active". Active listings are asking prices, not evidence of value.
3. Produce a conservative broker-opinion value range for the subject.
4. Weigh the confirmed physical constraints above (slope, road frontage, access, flood coverage) in the range. High average slope materially limits buildable area and subdivision potential in East Tennessee — do not suggest subdivision unless slope and road frontage plausibly support it.
5. Write a "strategic note" for the client. Never name private adjoining owners — describe them generically (e.g. "a neighbouring owner holds roughly 20 acres").

ABSOLUTE RULES
- NEVER use the words "likely", "probably", or "assumed" about zoning, utilities, or structures. Those are either confirmed above or listed as unconfirmed.
- For any unconfirmed field, set it to null in your JSON. Do not guess. The report will print the verification source instead.
- Do not contradict a confirmed fact. If a comp or source disagrees with a confirmed fact, note it in internal_flags.

Respond with ONLY valid JSON, no markdown fences, no commentary. Escape all quotes inside strings.
{
 "value_low": <number>, "value_high": <number>,
 "valuation_basis": "as-improved" | "land-only",
 "land_value_low": <number|null>, "land_value_high": <number|null>,
 "improvement_contribution": <number|null>,
 "comps": [{"location":"","desc":"","price":"$X","per_acre":"$Xk / acre","status":"sold|under_contract|active","sale_date":"<or null>"}],
 "comp_quality": {"sold_count": <number>, "active_count": <number>, "spread_ratio": <number>, "note": ""},
 "market_note": "<1-2 sentences on the per-acre curve for this size and corridor>",
 "strategic_note": "<client-safe paragraph, no private owner names>",
 "confidence": "high|medium|low",
 "internal_flags": "<what Dillon must verify before approving>"
}`;
}

async function runValuation(ctx) {
  const prompt = buildPrompt(ctx);
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const text = await callClaude(
        attempt === 1
          ? prompt
          : `${prompt}\n\nYOUR PREVIOUS RESPONSE WAS NOT PARSEABLE JSON (${lastErr}). Return ONLY the JSON object. Escape every internal quote.`
      );
      return extractJson(text);
    } catch (e) {
      lastErr = e.message;
    }
  }
  throw new Error(`valuation failed after 3 attempts: ${lastErr}`);
}

// Guardrail: a wide comp spread or an all-active comp set caps confidence.
function applyCompGuardrails(val) {
  const q = val.comp_quality || {};
  const comps = val.comps || [];
  const sold = q.sold_count ?? comps.filter((c) => c.status === "sold").length;
  const spread = q.spread_ratio ?? null;
  const notes = [];
  if (sold === 0) {
    notes.push("No sold comparables — range is derived from asking prices only.");
    val.confidence = "low";
  }
  if (spread && spread > 2) {
    notes.push(`Comparable spread is ${spread}x — corridor pricing is not tight.`);
    if (val.confidence === "high") val.confidence = "medium";
  }
  if (notes.length) {
    val.internal_flags = `${notes.join(" ")} ${val.internal_flags || ""}`.trim();
  }
  return val;
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

    const apn = req.body?.apn || cfValue(contact, "property_address_or_apn");
    const fullAddr = req.body?.address || cfValue(contact, "full_property_address");
    const county = req.body?.county || cfValue(contact, "county");

    // --- PropertyRadar first: current ownership AND the coordinates that drive
    // every county lookup. Running it ahead of resolveParcel means a Land Portal
    // outage or exhausted quota degrades one enrichment source instead of
    // collapsing the whole fact chain.
    // PropertyRadar's Address criteria matches the street line only — passing a
    // full "street, city, ST zip" string returns zero results.
    const parts = String(fullAddr || apn || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const zipMatch = String(fullAddr || "").match(/\b(\d{5})\b/);
    const radarAddress = parts[0] || null;
    const radarCity =
      (parts[1] && !/^[A-Z]{2}$/i.test(parts[1]) && !/\d/.test(parts[1]) ? parts[1] : null) ||
      cfValue(contact, "city") ||
      null;

    let radar = null;
    if (radarConfigured() && radarAddress) {
      try {
        const found = await resolveProperty({
          address: radarAddress,
          city: radarCity,
          state: "TN",
          zip: zipMatch ? zipMatch[1] : null,
        });
        if (found.matched && found.property?.RadarID) {
          const portfolio = await ownerPortfolio(found.property.RadarID);
          radar = { property: found.property, ...portfolio };
        } else {
          radar = { unmatched: true, count: found.count, ambiguous: found.ambiguous || false };
        }
      } catch (e) {
        radar = { error: e.message };
      }
    }

    const radarHint = radar?.property
      ? {
          lat: Number(radar.property.Latitude) || null,
          lng: Number(radar.property.Longitude) || null,
          apn: radar.property.APN || null,
        }
      : null;

    // --- resolve, cross-validated ---
    const resolved = await resolveParcel({
      apn,
      address: fullAddr || apn,
      county,
      hint: radarHint,
    });

    if (!resolved.ok || resolved.confidence < 60) {
      await updateContactFields(contactId, { [CF.status]: "needs-parcel" });
      await addNote(
        contactId,
        `LAND ANALYSIS — PARCEL NOT CONFIRMED for "${apn || fullAddr}".\n` +
          `Confidence: ${resolved.confidence}. ${resolved.issues.join(" ")}\n` +
          (resolved.candidates.length
            ? `Closest candidates:\n${resolved.candidates
                .map((c) => `  • ${c.apn} | ${c.owner} | ${c.street}, ${c.city} (${c.county}) | ${c.acres} ac | score ${c.score}`)
                .join("\n")}\n`
            : "") +
          `No analysis was produced. Confirm the parcel, then re-run.`
      );
      return res.status(200).json({
        ok: false,
        reason: "parcel-unconfirmed",
        confidence: resolved.confidence,
        candidates: resolved.candidates,
      });
    }

    const countyName =
      resolved.lp?.situsCounty ||
      resolved.tn?.attributes?.COUNTY_NAME ||
      radar?.property?.County ||
      county ||
      null;

    // --- confirm facts from whatever county sources are registered ---
    const intel = await countyIntel(countyName, resolved.lat, resolved.lng);

    // Slope from USGS over the real parcel polygon; sewer/hydrant/flood from
    // TruTerra's own Sevier County GIS exports. No vendor quota involved.
    const terrain = await terrainIntel({
      rings: resolved.tn?.geometry?.rings || null,
      lat: resolved.lat,
      lng: resolved.lng,
      county: countyName,
    });

    const facts = buildFacts({ lp: resolved.lp, intel, countyName, radar, terrain });
    const confirmed = confirmedOnly(facts);
    const unconfirmed = unconfirmedList(facts);

    const adjoiners = resolved.tn ? await tnAdjoiners(resolved.tn) : [];

    const address =
      resolved.tn?.attributes?.ADDRESS || resolved.lp?.situsAddress || fullAddr || apn;

    const val = applyCompGuardrails(
      await runValuation({
        facts,
        confirmed,
        unconfirmed,
        adjoiners,
        subject: { address, county: countyName, apn: resolved.apn },
      })
    );

    const report = {
      generated: new Date().toISOString(),
      prepared_for: `${contact.firstName || ""} ${contact.lastName || ""}`.trim(),
      address,
      county: countyName,
      parcel_id: resolved.apn,
      acres: confirmed.acreage ?? null,
      owner: confirmed.ownerOfRecord ?? null,
      match: {
        method: resolved.method,
        confidence: resolved.confidence,
        issues: resolved.issues,
      },
      facts,
      improved: facts.improved,
      structures: facts.structures,
      unconfirmed,
      adjoiners,
      ...val,
    };

    const reportUrl = `${base}/r/${contactId}`;
    const range = `$${Math.round(val.value_low / 1000)}K – $${Math.round(val.value_high / 1000)}K`;
    const status = resolved.confidence === 100 ? "ready" : "ready-needs-review";

    await updateContactFields(contactId, {
      [CF.json]: JSON.stringify(report),
      [CF.reportUrl]: reportUrl,
      [CF.valueRange]: range,
      [CF.status]: status,
    });

    // Owner-vs-lead mismatch is a material intake issue — always surface it.
    const leadName = `${contact.firstName || ""} ${contact.lastName || ""}`.trim().toUpperCase();
    const ownerName = String(confirmed.ownerOfRecord || "").toUpperCase();
    const lastName = String(contact.lastName || "").toUpperCase();
    const nameMismatch =
      ownerName && lastName && !ownerName.includes(lastName)
        ? `⚠ Lead name "${leadName}" does not match owner of record "${ownerName}". Confirm authority to sell.`
        : "";

    await addNote(
      contactId,
      [
        `LAND ANALYSIS ${status === "ready" ? "READY" : "READY (REVIEW MATCH)"} — ${address} (${countyName} Co.)`,
        `${confirmed.acreage ?? "?"} ac | Parcel ${resolved.apn} | Range ${range} (${val.valuation_basis}) | Confidence: ${val.confidence}`,
        facts.improved
          ? `IMPROVED: ${facts.structures.count ?? "?"} bldg, ${facts.structures.type ?? "?"}, built ${facts.structures.yearBuilt ?? "?"}, ${facts.structures.squareFeet ?? "?"} sqft (assessor imp. value $${(facts.structures.improvementValue ?? 0).toLocaleString()})`
          : `VACANT: no buildings in assessor record`,
        `Zoning: ${facts.zoning.confirmed ? `${facts.zoning.value} (confirmed — ${facts.zoning.source})` : `NOT CONFIRMED — verify with ${facts.zoning.verifyWith}`}`,
        `Utilities: water ${facts.water.value ?? "unconfirmed"} | sewer ${facts.sewer.value ?? "unconfirmed"} | electric ${facts.electric.value ?? "unconfirmed"}`,
        facts.sewerDistanceFeet.confirmed || facts.slopeAverage.confirmed
          ? `Terrain/utilities: ${facts.slopeAverage.confirmed ? `slope ${facts.slopeAverage.value}% avg grade (${facts.slopeDegreesMean.value}°), max ${facts.slopeMax.value}%` : "slope unconfirmed"}` +
            `${facts.sewerDistanceFeet.confirmed ? ` | nearest sewer manhole ${facts.sewerDistanceFeet.value} ft` : ""}` +
            `${facts.hydrantDistanceFeet.confirmed ? ` | nearest hydrant ${facts.hydrantDistanceFeet.value} ft` : ""}` +
            `${facts.floodplain100yr.confirmed ? ` | ${facts.floodplain100yr.value}` : ""}`
          : "",
        confirmed.lastSale ? `Last sale: $${confirmed.lastSale.price?.toLocaleString()} on ${confirmed.lastSale.date}` : "",
        nameMismatch,
        `Parcel match: ${resolved.confidence}% (${resolved.method})${resolved.issues.length ? ` — ${resolved.issues.join(" ")}` : ""}`,
        intel.configured
          ? ""
          : `NOTE: ${countyName} County has no registered GIS source, so zoning/utilities/buildings could not be confirmed from public records. Add a source in lib/parcel-intel.js COUNTY_SOURCES to enable it.`,
        facts.currentOwner.confirmed
          ? `Current owner (PropertyRadar): ${facts.currentOwner.value}${facts.freeAndClear.value === true ? " | FREE & CLEAR (no loan)" : ""}${facts.distressScore.value && facts.distressScore.value !== "0" ? ` | distress score ${facts.distressScore.value}` : ""}`
          : "",
        facts.ownerPortfolio.confirmed
          ? `OWNER PORTFOLIO — ${facts.ownerPortfolio.value.totalParcels} parcel(s) total${facts.ownerPortfolio.value.age ? `, owner age ${facts.ownerPortfolio.value.age}` : ""}${facts.ownerPortfolio.value.mailAddress ? `, mails to ${facts.ownerPortfolio.value.mailAddress}` : ""}:\n` +
            `  1. ${address} (subject)\n` +
            facts.ownerPortfolio.value.otherParcels
              .map((p, i) => `  ${i + 2}. ${p.address}`)
              .join("\n")
          : "",
        facts.discrepancies?.length ? `⚠ SOURCE CONFLICTS:\n  - ${facts.discrepancies.join("\n  - ")}` : "",
        `Unconfirmed: ${unconfirmed.length ? unconfirmed.join("; ") : "none"}`,
        `Flags: ${val.internal_flags || "none"}`,
        `Report: ${reportUrl}`,
        `Approve by adding tag: send-land-analysis`,
      ]
        .filter(Boolean)
        .join("\n")
    );

    return res.status(200).json({
      ok: true,
      reportUrl,
      range,
      basis: val.valuation_basis,
      improved: facts.improved,
      matchConfidence: resolved.confidence,
    });
  } catch (err) {
    await updateContactFields(contactId, { [CF.status]: "error" }).catch(() => {});
    await addNote(contactId, `LAND ANALYSIS ENGINE ERROR: ${err.message}`).catch(() => {});
    return res.status(500).json({ ok: false, error: err.message });
  }
};
