// api/track.js
// First-party report-view tracking: fired by the report page on load.
// Adds "analysis-viewed" tag to the contact -> GHL workflow branches on it.
// Replaces trigger-link click tracking for automated reports (update_link API is broken;
// page-view is a stronger signal than link-click anyway).

const GHL_BASE = "https://services.leadconnectorhq.com";

export default async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).json({ ok: false });
  try {
    await fetch(`${GHL_BASE}/contacts/${slug}/tags`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GHL_API_KEY}`,
        Version: "2021-07-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tags: ["analysis-viewed"] }),
    });
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(200).json({ ok: false }); // never break page load
  }
};
