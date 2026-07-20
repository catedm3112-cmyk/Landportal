/**
 * TruTerra Lead Analyzer + AI Classifier  —  Land Portal API v2
 * Vercel Serverless Function
 *
 * Two entry points on one endpoint:
 *
 *   POST  /api/analyze-lead   ← GHL webhook (Contact Created / Form Submitted)
 *         Flow: classify lead → tag → create opportunity → (seller) resolve
 *         parcel → synthesize note → post note back to the GHL contact.
 *
 *   GET   /api/analyze-lead?apn=...&state=TN        ← manual, ad-hoc lookup
 *         /api/analyze-lead?address=123 Main St, Sevierville TN
 *         /api/analyze-lead?propertyId=78723946
 *         /api/analyze-lead?lat=35.86&lng=-83.56
 *         Returns the full parcel analysis as JSON. No GHL contact required.
 *         Optionally pass &contactId=... to also post the note into GHL.
 */

import {
  searchAndFetchProperty,
  getPropertyByPoint,
  getPropertyDetail,
  searchProperties,
  normalizeProperty,
} from "../lib/landportal.js";

const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = "https://services.leadconnectorhq.com";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const LOCATION_ID = "EHl75N7YlN7nOMP30CYm";

// User IDs
const USERS = {
  dillon: "xl8mtehpGgd8hQuVXGVk",
  chris: "hCiuXELpRegkI5QKa7si",
};

// Pipeline IDs
const PIPELINES = {
  leadIntake: "zKKnLmipjyXZhMEUUL75",
  sellerLandowner: "zwaDzNE5FxCZfPRvNS4l",
  investorBuyer: "q1LsHftvluT7thkSyZrH",
};

// Stage IDs (New Lead stage in each pipeline)
const STAGES = {
  leadIntake_newLead: "2a395b97-de89-4af4-be8d-adcc3a69b8b4",
  seller_newLead: "f6963f0b-00c3-42c9-8c28-9b9b4aee1727",
  investor_newLead: "8788325f-d60e-4475-ac9a-b9c14884cb2f",
};

// ─── ROUND ROBIN ─────────────────────────────────────────────────────────────

function roundRobin(contactId) {
  const sum = contactId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return sum % 2 === 0 ? USERS.dillon : USERS.chris;
}

// ─── ROBUST JSON + RULE-BASED FALLBACK ───────────────────────────────────────

