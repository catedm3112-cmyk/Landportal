import { searchAndFetchProperty } from "../lib/landportal.js";
import { scoreLead } from "../lib/scoring.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    const result = await searchAndFetchProperty({
      propertyid: body.propertyid || body.propertyId,
      fips: body.fips,
      apn: body.apn,
      parcel: body.parcel || body.propertyInput || body.property_input,
      owner: body.owner || body.ownerName,
      state: body.state || "TN",
    });

    const score = scoreLead(result.property);

    return res.status(200).json({
      success: result.success,
      matchType: result.matchType,
      searchMatch: result.searchMatch,
      property: result.property,
      score,
      meta: result.meta,
      message: result.success ? "Property enriched." : result.message,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Unexpected enrichment error.",
    });
  }
}
