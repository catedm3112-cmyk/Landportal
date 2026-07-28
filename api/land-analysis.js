/**
 * TruTerra Land Analysis Engine  —  Vercel Serverless Function
 *
 *   POST /api/land-analysis?key=<LAND_ANALYSIS_SECRET>   body { "contactId": "..." }
 *   GET  /api/land-analysis?key=<...>&contactId=...       (same, manual re-run)
 *
 * Flow:  contact → resolve subject parcel (free TN statewide layer) → adjoiners
 *        → comps (Claude web search) → value range → write custom fields + note.
 *
 * Design constraints (see the deploy README):
 *   • Zero metered usage — no Land Portal API calls. Parcel + adjoiners come from
 *     the free TN cadastral layer; comps come from Claude web search.
 *   • TN-only for v1. Out-of-state parcels get status `needs-parcel`.
 *   • Approval gate is downstream — this engine never messages the lead. It writes
 *     a value range, a report URL, a status, and the full JSON, then stops.
 *   • Private adjoiner owner names stay out of the client-facing JSON; they live
 *     only in the internal contact note.
 */

import { parcelAtPoint, parcelByText, adjoiners } from "../lib/tnparcels.js";
import {
  getContact,
  updateContactFields,
  addTags,
  addNote,
  readContactField,
} from "../lib/ghlfields.js";

const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;
const CLAUDE_API = "https://api.anthropic.com/v1/messages";
const MODEL_COMPS = "claude-sonnet-5";

// ── config ───────────────────────────────────────────────────────────────────────
function reportBase() {
  return (process.env.REPORT_BASE_URL || "https://landportal-coral.vercel.app").replace(/\/+$/, "");
}