// Models sometimes wrap JSON in ```fences``` or add a short preamble; pull the
// JSON object out cleanly instead of trusting JSON.parse on the raw text.
function extractJson(text) {
  let t = String(text).trim();
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

function isFacebookLead(c) {
  const src = (c.source || "").toLowerCase();
  const a = c.attributionSource || {};
  return /facebook|fb|paid social/.test(src) ||
    /facebook/i.test(a.medium || "") ||
    /facebook/i.test(a.adSource || "") ||
    !!a.formId || !!a.formName;
}

// Deterministic classifier used when the AI call fails. A Facebook land-form
// lead — especially one with a submitted address — is unambiguously a seller
// prospect. Never let an AI hiccup bury a real lead in "unclassified".
function ruleClassify(contact) {
  const fb = isFacebookLead(contact);
  const hasAddress = !!(contact.propertyAddress && String(contact.propertyAddress).trim());
  const source_tag = fb ? "src:facebook-lead" : "src:unknown";
  if (fb || hasAddress) {
    return {
      type: "seller-prospect",
      confidence: "low",
      source_tag,
      campaign_tag: "campaign:truterra",
      pipeline: "leadIntake",
      run_parcel_analysis: hasAddress,
      reasoning: "Rule-based fallback (AI classifier unavailable): Facebook land-form lead" +
        (hasAddress ? " with a submitted property address" : ""),
      flags: ["ai-classifier-fallback"],
    };
  }
  return {
    type: "unclassified",
    confidence: "low",
    source_tag,
    campaign_tag: "campaign:truterra",
    pipeline: "leadIntake",
    run_parcel_analysis: false,
    reasoning: "Rule-based fallback: insufficient signals to classify",
    flags: ["needs-manual-review"],
  };
}

// ─── AI CLASSIFIER ───────────────────────────────────────────────────────────

async function classifyLead(contact) {
  const prompt = `You are a lead classifier for TruTerra Group, a land acquisition, brokerage, and construction company in Sevier County, Tennessee.

Analyze the following contact data and return a JSON classification decision. Use ONLY the data provided — do not infer or assume anything not present.

CONTACT DATA:
${JSON.stringify(contact, null, 2)}

Return ONLY a valid JSON object in this exact format, no other text:
{
  "type": "seller-prospect" | "buyer-investor" | "social-engagement" | "not-a-lead" | "unclassified",
  "confidence": "high" | "medium" | "low",
  "source_tag": "src:facebook-lead" | "src:facebook-comment" | "src:website-form" | "src:google-lead" | "src:direct" | "src:unknown",
  "campaign_tag": "campaign:truterra" | "campaign:unknown",
  "pipeline": "leadIntake" | "investorBuyer" | "none",
  "run_parcel_analysis": true | false,
  "reasoning": "one sentence explanation of why you classified this way based only on available data",
  "flags": []
}

Classification rules:
- seller-prospect: contact submitted a property address, asked about market value, wants to sell land, or came from a Facebook/Google lead form with property details. Set run_parcel_analysis to true.
- buyer-investor: contact expressed interest in buying land, investing, or building. No property to sell. Set run_parcel_analysis to false.
- social-engagement: came from a Facebook/Instagram comment or DM with no clear buying or selling intent. Set run_parcel_analysis to false. Pipeline: none.
- not-a-lead: clearly a vendor, spam, realtor solicitation, or internal test contact. Set run_parcel_analysis to false. Pipeline: none.
- unclassified: insufficient context to determine intent confidently. Set run_parcel_analysis to false. Pipeline: leadIntake. Add "needs-manual-review" to flags.

For flags, include any of: "no-property-address", "no-email", "no-phone", "out-of-state-property", "absentee-owner-likely", "needs-manual-review", "duplicate-suspected"

Set confidence to "low" if you are uncertain. Never assume type from pipeline placement alone.`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY.trim(),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    if (json.error) {
      console.error("Anthropic API error:", res.status, JSON.stringify(json.error));
      throw new Error(`Anthropic API ${res.status}: ${json.error?.message || "unknown"}`);
    }
    const text = json.content?.[0]?.text?.trim();
    if (!text) throw new Error("No classifier response");

    const classification = extractJson(text);
    // A Facebook lead-form contact is always src:facebook-lead, even if the
    // model guessed otherwise.
    if (isFacebookLead(contact) && classification.source_tag === "src:unknown") {
      classification.source_tag = "src:facebook-lead";
    }
    console.log("Classification:", JSON.stringify(classification));
    return classification;
  } catch (err) {
    console.error("Classifier error:", err.message);
    // Resilient fallback — classify from known signals instead of dumping
    // every lead into manual-review limbo.
    return ruleClassify(contact);
  }
}

// ─── GHL HELPERS ─────────────────────────────────────────────────────────────

async function ghlAddTags(contactId, tags) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tags`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({ tags }),
  });
  return res.json();
}

async function ghlCreateOpportunity(contactId, contactName, pipelineId, stageId, assignedTo) {
  const res = await fetch(`${GHL_BASE}/opportunities/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({
      pipelineId,
      locationId: LOCATION_ID,
      name: contactName,
      pipelineStageId: stageId,
      status: "open",
      contactId,
      assignedTo,
    }),
  });
  return res.json();
}

