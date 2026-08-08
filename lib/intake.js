// lib/intake.js — shared lead-intake flow: enrich -> score -> tag contact -> contact note.
// Used by api/lead-intake-webhook.js (GHL workflow webhook) and the intake_lead MCP tool.
import { searchAndFetchProperty } from "./landportal.js";
import { scoreLead } from "./scoring.js";
import { addContactNote, updateContactBasic } from "./ghl.js";

export function cleanIntakeInput(body) {
  return {
    contactId: body.contactId || body.contact_id,
    propertyInput:
      body.propertyInput ||
      body.property_input ||
      body.apn ||
      body.parcel ||
      body.address,
    owner: body.owner || body.ownerName,
    state: body.state || "TN",
    source: body.source || "Unknown",
  };
}

// APNs/parcel numbers are digits, dots, and dashes ("058-079.00"); anything with a
// real word in it ("301 Matterhorn Dr") is a street address. Route accordingly so
// Land Portal searches the right index.
export function smartPropertyQuery(propertyInput, owner, state) {
  const looksLikeAddress = /[a-z]{3,}/i.test(propertyInput || "");
  return {
    ...(looksLikeAddress ? { address: propertyInput } : { parcel: propertyInput }),
    owner,
    state: state || "TN",
  };
}

export async function runLeadIntake(input) {
  if (!input.contactId) {
    return { ok: false, statusCode: 400, message: "Missing contactId." };
  }

  if (!input.propertyInput && !input.owner) {
    await updateContactBasic({
      contactId: input.contactId,
      tags: ["Land Lead - Missing Property Info"],
    });
    return {
      ok: false,
      statusCode: 400,
      message: "Missing property input or owner name.",
    };
  }

  const enriched = await searchAndFetchProperty(
    smartPropertyQuery(input.propertyInput, input.owner, input.state)
  );

  const leadScore = scoreLead(enriched.property);

  await updateContactBasic({
    contactId: input.contactId,
    tags: leadScore.tags,
  });

  const p = enriched.property;

  const note = [
    "LandPortal Parcel Enrichment",
    "",
    `Status: ${leadScore.status}`,
    `Score: ${leadScore.score}`,
    "",
    p ? `APN: ${p.apn || "N/A"}` : "APN: N/A",
    p ? `Property ID: ${p.propertyId || "N/A"}` : "Property ID: N/A",
    p ? `FIPS: ${p.fips || "N/A"}` : "FIPS: N/A",
    p ? `Address: ${p.situsAddress || "N/A"}` : "Address: N/A",
    p ? `City: ${p.situsCity || "N/A"}` : "City: N/A",
    p ? `State: ${p.situsState || "N/A"}` : "State: N/A",
    p ? `County: ${p.situsCounty || "N/A"}` : "County: N/A",
    p ? `Acreage: ${p.lotSizeAcres || "N/A"}` : "Acreage: N/A",
    p ? `Owner: ${p.ownerName || "N/A"}` : "Owner: N/A",
    "",
    "Reasons:",
    ...leadScore.reasons.map((reason) => `- ${reason}`),
  ].join("\n");

  await addContactNote({
    contactId: input.contactId,
    body: note,
  });

  return {
    ok: true,
    statusCode: 200,
    message: "Lead enriched and contact updated.",
    contactId: input.contactId,
    property: p,
    score: leadScore,
    matchType: enriched.matchType,
    searchMatch: enriched.searchMatch,
    meta: enriched.meta,
  };
}
