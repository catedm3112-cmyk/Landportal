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
const CLAUDE_API = "https://api.anthropic.com/v1/messages";

// Model routing: cheap+fast for classification, top-tier for the land analysis
// that actually drives decisions, mid-tier for outreach copy.
const MODELS = {
  classify: "claude-haiku-4-5-20251001",
  analyst: "claude-opus-4-8",
  draft: "claude-sonnet-5",
};

// One Claude call over raw HTTP. Returns the assistant's text. IMPORTANT: with a
// thinking model, content[0] is a thinking block (empty text by default) and the
// answer is a later text block — so find the text block, never index [0].
async function callClaude({ model, prompt, maxTokens = 1024, thinking = false, effort = null }) {
  if (!CLAUDE_API_KEY) throw new Error("No Claude API key");
  const body = { model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] };
  if (thinking) body.thinking = { type: "adaptive" };
  if (effort) body.output_config = { effort };
  const res = await fetch(CLAUDE_API, {
    method: "POST",
    headers: {
      "x-api-key": CLAUDE_API_KEY.trim(),
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Anthropic ${res.status}: ${json.error?.message || "unknown"}`);
  return ((json.content || []).find((b) => b.type === "text")?.text || "").trim();
}

// User IDs. NOTE: the old Dillon user xl8mtehpGgd8hQuVXGVk was DELETED during the
// account consolidation — assigning to it silently orphans the lead. Use the
// current consolidated Dillon user vEkFZMkHecUPXltiehzW.
const USERS = {
  dillon: "vEkFZMkHecUPXltiehzW",
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
    const text = await callClaude({ model: MODELS.classify, prompt, maxTokens: 512 });
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

// Patch an existing opportunity (used to write the parcel value into the deal so
// the pipeline/forecast stops showing $0).
async function ghlUpdateOpportunity(opportunityId, fields) {
  const res = await fetch(`${GHL_BASE}/opportunities/${opportunityId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify(fields),
  });
  return res.json();
}

// Create a follow-up task so a new lead lands in someone's work queue instead of
// sitting untouched in "New Lead". Due tomorrow, assigned to the lead's owner.
async function ghlCreateTask(contactId, title, body, assignedTo) {
  const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const res = await fetch(`${GHL_BASE}/contacts/${contactId}/tasks`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${GHL_API_KEY}`,
      "Content-Type": "application/json",
      Version: "2021-07-28",
    },
    body: JSON.stringify({ title, body, dueDate, completed: false, assignedTo }),
  });
  return res.json();
}

// Pull an opportunity id out of the create-opportunity response (shape varies).
function oppId(result) {
  return result?.opportunity?.id || result?.id || null;
}

// Best "deal value" we can infer for a resolved parcel — Land Portal's land
// estimate first (most on-brand for a land business), then market/assessed value.
function parcelValue(p) {
  const v = p?.tlpEstimate ?? p?.marketTotalValue ?? p?.assessedTotalValue ?? null;
  return typeof v === "number" && v > 0 ? Math.round(v) : null;
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

// ─── Address candidate scoring ────────────────────────────────────────────────
// Land Portal's native address search returns ~10 fuzzy candidates that include
// near-miss decoys (opposite directional, wrong street type, off-by-N house
// number). We score each against the submitted address (+ owner-name hint) and
// only auto-attach a parcel when a candidate clears a confidence threshold —
// attaching the WRONG parcel is worse than attaching none.

const DIRECTIONALS = { EAST: "E", WEST: "W", NORTH: "N", SOUTH: "S", E: "E", W: "W", N: "N", S: "S" };
const SUFFIXES = {
  ROAD: "RD", RD: "RD", STREET: "ST", ST: "ST", AVENUE: "AVE", AVE: "AVE", DRIVE: "DR", DR: "DR",
  LANE: "LN", LN: "LN", COURT: "CT", CT: "CT", BOULEVARD: "BLVD", BLVD: "BLVD", HIGHWAY: "HWY", HWY: "HWY",
  PIKE: "PIKE", TRAIL: "TRL", TRL: "TRL", CIRCLE: "CIR", CIR: "CIR", PLACE: "PL", PL: "PL", WAY: "WAY",
  PARKWAY: "PKWY", PKWY: "PKWY", TERRACE: "TER", TER: "TER", LOOP: "LOOP", COVE: "CV", CV: "CV",
};

function normToken(t) {
  return String(t || "").toUpperCase().replace(/[.,]/g, "").trim();
}

// Parse a street string into { number, dir, suffix, core[], tokens[] }.
function parseStreet(str) {
  const raw = normToken(str).replace(/\s+/g, " ");
  const tokens = raw ? raw.split(" ").filter(Boolean) : [];
  let number = null, dir = null, suffix = null;
  const core = [];
  for (const tok of tokens) {
    if (number == null && /^\d+$/.test(tok)) { number = tok; continue; }
    if (DIRECTIONALS[tok] && dir == null) { dir = DIRECTIONALS[tok]; continue; }
    if (SUFFIXES[tok]) { suffix = SUFFIXES[tok]; continue; }
    if (/^\d{5}$/.test(tok)) continue;                 // zip
    if (tok === "TN" || tok === "TENNESSEE") continue;
    core.push(tok);
  }
  return { number, dir, suffix, core, tokens };
}

function slimFeature(f) {
  const p = f?.properties || {};
  return {
    property_id: p.property_id, apn: p.apn ?? p.parcelnumb,
    owner: p.owner_full_name ?? p.owner, street: p.street_address ?? p.address,
    city: p.city, county: p.county, state: p.state,
    acres: p.lot_size_acres ?? p.calc_acres,
  };
}

// Score a candidate against the submitted address + optional owner hint.
// Hard-rejects (0) on house-number or directional conflicts. Range ~0–130.
function scoreCandidate(inp, cand, ownerHint) {
  const c = parseStreet(cand.street || "");
  if (!inp.number || !c.number || inp.number !== c.number) return 0;   // house number must match exactly
  let score = 50;
  if (inp.dir && c.dir) {
    if (inp.dir === c.dir) score += 15; else return 0;                 // opposite directional = different road
  } else if (!inp.dir && !c.dir) {
    score += 5;
  }
  const coreHit = c.core.length ? c.core.filter((t) => inp.tokens.includes(t)).length / c.core.length : 0;
  if (coreHit === 0) return 0;                                          // wrong street name entirely
  score += Math.round(coreHit * 20);
  const extra = c.core.filter((t) => !inp.tokens.includes(t)).length;  // e.g. "POINTE" not in submitted addr
  score -= extra * 15;
  if (inp.suffix && c.suffix) score += inp.suffix === c.suffix ? 10 : -20;    // RD vs LN
  if (cand.city && inp.tokens.includes(normToken(cand.city))) score += 15;    // city corroboration
  if (ownerHint && cand.owner) {
    const surs = normToken(ownerHint).split(" ").filter((t) => t.length > 2);
    if (surs.some((s) => normToken(cand.owner).includes(s))) score += 20;     // owner surname corroboration
  }
  return Math.max(0, score);
}

// Rank Land Portal features against the submitted address; returns sorted list.
function rankCandidates(inputAddress, features, ownerHint) {
  const inp = parseStreet(inputAddress);
  return (features || [])
    .map((f) => ({
      f, p: f?.properties || {},
      score: scoreCandidate(inp, {
        street: f?.properties?.street_address ?? f?.properties?.address,
        city: f?.properties?.city,
        owner: f?.properties?.owner_full_name ?? f?.properties?.owner,
      }, ownerHint),
    }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Resolve a parcel from any input.
 * Returns { property (normalized | null), matchType, geo, candidates?, confidence? }.
 * For addresses it runs a cascade: strongly-corroborated address search →
 * geocode+point → moderately-confident address search → owner-name last resort.
 */
async function resolveParcel({ apn, address, propertyId, lat, lng, state = "TN", ownerHint = null }) {
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

  // Address → multi-strategy cascade.
  if (address) {
    if (looksLikeApn(address)) {
      const r = await resolveParcel({ apn: address, state });
      if (r.property) return r;
    }
    const parts = address.replace(/,/g, " ").trim().split(/\s+/);
    const zip = /^\d{5}$/.test(parts[parts.length - 1]) ? parts[parts.length - 1] : "";
    const geo = await geocodeAddress(address, "", state, zip);

    // Native address search, scored. This is the most reliable strategy for
    // free-typed addresses — the geocoded street point routinely falls just
    // outside the parcel polygon, so a point-only lookup misses valid parcels.
    let ranked = [];
    try {
      const { features } = await searchProperties({ address, state });
      ranked = rankCandidates(address, features, ownerHint);
    } catch (e) {
      console.error("Address search failed:", e.message);
    }
    const candidates = ranked.slice(0, 4).map((r) => ({ ...slimFeature(r.f), score: r.score }));
    const top = ranked[0];

    // Strategy 1: strongly-corroborated address match (number + street + city or
    // owner) — trust it even over a point hit, which can land in a neighbor lot.
    if (top && top.score >= 95 && top.p.property_id) {
      const detail = await getPropertyDetail(top.p.property_id);
      return { property: normalizeProperty(detail.property, top.p), matchType: "address_search", geo, candidates, confidence: top.score };
    }

    // Strategy 2: geocode → point lookup (authoritative when the point lands in a parcel).
    if (geo?.lat && geo?.lng) {
      const { feature } = await getPropertyByPoint(geo.lat, geo.lng);
      const match = feature?.properties;
      if (match?.property_id) {
        const detail = await getPropertyDetail(match.property_id);
        return { property: normalizeProperty(detail.property, match), matchType: "address_point", geo, candidates };
      }
    }

    // Strategy 3: moderately-confident address match.
    if (top && top.score >= 80 && top.p.property_id) {
      const detail = await getPropertyDetail(top.p.property_id);
      return { property: normalizeProperty(detail.property, top.p), matchType: "address_search", geo, candidates, confidence: top.score };
    }

    // Strategy 4: owner-name last resort — only accept if the owner's parcel also
    // corroborates on the submitted address (score >= 95), so we never attach a
    // random same-surname parcel elsewhere in the state.
    if (ownerHint) {
      try {
        const { features } = await searchProperties({ owner: ownerHint, state });
        const ob = rankCandidates(address, features, ownerHint)[0];
        if (ob && ob.score >= 95 && ob.p.property_id) {
          const detail = await getPropertyDetail(ob.p.property_id);
          return { property: normalizeProperty(detail.property, ob.p), matchType: "owner_search", geo, candidates, confidence: ob.score };
        }
      } catch (e) {
        console.error("Owner search failed:", e.message);
      }
    }

    // No confident match — return the closest candidates so the note can suggest them.
    return { property: null, matchType: "address", geo, candidates };
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

// Handy, accurate links for the rep: a one-tap satellite view at the parcel's
// exact coordinates (works on any device, no login) + the official TN parcel/
// assessment viewer. Falls back to an address search when no parcel resolved.
function mapLinks(p, ctx = {}) {
  const out = [];
  if (p?.latitude != null && p?.longitude != null) {
    out.push(`Map (satellite): https://www.google.com/maps/search/?api=1&query=${p.latitude},${p.longitude}`);
  } else if (ctx.geoAddress || ctx.inputLabel) {
    out.push(`Map: https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ctx.geoAddress || ctx.inputLabel)}`);
  }
  out.push(`TN parcel records: https://tnmap.tn.gov/assessment/  (${p?.situsCounty || "Sevier"} Co${p?.apn ? `, search APN ${p.apn}` : ""})`);
  return out;
}

function buildStructuredNote(p, ctx = {}) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });
  if (!p) {
    let msg = `PARCEL ANALYSIS - Auto-generated ${today}\n\nNo confident parcel match for: ${ctx.inputLabel || "unknown input"}`;
    const cands = (ctx.candidates || []).filter((c) => c.property_id);
    if (cands.length) {
      msg += `\n\nClosest Land Portal candidates (VERIFY before using):\n`;
      msg += cands.map((c, i) =>
        `  ${i + 1}. ${c.street || "?"}, ${c.city || "?"}${c.county ? ` (${c.county} Co)` : ""} — ${c.owner || "owner ?"}; ${c.acres != null ? `${c.acres} ac` : "? ac"}; APN ${c.apn || "?"}  [match ${c.score}]`
      ).join("\n");
      msg += `\n\nIf #1 is correct, re-run analysis with its APN for the full parcel report.`;
    } else {
      msg += `\n\n${ctx.errorMsg ? `[note: ${ctx.errorMsg}]` : "Verify the APN/address and try again."}`;
    }
    msg += `\n\nLINKS\n  ${mapLinks(null, ctx).join("\n  ")}`;
    return msg;
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

LINKS
  ${mapLinks(p, ctx).join("\n  ")}

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

  const prompt = `You are a senior land-acquisition analyst for The TruTerra Group in Sevier County, Tennessee. TruTerra buys, brokers, and develops land and partners with its sister builder TruBuilt.

Write a tight, decision-useful read on the parcel below for the acquisitions team — what you'd tell a partner before they call the owner. Cover, only where the data supports it:
- Opportunity thesis: what makes this worth (or not worth) pursuing, and rough deal size.
- Buildability reality: slope, buildable acreage, and what it realistically supports (single build, subdivide, STR, hold).
- Constraints: flood/FEMA, wetlands, water, road frontage / access / land-locked, zoning.
- Owner angle: absentee vs local, likely motivation given the lead's stated reason, and how to open the conversation.
- Recommended next action: one concrete move (e.g. "offer a free valuation and ask their timeline", "verify septic feasibility with Sevier County", "pass — land-locked, low buildable").

Be direct and specific; use the numbers. If a data point is missing or looks off, say so briefly instead of guessing. Plain prose only — no headings, no bullet labels, no markdown. Note: tax_amount may be reported in cents; don't flag it as inconsistent unless clearly material.

LEAD CONTEXT: ${ctx.leadContext || "Manual / ad-hoc lookup (no lead attached)"}

PARCEL DATA:
${JSON.stringify(p, null, 2)}`;

  try {
    let analyst = await callClaude({
      model: MODELS.analyst,
      prompt,
      maxTokens: 3500,
      thinking: true,
      effort: "medium", // Opus 4.8 medium stays well under the 60s function limit while keeping the deep read
    });
    // Strip any echoed "ANALYST NOTES:" label(s) so the header isn't duplicated.
    if (analyst) analyst = analyst.replace(/^\s*(analyst notes\s*:?\s*)+/i, "").trim();
    return buildStructuredNote(p, { ...ctx, analyst: analyst || null, errorMsg: analyst ? null : "empty analysis" });
  } catch (err) {
    return buildStructuredNote(p, { ...ctx, errorMsg: err.message });
  }
}