async function ghlAddNote(contactId, body) {
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/notes`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({ body }),
  });
  return res.json();
}

// ─── PARCEL RESOLUTION (Land Portal v2) ────────────────────────────────────────

async function geocodeAddress(street, city, state, zip) {
  const pick = (j) => {
    const m = j?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lng: m.coordinates.x, matchedAddress: m.matchedAddress } : null;
  };

  // Try the one-line geocoder first — it handles free-typed addresses like
  // "7331 East Emory Rd Corryton TN" far better than the component endpoint,
  // which needs the town split out of the street and otherwise returns 0.
  const oneline = [street, city, state, zip].filter(Boolean).join(" ").trim();
  if (oneline) {
    try {
      const p = new URLSearchParams({ address: oneline, benchmark: "2020", format: "json" });
      const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${p}`);
      const hit = pick(await r.json().catch(() => null));
      if (hit) return hit;
    } catch { /* fall through to component endpoint */ }
  }

  // Fallback: component endpoint (works when street/city are cleanly split).
  const params = new URLSearchParams({ benchmark: "2020", format: "json" });
  if (street) params.set("street", street);
  if (city) params.set("city", city);
  if (state) params.set("state", state);
  if (zip) params.set("zip", zip);
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/address?${params}`);
  return pick(await res.json().catch(() => null));
}

// An APN tends to be a short token of digits/dashes/dots with no street words.
function looksLikeApn(str) {
  if (!str) return false;
  const s = str.trim();
  if (/\d/.test(s) === false) return false;
  if (/,/.test(s)) return false;
  if (/\b(st|street|rd|road|ave|avenue|dr|drive|ln|lane|hwy|highway|blvd|ct|court|way|pike|trail|cir|circle)\b/i.test(s)) return false;
  // Mostly digits, dashes, dots, occasional letters; short.
  return /^[A-Za-z0-9.\-\s]{4,30}$/.test(s) && (s.match(/\d/g) || []).length >= 3;
}

/**
 * Resolve a parcel from any input.
 * Returns { property (normalized | null), matchType, geo, raw }.
 */
async function resolveParcel({ apn, address, propertyId, lat, lng, state = "TN" }) {
  // Direct property_id
  if (propertyId) {
    const detail = await getPropertyDetail(propertyId);
    return { property: detail.property ? normalizeProperty(detail.property) : null, matchType: "property_id", geo: null };
  }

  // Explicit coordinates
  if (lat != null && lng != null) {
    const { feature } = await getPropertyByPoint(lat, lng);
    const match = feature?.properties;
    if (!match?.property_id) return { property: null, matchType: "point", geo: { lat, lng } };
    const detail = await getPropertyDetail(match.property_id);
    return { property: normalizeProperty(detail.property, match), matchType: "point", geo: { lat, lng } };
  }

  // APN search → detail (precise)
  if (apn) {
    const { features } = await searchProperties({ apn, state });
    const match = features[0]?.properties;
    if (match?.property_id) {
      const detail = await getPropertyDetail(match.property_id);
      return { property: normalizeProperty(detail.property, match), matchType: "apn", geo: null };
    }
    return { property: null, matchType: "apn", geo: null };
  }

  // Address → geocode → point lookup (v2 text address search is unreliable, so
  // resolve the address to coordinates first, then ask Land Portal what's there).
  if (address) {
    if (looksLikeApn(address)) {
      const r = await resolveParcel({ apn: address, state });
      if (r.property) return r;
    }
    const parts = address.replace(/,/g, " ").trim().split(/\s+/);
    const zip = /^\d{5}$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : "";
    const geo = await geocodeAddress(address, "", state, zip);
    if (geo?.lat && geo?.lng) {
      const { feature } = await getPropertyByPoint(geo.lat, geo.lng);
      const match = feature?.properties;
      if (match?.property_id) {
        const detail = await getPropertyDetail(match.property_id);
        return { property: normalizeProperty(detail.property, match), matchType: "address_point", geo };
      }
    }
    return { property: null, matchType: "address", geo };
  }

  return { property: null, matchType: "none", geo: null };
}

// ─── NOTE SYNTHESIS ───────────────────────────────────────────────────────────

function fmtMoney(n) {
  if (n == null || n === "") return "Unknown";
  const num = Number(n);
  return Number.isFinite(num) ? `$${num.toLocaleString("en-US")}` : "Unknown";
}
function fmtPct(n) {
  if (n == null || n === "") return "Unknown";
  const num = Number(n);
  return Number.isFinite(num) ? `${num.toFixed(1)}%` : "Unknown";
}

function isAbsentee(p) {
  if (!p?.mailingState || !p?.situsState) return null;
  if (p.mailingState.trim().toUpperCase() !== p.situsState.trim().toUpperCase()) return true;
  if (p.mailingCity && p.situsCity) {
    return p.mailingCity.trim().toUpperCase() !== p.situsCity.trim().toUpperCase();
  }
  return false;
}

function compsSummary(comps) {
  if (!comps?.length) return "None returned";
  return comps
    .slice(0, 4)
    .map((c) => `${c.area_acres ?? "?"} ac @ ${fmtMoney(c.price)} (${fmtMoney(c.price_per_acre)}/ac, ${c.mls_status || "n/a"})`)
    .join("; ");
}

function buildStructuredNote(p, ctx = {}) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
  if (!p) {
    return `PARCEL ANALYSIS - Auto-generated ${today}\n\nNo parcel match found for: ${ctx.inputLabel || "unknown input"}\n\n${ctx.errorMsg ? `[note: ${ctx.errorMsg}]` : "Verify the APN/address and try again."}`;
  }

  const absentee = isAbsentee(p);
  const situs = [p.situsAddress, p.situsCity, p.situsState, p.situsZip].filter(Boolean).join(", ");
  const mailing = [p.mailingAddress, p.mailingCity, p.mailingState, p.mailingZip].filter(Boolean).join(", ");

  return `PARCEL ANALYSIS - Auto-generated ${today}

