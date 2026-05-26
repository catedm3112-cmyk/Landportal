/**
 * TruTerra Lead Analyzer + AI Classifier
 * Vercel Serverless Function
 *
 * Flow:
 * 1. Receive GHL webhook (Contact Created)
 * 2. AI Classifier — reads all available context, returns structured decision
 * 3. Apply tags to contact
 * 4. Create/update opportunity in correct pipeline
 * 5. If seller lead → geocode → Land Portal parcel lookup + comp report
 * 6. AI synthesizes parcel note
 * 7. Post note to GHL contact
 */

const LP_BASE = "https://landportal.com/wp-json/lp-rest-api/v1";
const LP_JWT = process.env.LAND_PORTAL_JWT;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = "https://services.leadconnectorhq.com";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;

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

// Simple alternating round robin based on timestamp parity
function roundRobin(contactId) {
  const sum = contactId.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  return sum % 2 === 0 ? USERS.dillon : USERS.chris;
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
    const text = json.content?.[0]?.text?.trim();
    if (!text) throw new Error("No classifier response");

    const classification = JSON.parse(text);
    console.log("Classification:", JSON.stringify(classification));
    return classification;
  } catch (err) {
    console.error("Classifier error:", err.message);
    // Safe fallback — unclassified, needs manual review
    return {
      type: "unclassified",
      confidence: "low",
      source_tag: "src:unknown",
      campaign_tag: "campaign:truterra",
      pipeline: "leadIntake",
      run_parcel_analysis: false,
      reasoning: "Classifier failed — manual review required",
      flags: ["needs-manual-review"],
    };
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
      locationId: "EHl75N7YlN7nOMP30CYm",
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

// ─── LAND PORTAL ─────────────────────────────────────────────────────────────

async function geocodeAddress(street, city, state, zip) {
  const params = new URLSearchParams({ street, city, state, zip, benchmark: "2020", format: "json" });
  const res = await fetch(`https://geocoding.geo.census.gov/geocoder/locations/address?${params}`);
  const json = await res.json();
  const match = json.result?.addressMatches?.[0];
  if (!match) return null;
  return { lat: match.coordinates.y, lng: match.coordinates.x, matchedAddress: match.matchedAddress };
}

async function lpPropertyByCoords(lat, lng) {
  const res = await fetch(`${LP_BASE}/property-data?lat=${lat}&lng=${lng}`, {
    headers: { Authorization: `Bearer ${LP_JWT}` },
  });
  const json = await res.json();
  return json.success ? json.data.property : null;
}

async function lpPropertyBySearch(street, city, state) {
  const queries = [`${street} ${city}`, street, street.split(" ").slice(0, 3).join(" ")];
  for (const q of queries) {
    const res = await fetch(`${LP_BASE}/search?type=parcelnumb&query=${encodeURIComponent(q)}&state=${state}`, {
      headers: { Authorization: `Bearer ${LP_JWT}` },
    });
    const json = await res.json();
    if (json.success && json.data?.features?.length) {
      const features = json.data.features;
      const cityMatch = features.find(f => f.properties?.city?.toLowerCase() === city?.toLowerCase());
      return (cityMatch || features[0]).properties;
    }
  }
  return null;
}

async function lpPropertyData(propertyid, fips) {
  const res = await fetch(`${LP_BASE}/property-data?propertyid=${propertyid}&fips=${fips}`, {
    headers: { Authorization: `Bearer ${LP_JWT}` },
  });
  const json = await res.json();
  return json.success ? json.data.property : null;
}

async function lpQueueCompReport(propertyid, fips) {
  const res = await fetch(`${LP_BASE}/reports`, {
    method: "POST",
    headers: { Authorization: `Bearer ${LP_JWT}`, "Content-Type": "application/json" },
    body: JSON.stringify({ propertyid, fips }),
  });
  const json = await res.json();
  return json.success ? json.data : null;
}

async function getParcelData(lead) {
  const geo = await geocodeAddress(lead.street, lead.city, lead.state, lead.zip);
  console.log("Geocode:", JSON.stringify(geo));

  if (geo?.lat && geo?.lng) {
    const parcel = await lpPropertyByCoords(geo.lat, geo.lng);
    if (parcel) return { parcel, geo };
  }

  const searchResult = await lpPropertyBySearch(lead.street, lead.city, lead.state);
  if (searchResult?.propertyid && searchResult?.fips) {
    const parcel = await lpPropertyData(searchResult.propertyid, searchResult.fips);
    return { parcel, geo: geo || null };
  }

  return { parcel: null, geo: geo || null };
}

// ─── PARCEL NOTE SYNTHESIS ───────────────────────────────────────────────────

async function synthesizeParcelNote(leadData, parcelData, compTask, geo, classification) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });

  if (!CLAUDE_API_KEY) return buildRawNote(leadData, parcelData, compTask, today, geo, "No API key");

  const prompt = `You are a land acquisition analyst for TruTerra Group in Tennessee.
A new inbound seller lead has been classified and their parcel data retrieved. Write a CRM note.

LEAD:
- Name: ${leadData.firstName} ${leadData.lastName}
- Email: ${leadData.email}
- Phone: ${leadData.phone}
- Reason: ${leadData.reason}
- Submitted Address: ${leadData.propertyAddress}
- Geocoded Address: ${geo?.matchedAddress || "Could not geocode"}

AI CLASSIFICATION:
- Type: ${classification.type}
- Confidence: ${classification.confidence}
- Reasoning: ${classification.reasoning}
- Flags: ${classification.flags?.join(", ") || "none"}

PARCEL DATA:
${parcelData ? JSON.stringify(parcelData, null, 2) : "Not found"}

COMP REPORT: ${compTask ? `Task #${compTask.task_id} queued` : "Not queued"}

