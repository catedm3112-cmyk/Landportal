const LP_BASE = "https://landportal.com/wp-json/lp-rest-api/v1";
const LP_JWT = process.env.LAND_PORTAL_JWT;
const GHL_API_KEY = process.env.GHL_API_KEY;
const GHL_BASE = "https://services.leadconnectorhq.com";
const CLAUDE_API_KEY = process.env.ANTHROPIC_API_KEY;

async function lpSearch(address, state) {
  const searchUrl = `${LP_BASE}/search?type=parcelnumb&query=${encodeURIComponent(address)}&state=${state}`;
  const res = await fetch(searchUrl, { headers: { Authorization: `Bearer ${LP_JWT}` } });
  const json = await res.json();
  if (!json.success || !json.data?.features?.length) {
    const shortQuery = address.split(" ").slice(0, 3).join(" ");
    const fallbackUrl = `${LP_BASE}/search?type=owner&query=${encodeURIComponent(shortQuery)}&state=${state}`;
    const fallbackRes = await fetch(fallbackUrl, { headers: { Authorization: `Bearer ${LP_JWT}` } });
    const fallbackJson = await fallbackRes.json();
    if (!fallbackJson.success || !fallbackJson.data?.features?.length) return null;
    return fallbackJson.data.features[0].properties;
  }
  return json.data.features[0].properties;
}

async function lpPropertyData(propertyid, fips) {
  const url = `${LP_BASE}/property-data?propertyid=${propertyid}&fips=${fips}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${LP_JWT}` } });
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

async function synthesizeWithClaude(leadData, parcelData, compTask) {
  const today = new Date().toLocaleDateString("en-US", { year: "numeric", month: "2-digit", day: "2-digit" });

  // If no API key, fall back to structured raw note
  if (!CLAUDE_API_KEY) {
    return buildRawNote(leadData, parcelData, compTask, today);
  }

  const prompt = `You are a land acquisition analyst for TruTerra Group, a land advisory and wholesale company in Tennessee.
A new inbound seller lead has come in via Facebook. Analyze the data below and write a concise, structured lead note for the CRM.

LEAD INFO:
- Name: ${leadData.firstName} ${leadData.lastName}
- Email: ${leadData.email}
- Phone (submitted): ${leadData.phone}
- Reason for inquiry: ${leadData.reason}
- Property Address (submitted): ${leadData.propertyAddress}

LAND PORTAL PARCEL DATA:
${parcelData ? JSON.stringify(parcelData, null, 2) : "Parcel not found in Land Portal for this address."}

COMP REPORT:
${compTask ? `Queued - Task ID: ${compTask.task_id} (results will be available in Land Portal dashboard)` : "Not queued - parcel lookup failed"}

Write a lead note using EXACTLY this format - plain text only, no markdown, no # headers:

PARCEL ANALYSIS - Auto-generated ${today}

ADDRESS: [full address from parcel data, or submitted address if not found]
APN: [apn or Not found]
FIPS: [fips or Unknown]
OWNER OF RECORD: [ownername1full or Unknown]
ACREAGE: [lotsizeacres or Unknown] ac
ZONING: [zoning or landusecode or Unknown]
LAST SALE: [currentsalerecordingdate + currentsaleprice if available, else Unknown]
ASSESSED VALUE: [assessedtotalvalue if available, else Unknown]
ABSENTEE OWNER: [Yes if mailing address differs from property address, No if same, Unknown if data missing]

COMP REPORT: [Task ID if queued, else Not queued]

ANALYST NOTES:
[2-4 sentences. Cover: sellers stated reason, absentee owner flag, acreage/opportunity size, any data gaps, recommended next action for the TruTerra team.]`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": CLAUDE_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const json = await res.json();
    console.log("Anthropic response status:", res.status);
    console.log("Anthropic response:", JSON.stringify(json));

    if (json.content?.[0]?.text) {
      return json.content[0].text;
    }

    // API returned but no content — fall back to raw note with error details
    console.error("Anthropic API error:", json.error?.message || JSON.stringify(json));
    return buildRawNote(leadData, parcelData, compTask, today, json.error?.message);
  } catch (err) {
    console.error("Anthropic fetch error:", err.message);
    return buildRawNote(leadData, parcelData, compTask, today, err.message);
  }
}

function buildRawNote(leadData, parcelData, compTask, today, errorMsg) {
  const p = parcelData || {};
  return `PARCEL ANALYSIS - Auto-generated ${today}

ADDRESS: ${p.situsfullstreetaddress || leadData.propertyAddress || "Unknown"}, ${p.situscity || ""} ${p.situsstate || ""} ${p.situszip5 || ""}
APN: ${p.apn || "Not found"}
FIPS: ${p.fips || "Unknown"}
OWNER OF RECORD: ${p.ownername1full || "Unknown"}
ACREAGE: ${p.lotsizeacres || "Unknown"} ac
ZONING: ${p.zoning || p.landusecode || "Unknown"}
LAST SALE: ${p.currentsalerecordingdate ? `${p.currentsalerecordingdate} / $${p.currentsaleprice || "Unknown"}` : "Unknown"}
ASSESSED VALUE: ${p.assessedtotalvalue ? `$${p.assessedtotalvalue}` : "Unknown"}
ABSENTEE OWNER: ${p.mailingfullstreetaddress && p.situsfullstreetaddress && p.mailingfullstreetaddress !== p.situsfullstreetaddress ? "Yes" : "Unknown"}

COMP REPORT: ${compTask ? `Task #${compTask.task_id} queued` : "Not queued"}

LEAD REASON: ${leadData.reason || "Not provided"}
${errorMsg ? `\nNOTE: AI synthesis unavailable (${errorMsg}). Raw parcel data shown above.` : ""}`;
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
    reason,
    propertyAddress,
    street,
    city,
    state: state?.toUpperCase(),
    zip,
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const payload = req.body;
    const lead = parseGHLWebhook(payload);

    console.log("Lead parsed:", JSON.stringify(lead));
    console.log("ANTHROPIC_API_KEY present:", !!CLAUDE_API_KEY, "length:", CLAUDE_API_KEY?.length);
    console.log("GHL_API_KEY present:", !!GHL_API_KEY);
    console.log("LP_JWT present:", !!LP_JWT);

    if (!lead.contactId) return res.status(400).json({ error: "No contact ID in payload" });
    if (!lead.propertyAddress) return res.status(200).json({ message: "No property address, skipped" });

    const searchResult = await lpSearch(lead.street, lead.state);
    let parcelData = null;
    let compTask = null;

    if (searchResult?.propertyid && searchResult?.fips) {
      parcelData = await lpPropertyData(searchResult.propertyid, searchResult.fips);
      compTask = await lpQueueCompReport(searchResult.propertyid, searchResult.fips);
    }

    const note = await synthesizeWithClaude(lead, parcelData, compTask);
    console.log("Note generated, length:", note?.length);

    const ghlResult = await ghlAddNote(lead.contactId, note);
    console.log("GHL note result:", JSON.stringify(ghlResult));

    return res.status(200).json({
      success: true,
      contactId: lead.contactId,
      parcelFound: !!parcelData,
      compTaskId: compTask?.task_id || null,
      notePosted: !!ghlResult,
    });
  } catch (err) {
    console.error("Handler error:", err);
    return res.status(500).json({ error: err.message });
  }
}