ADDRESS: ${situs || ctx.geoAddress || ctx.inputLabel || "Unknown"}
APN: ${p.apn || "Not found"}
COUNTY / FIPS: ${p.situsCounty || "Unknown"} / ${p.fips || "Unknown"}
OWNER OF RECORD: ${p.ownerName || "Unknown"}
ACREAGE: ${p.lotSizeAcres != null ? `${p.lotSizeAcres} ac` : "Unknown"}
LAND USE: ${p.landUseDescription || p.landUseCode || "Unknown"}
LEGAL: ${p.legalDescription || "Unknown"}

VALUE
  Assessed (total): ${fmtMoney(p.assessedTotalValue)}
  Market (total):   ${fmtMoney(p.marketTotalValue)}
  Land Portal est.: ${fmtMoney(p.tlpEstimate)}${p.tlpPricePerAcre != null ? ` (${fmtMoney(p.tlpPricePerAcre)}/ac)` : ""}

OWNERSHIP
  Absentee owner: ${absentee == null ? "Unknown" : absentee ? "YES" : "No"}
  Mailing addr:   ${mailing || "Unknown"}

SITE
  Road frontage:  ${p.roadFrontage != null ? `${p.roadFrontage} ft` : "Unknown"}
  Land-locked:    ${p.landLocked == null ? "Unknown" : p.landLocked ? "YES" : "No"}
  Flood (FEMA %): ${fmtPct(p.femaCoverPercentage)}${p.floodZone ? ` — ${String(p.floodZone).slice(0, 80)}` : ""}
  Wetlands %:     ${fmtPct(p.wetlandsCoverPercentage)}
  Water feature:  ${p.waterFeaturePresent == null ? "Unknown" : p.waterFeaturePresent ? `Yes (${(p.nearbyWaterTypes || []).join(", ") || "unspecified"})` : "No"}

