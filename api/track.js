/**
 * Report-view beacon  —  GET /api/track?c=<contactId>
 *
 * The report page pings this when it loads. We tag the contact `analysis-viewed`
 * (which drives the follow-up workflow) and return a 1×1 transparent GIF. This
 * page-view signal replaces trigger links in the automated path — it's stronger
 * than a click and sidesteps the broken update_link API.
 *
 * Intentionally unauthenticated (it runs from the lead's browser) and always
 * returns the pixel, even on error, so it never breaks the report render.
 */

import { addTags } from "../lib/ghlfields.js";

// 1×1 transparent GIF.
const PIXEL = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

function sendPixel(res) {
  res.setHeader("Content-Type", "image/gif");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.statusCode = 200;
  return res.end(PIXEL);
}

export default async function handler(req, res) {
  const contactId = req.query?.c || req.query?.contactId || req.query?.slug || null;
  if (contactId) {
    try {
      await addTags(contactId, ["analysis-viewed"]);
    } catch (err) {
      console.error("track: tag failed", err.message);
    }
  }
  return sendPixel(res);
}