// ── Claude (comps via web search) ─────────────────────────────────────────────────
// Web search is a server-side tool — Anthropic runs the searches and returns the
// final answer in one round trip, so there is no client-side tool loop to manage.
async function callClaude({ prompt, maxTokens = 1500, webSearch = false, maxUses = 4 }) {
  if (!CLAUDE_API_KEY) throw new Error("No Claude API key");
  const body = {
    model: MODEL_COMPS,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  };
  if (webSearch) {
    body.tools = [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses }];
  }
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
  return (json.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

function extractJson(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

// ── geocoding (free Census one-line + component fallback) ─────────────────────────
async function geocode(address) {
  const pick = (j) => {
    const m = j?.result?.addressMatches?.[0];
    return m ? { lat: m.coordinates.y, lng: m.coordinates.x, matchedAddress: m.matchedAddress } : null;
  };
  try {
    const p = new URLSearchParams({ address, benchmark: "2020", format: "json" });
    const r = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?${p}`);
    const hit = pick(await r.json().catch(() => null));
    if (hit) return hit;
  } catch {
    /* fall through */
  }
  return null;
}

function looksLikeApn(str) {
  if (!str) return false;
  const s = str.trim();
  if (!/\d/.test(s)) return false;
  if (/,/.test(s)) return false;
  if (/\b(st|street|rd|road|ave|avenue|dr|drive|ln|lane|hwy|highway|blvd|ct|court|way|pike|trail|cir|circle)\b/i.test(s)) return false;
  return /^[A-Za-z0-9.\-\s]{4,30}$/.test(s) && (s.match(/\d/g) || []).length >= 3;
}

// Detect an explicit out-of-TN property state in the submitted text.
function outOfStateAbbrev(address) {
  const m = String(address || "").toUpperCase().match(/\b([A-Z]{2})\b(?:\s+\d{5})?\s*$/);
  const st = m?.[1];
  const STATES = new Set(["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TX","UT","VT","VA","WA","WV","WI","WY"]);
  return st && STATES.has(st) ? st : null;
}

// ── money helpers ────────────────────────────────────────────────────────────────
function fmtMoney(n) {
  const num = Number(n);
  return Number.isFinite(num) ? `$${Math.round(num).toLocaleString("en-US")}` : null;
}
function rangeLabel(low, high) {
  const l = fmtMoney(low);
  const h = fmtMoney(high);
  if (l && h) return `${l} – ${h}`;
  return l || h || "Estimate pending";
}

// ── adjoiner intelligence ─────────────────────────────────────────────────────────
const ENTITY_RE = /\b(LLC|L\.?L\.?C|INC|CORP|COMPANY|CO\b|LP|LLLP|LLP|TRUST|HOLDINGS|PROPERTIES|PROPERTY|PARTNERS|GROUP|CAPITAL|VENTURES|DEVELOP|BUILDERS|HOMES|FARMS|LAND)\b/i;
const GOV_RE = /\b(CITY OF|COUNTY|STATE OF|TENNESSEE|USA|UNITED STATES|BOARD OF|UTILITY|ELECTRIC|CHURCH|SCHOOL|PARK|CONSERVAN|TVA)\b/i;

function normOwner(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

function buildAdjoinerIntel(subject, adj) {
  const stats = {
    count: adj.length,
    totalAcres: Math.round(adj.reduce((a, p) => a + (p.acres || 0), 0) * 10) / 10,
    entityOwned: 0,
    government: 0,
    largeNeighbors: 0,
    assemblage: false,
  };
  const subjOwner = normOwner(subject.owner);
  const subjAcres = subject.acres || 0;
  const internalLines = [];

  for (const p of adj) {
    const owner = normOwner(p.owner);
    if (ENTITY_RE.test(owner)) stats.entityOwned++;
    if (GOV_RE.test(owner)) stats.government++;
    if (p.acres && (p.acres >= 50 || (subjAcres && p.acres >= subjAcres * 2))) stats.largeNeighbors++;
    if (subjOwner && owner && owner === subjOwner) stats.assemblage = true;
    internalLines.push(
      `  • ${p.owner || "owner unknown"}${p.pin ? ` [PIN ${p.pin}]` : ""} — ${p.acres != null ? `${p.acres} ac` : "? ac"}${p.address ? `, ${p.address}` : ""}`
    );
  }

  // Client-facing note: aggregate signals only, NO owner names.
  const client = [];
  if (stats.count) {
    client.push(
      `This parcel adjoins ${stats.count} neighboring ${stats.count === 1 ? "tract" : "tracts"}${
        stats.totalAcres ? ` totaling roughly ${stats.totalAcres} acres` : ""
      }.`
    );
  }
  if (stats.assemblage) {
    client.push("A neighboring tract appears to share ownership with this one — worth confirming whether the two could be marketed or developed together.");
  }
  if (stats.entityOwned >= 2) {
    client.push(`${stats.entityOwned} of the neighbors are held by companies or investment entities, which often signals an area seeing active assemblage or development interest.`);
  } else if (stats.entityOwned === 1) {
    client.push("One neighboring tract is held by a company or investment entity.");
  }
  if (stats.largeNeighbors) {
    client.push(`${stats.largeNeighbors} adjoining ${stats.largeNeighbors === 1 ? "tract is" : "tracts are"} substantially larger, which can matter for access, privacy, and future use.`);
  }
  if (!client.length) client.push("Adjoiner data for this parcel was limited; no notable neighboring-ownership signals surfaced.");

  const internal = [
    `ADJOINERS (${stats.count}) — internal only, owner names withheld from client report`,
    ...internalLines,
    "",
    `Entity-owned neighbors: ${stats.entityOwned} · Government/institutional: ${stats.government} · Large (≥50ac or 2× subject): ${stats.largeNeighbors}`,
    stats.assemblage ? "⚑ ASSEMBLAGE: a neighbor shares the subject's owner name." : "",
  ]
    .filter(Boolean)
    .join("\n");

  return { client: client.join(" "), internal, stats };
}

// ── comps via Claude web search ───────────────────────────────────────────────────
async function compsViaSearch(subject) {
  const acres = subject.acres != null ? `${subject.acres} acres` : "unknown acreage";
  const county = subject.county || "Sevier";
  const where = [subject.address, subject.city, county && `${county} County`, "TN"].filter(Boolean).join(", ");

  const prompt = `You are a land valuation analyst for The TruTerra Group in ${county} County, Tennessee. Use web search to find 3-6 RECENT comparable land sales or active land listings near this parcel and produce a defensible value range for it.

SUBJECT PARCEL: ${where}. Size: ${acres}. This is raw/rural land (not an improved home sale) — compare land to land.

Search for recent (last ~18 months) sold or listed vacant land / acreage in and around ${county} County, TN of similar size. Derive a price-per-acre range from the comps, then apply it to the subject's acreage.

Return ONLY valid JSON, no other text:
{
  "value_low": <number, whole dollars for the whole parcel>,
  "value_high": <number>,
  "ppa_low": <number, price per acre>,
  "ppa_high": <number>,
  "confidence": "high" | "medium" | "low",
  "basis": "<one sentence on how you derived the range>",
  "comps": [
    { "summary": "<short: size, location, status>", "price": <number|null>, "acres": <number|null>, "ppa": <number|null>, "source": "<domain or site>" }
  ]
}

Rules: never invent sales — only report comps you actually found. If acreage is unknown or comps are too thin, set confidence "low" and widen the range. Whole numbers only, no currency symbols or commas inside the JSON.`;

  const text = await callClaude({ prompt, maxTokens: 2000, webSearch: true, maxUses: 5 });
  const data = extractJson(text);
  return {
    valueLow: Number(data.value_low) || null,
    valueHigh: Number(data.value_high) || null,
    ppaLow: Number(data.ppa_low) || null,
    ppaHigh: Number(data.ppa_high) || null,
    confidence: data.confidence || "low",
    basis: data.basis || "",
    comps: Array.isArray(data.comps) ? data.comps.slice(0, 6) : [],
  };
}

// ── contact parsing ───────────────────────────────────────────────────────────────
async function readContactInputs(contact) {
  const addressField =
    (await readContactField(contact, "property_address_or_apn")) ||
    (await readContactField(contact, "property_address")) ||
    "";
  const first = contact.firstName || contact.first_name || "";
  const last = contact.lastName || contact.last_name || "";
  return {
    contactId: contact.id,
    firstName: first,
    lastName: last,
    fullName: `${first} ${last}`.trim(),
    propertyAddress: String(addressField || "").trim(),
    contactState: contact.state || "",
  };
}

// ── subject-parcel resolution ─────────────────────────────────────────────────────
async function resolveSubject(inputs) {
  const addr = inputs.propertyAddress;
  if (!addr) return { parcel: null, matchType: "no-input", geo: null };

  // APN path
  if (looksLikeApn(addr)) {
    const parcel = await parcelByText({ apn: addr, county: "Sevier" }).catch(() => null);
    if (parcel) return { parcel, matchType: "apn", geo: null };
  }

  // Geocode → point-in-parcel (most reliable)
  const geo = await geocode(addr);
  if (geo?.lat != null && geo?.lng != null) {
    const parcel = await parcelAtPoint(geo.lat, geo.lng).catch(() => null);
    if (parcel) return { parcel, matchType: "point", geo };
  }

  // Text fallback: owner + address tokens
  const parcel = await parcelByText({
    owner: inputs.fullName || undefined,
    address: addr,
  }).catch(() => null);
  if (parcel) return { parcel, matchType: "text", geo };

  return { parcel: null, matchType: "unresolved", geo };
}

function mapLinks(parcel) {
  const out = [];
  if (parcel?.lat != null && parcel?.lng != null) {
    out.push(`Satellite: https://www.google.com/maps/search/?api=1&query=${parcel.lat},${parcel.lng}`);
  }
  out.push(`TN parcel records: https://tnmap.tn.gov/assessment/ (${parcel?.county || "Sevier"} Co${parcel?.pin ? `, PIN ${parcel.pin}` : ""})`);
  return out;
}

// ── status writer ─────────────────────────────────────────────────────────────────
async function setStatus(contactId, status, extra = {}) {
  return updateContactFields(contactId, { land_analysis_status: status, ...extra });
}

// ── main handler ──────────────────────────────────────────────────────────────────
export default async function handler(req, res) {
  // Auth: once LAND_ANALYSIS_SECRET is set, require ?key= (or header) to match.
  const SECRET = process.env.LAND_ANALYSIS_SECRET || "";
  const provided = req.query?.key || req.headers["x-land-analysis-secret"] || "";
  if (SECRET && provided !== SECRET) {
    return res.status(401).json({ error: "unauthorized" });
  }

  const contactId =
    req.body?.contactId || req.body?.contact_id || req.query?.contactId || req.query?.contact_id || null;

  if (!contactId) {
    return res.status(400).json({
      ok: true,
      service: "truterra-land-analysis",
      hint: "POST { contactId } (with ?key=SECRET) to run an analysis.",
    });
  }

  try {
    // Mark processing up front so the approval workflow can see it move.
    await setStatus(contactId, "processing").catch(() => {});

    const contact = await getContact(contactId);
    if (!contact) throw new Error(`Contact ${contactId} not found`);
    const inputs = await readContactInputs(contact);

    // ── out-of-state gate (TN-only for v1) ────────────────────────────────────────
    const oos = outOfStateAbbrev(inputs.propertyAddress);
    if (oos && oos !== "TN") {
      const note = `LAND ANALYSIS — needs parcel\n\nSubmitted property looks out-of-state (${oos}): "${inputs.propertyAddress}".\nTruTerra Land Analysis v1 covers Tennessee only; nationwide resolution is a v2 add. Verify the address or handle manually.`;
      await setStatus(contactId, "needs-parcel");
      await addNote(contactId, note);
      return res.status(200).json({ success: false, contactId, status: "needs-parcel", reason: `out-of-state (${oos})` });
    }

    if (!inputs.propertyAddress) {
      const note = `LAND ANALYSIS — needs parcel\n\nNo property address/APN on the contact. Add one and re-run (tag: run-land-analysis).`;
      await setStatus(contactId, "needs-parcel");
      await addNote(contactId, note);
      return res.status(200).json({ success: false, contactId, status: "needs-parcel", reason: "no address on contact" });
    }

    // ── resolve subject parcel ────────────────────────────────────────────────────
    const { parcel, matchType, geo } = await resolveSubject(inputs);
    if (!parcel) {
      const note = `LAND ANALYSIS — needs parcel\n\nCould not resolve a TN parcel for: "${inputs.propertyAddress}"${
        geo?.matchedAddress ? `\nGeocoded to: ${geo.matchedAddress}` : ""
      }\nVerify the address/APN and re-run (tag: run-land-analysis).`;
      await setStatus(contactId, "needs-parcel");
      await addNote(contactId, note);
      return res.status(200).json({ success: false, contactId, status: "needs-parcel", matchType });
    }

    // ── adjoiners + comps (in parallel) ───────────────────────────────────────────
    const [adjList, compsResult] = await Promise.all([
      adjoiners(parcel).catch((e) => {
        console.error("Adjoiner query failed:", e.message);
        return [];
      }),
      compsViaSearch(parcel).catch((e) => {
        console.error("Comps search failed:", e.message);
        return null;
      }),
    ]);

    const intel = buildAdjoinerIntel(parcel, adjList);
    const valueLow = compsResult?.valueLow ?? null;
    const valueHigh = compsResult?.valueHigh ?? null;
    const valueRange = rangeLabel(valueLow, valueHigh);
    const confidence = compsResult?.confidence || (matchType === "point" || matchType === "apn" ? "medium" : "low");

    // ── assemble the analysis object (client-safe: no adjoiner owner names) ────────
    const analysis = {
      version: 1,
      generatedAt: new Date().toISOString(),
      contactId,
      client: {
        firstName: inputs.firstName,
        propertyLabel: [parcel.address, parcel.city, parcel.county && `${parcel.county} County`, "TN"].filter(Boolean).join(", ") || inputs.propertyAddress,
      },
      parcel: {
        pin: parcel.pin,
        acres: parcel.acres,
        county: parcel.county,
        address: parcel.address,
        city: parcel.city,
        assessedValue: parcel.value,
        lat: parcel.lat,
        lng: parcel.lng,
      },
      value: {
        low: valueLow,
        high: valueHigh,
        range: valueRange,
        ppaLow: compsResult?.ppaLow ?? null,
        ppaHigh: compsResult?.ppaHigh ?? null,
        confidence,
        basis: compsResult?.basis || "",
        comps: compsResult?.comps || [],
      },
      adjoinerNote: intel.client, // client-safe "Worth Knowing"
      adjoinerStats: intel.stats,
      matchType,
      mapLinks: mapLinks(parcel),
    };

    const reportUrl = `${reportBase()}/r/${contactId}`;

    // ── write custom fields (status ready last) ───────────────────────────────────
    await updateContactFields(contactId, {
      land_analysis_report_url: reportUrl,
      land_analysis_value_range: valueRange,
      land_analysis_json: JSON.stringify(analysis),
      land_analysis_status: "ready",
    });

    // ── internal note (gut-check in 10 seconds; includes owner names) ─────────────
    const internalNote = [
      `LAND ANALYSIS — READY (${new Date().toLocaleDateString("en-US")})`,
      "",
      `Value range: ${valueRange}${compsResult?.ppaLow ? ` (~${fmtMoney(compsResult.ppaLow)}–${fmtMoney(compsResult.ppaHigh)}/ac)` : ""}`,
      `Confidence: ${confidence}${compsResult?.basis ? ` — ${compsResult.basis}` : ""}`,
      `Match: ${matchType}${parcel.pin ? ` · PIN ${parcel.pin}` : ""} · ${parcel.county || "?"} Co · ${parcel.acres != null ? `${parcel.acres} ac` : "? ac"}`,
      "",
      `Report: ${reportUrl}`,
      "",
      "WORTH KNOWING (client-facing):",
      intel.client,
      "",
      intel.internal,
      "",
      "LINKS",
      ...mapLinks(parcel).map((l) => `  ${l}`),
      "",
      "→ Review, then add tag `send-land-analysis` to approve & send.",
    ].join("\n");
    await addNote(contactId, internalNote);
    await addTags(contactId, ["land-analysis-ready"]).catch(() => {});

    return res.status(200).json({
      success: true,
      contactId,
      status: "ready",
      matchType,
      valueRange,
      confidence,
      reportUrl,
      adjoiners: intel.stats.count,
      compsFound: analysis.value.comps.length,
    });
  } catch (err) {
    console.error("Land analysis error:", err);
    await setStatus(contactId, "error").catch(() => {});
    await addNote(contactId, `LAND ANALYSIS — ERROR\n\n${err.message}\n\nRe-run with tag: run-land-analysis`).catch(() => {});
    return res.status(500).json({ success: false, contactId, status: "error", error: err.message });
  }
}