TERRAIN
  Avg slope:      ${p.slopeAverage != null ? `${p.slopeAverage}%` : "Unknown"}
  Buildable:      ${fmtPct(p.buildabilityPercentage)}${p.buildabilityAcres != null ? ` (~${p.buildabilityAcres} ac)` : ""}

COMPS: ${compsSummary(p.comps)}
${ctx.analyst ? `\nANALYST NOTES:\n${ctx.analyst}` : ""}${ctx.errorMsg ? `\n\n[AI synthesis unavailable: ${ctx.errorMsg}]` : ""}`;
}

async function synthesizeParcelNote(p, ctx = {}) {
  if (!p || !CLAUDE_API_KEY) {
    return buildStructuredNote(p, { ...ctx, errorMsg: !CLAUDE_API_KEY ? "No Claude API key" : ctx.errorMsg });
  }

  const prompt = `You are a land acquisition analyst for TruTerra Group in Sevier County, Tennessee.
Write 3-5 sentences of ANALYST NOTES for the parcel below — opportunity size, buildability/slope reality, flood/water/access constraints, absentee-owner angle, and a recommended next action. Be direct and specific. Plain text only, no markdown.

LEAD CONTEXT: ${ctx.leadContext || "Manual / ad-hoc lookup (no lead attached)"}

PARCEL DATA:
${JSON.stringify(p, null, 2)}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY.trim(),
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = await res.json();
    const analyst = json.content?.[0]?.text?.trim();
    return buildStructuredNote(p, { ...ctx, analyst: analyst || null, errorMsg: analyst ? null : json.error?.message });
  } catch (err) {
    return buildStructuredNote(p, { ...ctx, errorMsg: err.message });
  }
}

// ─── PARSE GHL WEBHOOK ───────────────────────────────────────────────────────

function parseGHLWebhook(payload) {
  const contact = payload.contact || payload;

  const propertyAddress =
    contact.customField?.property_address_or_apn ||
    contact.property_address_or_apn ||
    contact.customData?.property_address_or_apn || "";

  const reason =
    contact.customField?.reason_youre_inquiring ||
    contact.reason_youre_inquiring ||
    contact.customData?.reason_youre_inquiring || "";

  return {
    contactId: contact.id || payload.contact_id,
    firstName: contact.firstName || contact.first_name || "",
    lastName: contact.lastName || contact.last_name || "",
    email: contact.email || "",
    phone: contact.phone || "",
    source: contact.source || "",
    tags: contact.tags || [],
    attributionSource: contact.attributionSource || {},
    reason,
    propertyAddress: (propertyAddress || "").trim(),
  };
}

// ─── GET: manual / ad-hoc lookup ───────────────────────────────────────────────

