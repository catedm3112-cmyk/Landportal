import { searchAndFetchProperty } from "../lib/landportal.js";
import { scoreLead } from "../lib/scoring.js";
import { addContactNote, updateContactBasic } from "../lib/ghl.js";

function cleanInput(body) {
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

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const input = cleanInput(body);

    if (!input.contactId) {
      return res.status(400).json({
        success: false,
        message: "Missing contactId.",
      });
    }

    if (!input.propertyInput && !input.owner) {
      await updateContactBasic({
        contactId: input.contactId,
        tags: ["Land Lead - Missing Property Info"],
      });

      return res.status(400).json({
        success: false,
        message: "Missing property input or owner name.",
      });
    }

    const enriched = await searchAndFetchProperty({
      parcel: input.propertyInput,
      owner: input.owner,
      state: input.state,
    });

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

    return res.status(200).json({
      success: true,
      message: "Lead enriched and contact updated.",
      contactId: input.contactId,
      property: p,
      score: leadScore,
      matchType: enriched.matchType,
      searchMatch: enriched.searchMatch,
      meta: enriched.meta,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Unexpected lead intake error.",
    });
  }
}