Write a plain text note — no markdown, no # headers:

PARCEL ANALYSIS - Auto-generated ${today}

ADDRESS: [parcel address or geocoded or submitted]
APN: [apn or Not found]
FIPS: [fips or Unknown]
OWNER OF RECORD: [ownername1full or Unknown]
ACREAGE: [lotsizeacres or Unknown] ac
ZONING: [zoning or landusecode or Unknown]
LAST SALE: [date + price or Unknown]
ASSESSED VALUE: [$value or Unknown]
ABSENTEE OWNER: [Yes/No/Unknown]
MAILING ADDRESS: [mailingfullstreetaddress or Unknown]

COMP REPORT: [Task ID or Not queued]

ANALYST NOTES:
[2-4 sentences covering: seller reason, opportunity size, absentee flag, data gaps, recommended next action. Flag any address mismatch between submitted and parcel data.]`;

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
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const json = await res.json();
    if (json.content?.[0]?.text) return json.content[0].text;
    return buildRawNote(leadData, parcelData, compTask, today, geo, json.error?.message);
  } catch (err) {
    return buildRawNote(leadData, parcelData, compTask, today, geo, err.message);
  }
}

function buildRawNote(leadData, parcelData, compTask, today, geo, errorMsg) {
  const p = parcelData || {};
  const mailingDiffers = p.mailingfullstreetaddress && p.situsfullstreetaddress &&
    p.mailingfullstreetaddress.trim().toLowerCase() !== p.situsfullstreetaddress.trim().toLowerCase();

  return `PARCEL ANALYSIS - Auto-generated ${today}

ADDRESS: ${[p.situsfullstreetaddress, p.situscity, p.situsstate, p.situszip5].filter(Boolean).join(", ") || geo?.matchedAddress || leadData.propertyAddress}
APN: ${p.apn || "Not found"}
FIPS: ${p.fips || "Unknown"}
OWNER OF RECORD: ${p.ownername1full || "Unknown"}
ACREAGE: ${p.lotsizeacres || "Unknown"} ac
ZONING: ${p.zoning || p.landusecode || "Unknown"}
LAST SALE: ${p.currentsalerecordingdate ? `${p.currentsalerecordingdate} / $${p.currentsaleprice || "Unknown"}` : "Unknown"}
ASSESSED VALUE: ${p.assessedtotalvalue ? `$${p.assessedtotalvalue}` : "Unknown"}
ABSENTEE OWNER: ${mailingDiffers ? "Yes" : p.mailingfullstreetaddress ? "No" : "Unknown"}
MAILING ADDRESS: ${p.mailingfullstreetaddress || "Unknown"}

COMP REPORT: ${compTask ? `Task #${compTask.task_id} queued` : "Not queued"}

LEAD REASON: ${leadData.reason || "Not provided"}
${errorMsg ? `\n[AI synthesis error: ${errorMsg}]` : ""}`;
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

  const addressParts = propertyAddress.trim().split(/\s+/);
  const zip = addressParts[addressParts.length - 1];
  const state = addressParts[addressParts.length - 2];
  const city = addressParts[addressParts.length - 3];
  const street = addressParts.slice(0, -3).join(" ");

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
    propertyAddress,
    street,
    city,
    state: state?.toUpperCase(),
    zip,
  };
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

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
      // Pass all custom fields directly so classifier sees them regardless of shape
      customFields: (payload.contact || payload)?.customField || 
                    (payload.contact || payload)?.customData || {},
    });

    // ── STEP 2: Build and apply tags ────────────────────────────────────────
    const tags = [
      `type:${classification.type}`,
      classification.source_tag,
      classification.campaign_tag,
      ...(classification.flags || []).map(f => `flag:${f}`),
    ].filter(Boolean);

    await ghlAddTags(lead.contactId, tags);
    console.log("Tags applied:", tags);

    // ── STEP 3: Create opportunity if applicable ─────────────────────────────
    let opportunityResult = null;
    const assignedTo = roundRobin(lead.contactId);
    const contactName = `${lead.firstName} ${lead.lastName}`.trim();

    if (classification.pipeline === "leadIntake") {
      opportunityResult = await ghlCreateOpportunity(
        lead.contactId, contactName,
        PIPELINES.leadIntake, STAGES.leadIntake_newLead, assignedTo
      );
    } else if (classification.pipeline === "investorBuyer") {
      opportunityResult = await ghlCreateOpportunity(
        lead.contactId, contactName,
        PIPELINES.investorBuyer, STAGES.investor_newLead, assignedTo
      );
    }
    // "none" = social engagement or not-a-lead — no opportunity created

    console.log("Opportunity:", JSON.stringify(opportunityResult));

    // ── STEP 4: Parcel analysis (seller leads only) ──────────────────────────
    let parcel = null;
    let geo = null;
    let compTask = null;
    let note = null;

    if (classification.run_parcel_analysis && lead.propertyAddress) {
      ({ parcel, geo } = await getParcelData(lead));

      if (parcel?.propertyid && parcel?.fips) {
        compTask = await lpQueueCompReport(parcel.propertyid, parcel.fips);
      }

      note = await synthesizeParcelNote(lead, parcel, compTask, geo, classification);
      await ghlAddNote(lead.contactId, note);
    } else if (classification.type === "unclassified" || classification.flags?.includes("needs-manual-review")) {
      // Post a simple flag note so the team knows to review
      await ghlAddNote(lead.contactId,
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
      parcelFound: !!parcel,
      compTaskId: compTask?.task_id || null,
      notePosted: !!note,
    });

  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