// ─── FIRST-TOUCH DRAFT (never auto-sent) ──────────────────────────────────────
// Draft the first SMS + email for the rep to review and send manually. TruTerra
// operating rule: Claude drafts outbound, a human sends it.
async function draftFirstTouch({ lead, parcel, analystNote, repName, cold = false }) {
  const acres = parcel?.lotSizeAcres != null ? `${parcel.lotSizeAcres} ac` : "unknown acreage";
  const county = parcel?.situsCounty || "Sevier";
  const absentee = isAbsentee(parcel);
  const intro = cold
    ? `You are drafting a COLD first outreach from The TruTerra Group (a local land buyer/broker in Sevier County, Tennessee) to a landowner who has NOT contacted us. Be respectful and low-pressure: briefly say why you're reaching out (you work with landowners in their area), offer a free, no-obligation valuation, and make it easy to say no.`
    : `You are drafting the FIRST outreach from The TruTerra Group (a land buyer/broker in Sevier County, Tennessee) to a landowner who just inquired. Warm and human, no hard sell — you're following up because they reached out.`;
  const prompt = `${intro}

Draft two short messages a human rep will review and send manually.

Return ONLY valid JSON, no other text:
{"sms": "...", "email_subject": "...", "email_body": "..."}

Rules:
- SMS: 300 characters max, use the first name if known, plain text, end with an easy yes/no question. Do NOT add an opt-out footer.
- Email: 3-5 sentences, subject 60 characters max.
- Reference their property/situation naturally only if known. NEVER invent specifics — no prices, offers, valuations, or guarantees.
- Sign as "${repName}, TruTerra Group" and include the callback number 865-505-7782.

LEAD: first name "${lead.firstName || "there"}", ${cold ? "" : `reason for inquiry: ${lead.reason || "n/a"}, `}property: ${lead.propertyAddress || "n/a"}
PARCEL: ${acres}, ${county} County, ${absentee == null ? "owner locality unknown" : absentee ? "absentee owner" : "local owner"}${analystNote ? `\nANALYST READ (context only — do not quote figures the owner didn't give you): ${(analystNote || "").slice(0, 900)}` : ""}`;

  const text = await callClaude({ model: MODELS.draft, prompt, maxTokens: 800 });
  try { return extractJson(text); } catch { return null; }
}

// ─── OUTBOUND MODE: personalized cold-outreach draft (draft-only) ──────────────
// POST /api/analyze-lead?mode=outreach — for a known landowner (cold list), pull
// their parcel and draft a personalized first-touch into a review task. No intake
// pipeline (no classify/opportunity). Outbound stays draft-only.
async function handleOutreachDraft(res, lead) {
  if (!lead.propertyAddress) {
    return res.status(200).json({ success: false, mode: "outreach", reason: "no property address on contact" });
  }
  const contactName = `${lead.firstName} ${lead.lastName}`.trim();
  const resolved = await resolveParcel({
    apn: looksLikeApn(lead.propertyAddress) ? lead.propertyAddress : undefined,
    address: looksLikeApn(lead.propertyAddress) ? undefined : lead.propertyAddress,
    state: "TN",
    ownerHint: contactName || null,
  });
  const property = resolved.property;
  const assignedTo = roundRobin(lead.contactId);
  const repName = assignedTo === USERS.dillon ? "Dillon" : "Chris";

  let drafted = false;
  const draft = await draftFirstTouch({ lead, parcel: property, analystNote: null, repName, cold: true });
  if (draft && (draft.sms || draft.email_body)) {
    await ghlAddTags(lead.contactId, ["outreach:drafted"]);
    await ghlCreateTask(
      lead.contactId,
      `✍️ Review & send cold outreach to ${contactName || lead.propertyAddress}`,
      `DRAFT cold outreach — approve and send manually (NOT auto-sent).\n\n— TEXT —\n${draft.sms || "(none)"}\n\n— EMAIL —\nSubject: ${draft.email_subject || ""}\n\n${draft.email_body || "(none)"}`,
      assignedTo
    );
    drafted = true;
  }
  return res.status(200).json({
    success: true, mode: "outreach", contactId: lead.contactId,
    parcelFound: !!property, outreachDrafted: drafted, assignedTo,
  });
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

  const owner = q.owner || null;
  const inputLabel = apn || address || propertyId || `${lat},${lng}`;
  const { property, matchType, geo, candidates, confidence } = await resolveParcel({
    apn, address, propertyId, lat, lng, state, ownerHint: owner,
  });

  const note = await synthesizeParcelNote(property, {
    inputLabel,
    geoAddress: geo?.matchedAddress,
    leadContext: `Manual lookup for ${inputLabel}`,
    candidates,
  });

  // Post when a contact is attached and we have something useful — a resolved
  // parcel OR ranked candidates to verify (so a near-miss still leaves a breadcrumb).
  let notePosted = false;
  if (contactId && (property || (candidates && candidates.some((c) => c.property_id)))) {
    await ghlAddNote(contactId, note);
    notePosted = true;
  }

  return res.status(200).json({
    success: !!property,
    matchType,
    parcelFound: !!property,
    confidence: confidence ?? null,
    property,
    candidates: candidates || [],
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

  // Webhook auth: once WEBHOOK_SECRET is set in the environment, require a matching
  // x-webhook-secret header on POST. Until it's set, allow (so the check can ship
  // before the GHL header is added). GET (manual lookup) is exempt.
  const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || "";
  if (WEBHOOK_SECRET && (req.headers["x-webhook-secret"] || "") !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  try {
    const payload = req.body;
    const lead = parseGHLWebhook(payload);
    console.log("Lead:", JSON.stringify(lead));

    if (!lead.contactId) return res.status(400).json({ error: "No contact ID" });

    // Outbound mode: personalized cold-outreach draft only (skips the intake pipeline).
    if ((req.query?.mode || payload?.mode) === "outreach") {
      return await handleOutreachDraft(res, lead);
    }

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

    // ── STEP 3b: Follow-up task ──────────────────────────────────────────────
    // Every opportunity gets a same-day call task so leads never sit unworked.
    let taskCreated = false;
    const newOppId = oppId(opportunityResult);
    if (newOppId) {
      const label = classification.type === "buyer-investor" ? "buyer/investor" : "seller";
      await ghlCreateTask(
        lead.contactId,
        `📞 Call ${contactName} — new ${label} lead`,
        `New ${classification.type} lead (${lead.source || "unknown source"}). ` +
          `${lead.propertyAddress ? `Property: ${lead.propertyAddress}. ` : ""}` +
          `Reason: ${lead.reason || "n/a"}. Speed-to-lead — reach out today.`,
        assignedTo
      );
      taskCreated = true;
      console.log("Task created for", newOppId);
    }

    // ── STEP 4: Parcel analysis (seller leads only) ──────────────────────────
    let property = null;
    let note = null;
    let firstTouchDrafted = false;

    if (classification.run_parcel_analysis && lead.propertyAddress) {
      const resolved = await resolveParcel({
        apn: looksLikeApn(lead.propertyAddress) ? lead.propertyAddress : undefined,
        address: looksLikeApn(lead.propertyAddress) ? undefined : lead.propertyAddress,
        state: "TN",
        ownerHint: contactName || null,   // corroborate/disambiguate by lead's name
      });
      property = resolved.property;

      // Write the parcel's value onto the opportunity so the pipeline/forecast
      // reflects real dollars instead of $0.
      const value = parcelValue(property);
      if (newOppId && value) {
        await ghlUpdateOpportunity(newOppId, { monetaryValue: value });
        console.log("Opportunity value set:", value);
      }

      note = await synthesizeParcelNote(property, {
        inputLabel: lead.propertyAddress,
        geoAddress: resolved.geo?.matchedAddress,
        leadContext: `${contactName} — reason: ${lead.reason || "n/a"}; submitted: ${lead.propertyAddress}`,
        candidates: resolved.candidates,
      });
      await ghlAddNote(lead.contactId, note);

      // Draft the first-touch text + email for the rep to review and send — never
      // auto-sent (TruTerra rule: Claude drafts outbound, a human sends it).
      if (property) {
        try {
          const repName = assignedTo === USERS.dillon ? "Dillon" : "Chris";
          const draft = await draftFirstTouch({ lead, parcel: property, analystNote: note, repName });
          if (draft && (draft.sms || draft.email_body)) {
            await ghlCreateTask(
              lead.contactId,
              `✍️ Review & send first-touch to ${contactName}`,
              `DRAFT — approve and send manually (NOT auto-sent).\n\n— TEXT —\n${draft.sms || "(none)"}\n\n— EMAIL —\nSubject: ${draft.email_subject || ""}\n\n${draft.email_body || "(none)"}`,
              assignedTo
            );
            firstTouchDrafted = true;
            console.log("First-touch draft task created");
          }
        } catch (e) {
          console.error("First-touch draft failed:", e.message);
        }
      }
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
      opportunityValue: parcelValue(property),
      taskCreated,
      parcelFound: !!property,
      notePosted: !!note,
      firstTouchDrafted,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