async function handleManualLookup(req, res) {
  const q = req.query || {};
  const apn = q.apn || q.parcel;
  const address = q.address;
  const propertyId = q.propertyId || q.propertyid;
  const lat = q.lat != null ? Number(q.lat) : null;
  const lng = q.lng != null ? Number(q.lng) : null;
  const state = q.state || "TN";
  const contactId = q.contactId || null;

  if (!apn && !address && !propertyId && !(lat != null && lng != null)) {
    return res.status(400).json({
      success: false,
      message: "Provide one of: apn, address, propertyId, or lat+lng.",
      examples: [
        "/api/analyze-lead?apn=02-1.0-11.0-2-001-010.01&state=MO",
        "/api/analyze-lead?address=123 Main St, Sevierville TN",
        "/api/analyze-lead?propertyId=78723946",
      ],
    });
  }

  const inputLabel = apn || address || propertyId || `${lat},${lng}`;
  const { property, matchType, geo } = await resolveParcel({ apn, address, propertyId, lat, lng, state });

  const note = await synthesizeParcelNote(property, {
    inputLabel,
    geoAddress: geo?.matchedAddress,
    leadContext: `Manual lookup for ${inputLabel}`,
  });

  let notePosted = false;
  if (contactId && property) {
    await ghlAddNote(contactId, note);
    notePosted = true;
  }

  return res.status(200).json({
    success: !!property,
    matchType,
    parcelFound: !!property,
    property,
    note,
    notePosted,
  });
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method === "GET") {
    try {
      return await handleManualLookup(req, res);
    } catch (err) {
      console.error("Manual lookup error:", err);
      return res.status(500).json({ success: false, error: err.message });
    }
  }

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const payload = req.body;
    const lead = parseGHLWebhook(payload);
    console.log("Lead:", JSON.stringify(lead));

    if (!lead.contactId) return res.status(400).json({ error: "No contact ID" });

    // ── STEP 1: Classify ────────────────────────────────────────────────────
    const classification = await classifyLead({
      firstName: lead.firstName,
      lastName: lead.lastName,
      email: lead.email,
      phone: lead.phone,
      source: lead.source,
      attributionSource: lead.attributionSource,
      propertyAddress: lead.propertyAddress || null,
      reasonForInquiry: lead.reason || null,
      existingTags: lead.tags,
      customFields:
        (payload.contact || payload)?.customField ||
        (payload.contact || payload)?.customData || {},
    });

    // ── STEP 2: Tags ──────────────────────────────────────────────────────────
    const tags = [
      `type:${classification.type}`,
      classification.source_tag,
      classification.campaign_tag,
      ...(classification.flags || []).map((f) => `flag:${f}`),
    ].filter(Boolean);

    await ghlAddTags(lead.contactId, tags);
    console.log("Tags applied:", tags);

    // ── STEP 3: Opportunity ─────────────────────────────────────────────────
    let opportunityResult = null;
    const assignedTo = roundRobin(lead.contactId);
    const contactName = `${lead.firstName} ${lead.lastName}`.trim();

    if (classification.pipeline === "leadIntake") {
      opportunityResult = await ghlCreateOpportunity(
        lead.contactId, contactName, PIPELINES.leadIntake, STAGES.leadIntake_newLead, assignedTo
      );
    } else if (classification.pipeline === "investorBuyer") {
      opportunityResult = await ghlCreateOpportunity(
        lead.contactId, contactName, PIPELINES.investorBuyer, STAGES.investor_newLead, assignedTo
      );
    }
    console.log("Opportunity:", JSON.stringify(opportunityResult));

    // ── STEP 4: Parcel analysis (seller leads only) ──────────────────────────
    let property = null;
    let note = null;

    if (classification.run_parcel_analysis && lead.propertyAddress) {
      const resolved = await resolveParcel({
        apn: looksLikeApn(lead.propertyAddress) ? lead.propertyAddress : undefined,
        address: looksLikeApn(lead.propertyAddress) ? undefined : lead.propertyAddress,
        state: "TN",
      });
      property = resolved.property;

      note = await synthesizeParcelNote(property, {
        inputLabel: lead.propertyAddress,
        geoAddress: resolved.geo?.matchedAddress,
        leadContext: `${contactName} — reason: ${lead.reason || "n/a"}; submitted: ${lead.propertyAddress}`,
      });
      await ghlAddNote(lead.contactId, note);
    } else if (classification.type === "unclassified" || classification.flags?.includes("needs-manual-review")) {
      await ghlAddNote(
        lead.contactId,
        `LEAD CLASSIFICATION — ${new Date().toLocaleDateString("en-US")}\n\nType: UNCLASSIFIED — needs manual review\nReason: ${classification.reasoning}\nConfidence: ${classification.confidence}\nSource: ${lead.source || "Unknown"}\nAttribution: ${JSON.stringify(lead.attributionSource)}`
      );
    }

    return res.status(200).json({
      success: true,
      contactId: lead.contactId,
      classification: classification.type,
      confidence: classification.confidence,
      tagsApplied: tags,
      assignedTo,
      opportunityCreated: !!opportunityResult,
      parcelFound: !!property,
      notePosted: !!note,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
