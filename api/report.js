/**
 * Dynamic branded Land Analysis report  —  GET /r/:contactId
 * (routed here by vercel.json as /api/report?slug=:contactId)
 *
 * Renders the client-safe analysis stored on the contact's `land_analysis_json`
 * custom field, with per-property Open Graph tags so a shared link previews with
 * the property in the title. A view beacon (→ /api/track) tags the contact
 * `analysis-viewed`, which is a stronger intent signal than a click and the
 * reason the automated path uses no trigger links.
 *
 * Only client-safe data is rendered — the engine deliberately keeps adjoiner
 * owner names out of `land_analysis_json`, so there is nothing private to leak
 * even though this page is unauthenticated (keyed by the opaque contact id).
 */

import { getContact, readContactField } from "../lib/ghlfields.js";

function reportBase() {
  return (process.env.REPORT_BASE_URL || "https://landportal-coral.vercel.app").replace(/\/+$/, "");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmtMoney(n) {
  const num = Number(n);
  return Number.isFinite(num) ? `$${Math.round(num).toLocaleString("en-US")}` : null;
}

function shell({ title, description, ogImage, url, body }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(ogImage)}">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(ogImage)}">
<meta name="robots" content="noindex">
<style>
  :root{--green:#1d3b2a;--green2:#24432f;--gold:#c9a24b;--cream:#f4f1e6;--ink:#20261f;--muted:#5c6b57;--line:#e2e0d3}
  *{box-sizing:border-box}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);background:#f7f6ef;line-height:1.55}
  a{color:#2b6b45}
  .hero{background:linear-gradient(135deg,var(--green),var(--green2));color:var(--cream);padding:40px 24px 44px}
  .wrap{max-width:760px;margin:0 auto;padding:0 24px}
  .brand{font-weight:800;letter-spacing:.18em;font-size:14px;color:var(--gold);text-transform:uppercase}
  .hero h1{margin:8px 0 4px;font-size:26px;line-height:1.2}
  .hero .sub{opacity:.85;font-size:15px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:22px 22px;margin:18px 0;box-shadow:0 1px 2px rgba(0,0,0,.03)}
  .range{font-size:34px;font-weight:800;color:var(--green);letter-spacing:-.5px}
  .label{text-transform:uppercase;letter-spacing:.12em;font-size:12px;color:var(--muted);font-weight:700;margin-bottom:6px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px}
  .stat .v{font-size:19px;font-weight:700}
  .pill{display:inline-block;font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px;background:#eef3ea;color:#2b6b45;text-transform:capitalize}
  .comp{border-top:1px solid var(--line);padding:12px 0;display:flex;justify-content:space-between;gap:12px;font-size:14px}
  .comp:first-child{border-top:0}
  .comp .price{font-weight:700;white-space:nowrap}
  .worth{background:#f3f0e4;border-left:4px solid var(--gold);padding:14px 16px;border-radius:0 10px 10px 0;font-size:15px}
  .foot{color:var(--muted);font-size:13px;text-align:center;padding:26px 24px 40px}
  .cta{display:inline-block;background:var(--green);color:var(--cream)!important;text-decoration:none;font-weight:700;padding:11px 20px;border-radius:10px;margin-top:6px}
  .disc{font-size:12px;color:var(--muted);margin-top:8px}
</style>
</head>
<body>
${body}
</body>
</html>`;
}

function renderReport(a, contactId) {
  const first = a?.client?.firstName ? esc(a.client.firstName) : "there";
  const propLabel = a?.client?.propertyLabel || "your property";
  const range = a?.value?.range || "Estimate pending";
  const conf = a?.value?.confidence || "";
  const acres = a?.parcel?.acres;
  const county = a?.parcel?.county;
  const ppa = a?.value?.ppaLow && a?.value?.ppaHigh ? `${fmtMoney(a.value.ppaLow)} – ${fmtMoney(a.value.ppaHigh)}/ac` : null;
  const satellite = (a?.mapLinks || []).find((l) => /Satellite/i.test(l))?.replace(/^Satellite:\s*/i, "") || null;

  const comps = (a?.value?.comps || [])
    .map((c) => {
      const price = fmtMoney(c.price);
      const meta = [c.acres != null ? `${c.acres} ac` : null, c.ppa ? `${fmtMoney(c.ppa)}/ac` : null, c.source].filter(Boolean).join(" · ");
      return `<div class="comp"><div>${esc(c.summary || "Comparable land")}${meta ? `<br><span style="color:#5c6b57;font-size:13px">${esc(meta)}</span>` : ""}</div>${price ? `<div class="price">${esc(price)}</div>` : ""}</div>`;
    })
    .join("");

  const stats = [
    acres != null ? `<div class="stat"><div class="label">Acreage</div><div class="v">${esc(acres)} ac</div></div>` : "",
    county ? `<div class="stat"><div class="label">County</div><div class="v">${esc(county)}, TN</div></div>` : "",
    ppa ? `<div class="stat"><div class="label">Per acre</div><div class="v">${esc(ppa)}</div></div>` : "",
  ].filter(Boolean).join("");

  const body = `
<div class="hero">
  <div class="wrap" style="padding:0">
    <div class="brand">TruTerra · Land Analysis</div>
    <h1>${esc(propLabel)}</h1>
    <div class="sub">Prepared for ${first} by The TruTerra Group — Sevier County, TN</div>
  </div>
</div>
<div class="wrap">
  <div class="card">
    <div class="label">Estimated value range</div>
    <div class="range">${esc(range)}</div>
    ${conf ? `<div style="margin-top:10px"><span class="pill">${esc(conf)} confidence</span></div>` : ""}
    ${a?.value?.basis ? `<div class="disc">${esc(a.value.basis)}</div>` : ""}
    ${stats ? `<div class="grid" style="margin-top:18px">${stats}</div>` : ""}
  </div>

  ${a?.adjoinerNote ? `<div class="card"><div class="label">Worth knowing</div><div class="worth">${esc(a.adjoinerNote)}</div></div>` : ""}

  ${comps ? `<div class="card"><div class="label">Comparable land nearby</div>${comps}</div>` : ""}

  <div class="card" style="text-align:center">
    <div class="label" style="margin-bottom:10px">Questions about the range or the comps?</div>
    <a class="cta" href="tel:+18655057782">Call or text Dillon · 865-505-7782</a>
    ${satellite ? `<div style="margin-top:14px"><a href="${esc(satellite)}" target="_blank" rel="noopener">View the parcel on the map →</a></div>` : ""}
    <div class="disc">This is a preliminary, no-obligation estimate based on public parcel data and recent market comps — not a formal appraisal. Figures may change on closer review.</div>
  </div>
</div>
<div class="foot">The TruTerra Group · Sevier County, Tennessee · 865-505-7782</div>

<img src="/api/track?c=${encodeURIComponent(contactId)}" alt="" width="1" height="1" style="position:absolute;left:-9999px" referrerpolicy="no-referrer">
<script>try{fetch("/api/track?c=${encodeURIComponent(contactId)}",{method:"GET",keepalive:true,cache:"no-store"});}catch(e){}</script>
`;
  return body;
}

function renderPending(first) {
  return `
<div class="hero"><div class="wrap" style="padding:0">
  <div class="brand">TruTerra · Land Analysis</div>
  <h1>Your analysis is being prepared</h1>
  <div class="sub">Hi ${esc(first || "there")} — we're pulling your parcel details and comps together now.</div>
</div></div>
<div class="wrap"><div class="card">
  <p>Your personalized land analysis isn't quite ready yet. It usually takes just a little while — check back shortly, or reach out and we'll walk you through it.</p>
  <a class="cta" href="tel:+18655057782">Call or text Dillon · 865-505-7782</a>
</div></div>
<div class="foot">The TruTerra Group · Sevier County, Tennessee</div>`;
}

export default async function handler(req, res) {
  const contactId = req.query?.slug || req.query?.contactId || req.query?.c || null;
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  if (!contactId) {
    res.statusCode = 404;
    return res.end(shell({ title: "Land Analysis — TruTerra", description: "Report not found.", ogImage: `${reportBase()}/og-cover.png`, url: reportBase(), body: renderPending("") }));
  }

  try {
    const contact = await getContact(contactId);
    const first = contact?.firstName || contact?.first_name || "";
    const raw = contact ? await readContactField(contact, "land_analysis_json") : null;

    let analysis = null;
    if (raw) {
      try {
        analysis = typeof raw === "string" ? JSON.parse(raw) : raw;
      } catch {
        analysis = null;
      }
    }

    if (!analysis) {
      res.statusCode = 200;
      // Do not cache a not-ready page; it will fill in once the engine finishes.
      res.setHeader("Cache-Control", "no-store");
      return res.end(shell({
        title: "Land Analysis — TruTerra",
        description: "Your TruTerra land analysis is being prepared.",
        ogImage: `${reportBase()}/og-cover.png`,
        url: `${reportBase()}/r/${encodeURIComponent(contactId)}`,
        body: renderPending(first),
      }));
    }

    const propLabel = analysis?.client?.propertyLabel || "Your property";
    const range = analysis?.value?.range || "";
    const title = `Land Analysis — ${propLabel}`;
    const description = `${first ? `${first}'s property` : "Your property"} · Estimated value ${range || "range inside"} — full report with comps from The TruTerra Group.`;

    res.statusCode = 200;
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=300");
    return res.end(shell({
      title,
      description,
      ogImage: `${reportBase()}/og-cover.png`,
      url: `${reportBase()}/r/${encodeURIComponent(contactId)}`,
      body: renderReport(analysis, contactId),
    }));
  } catch (err) {
    console.error("Report render error:", err);
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    return res.end(shell({
      title: "Land Analysis — TruTerra",
      description: "Your TruTerra land analysis.",
      ogImage: `${reportBase()}/og-cover.png`,
      url: `${reportBase()}/r/${encodeURIComponent(contactId)}`,
      body: renderPending(""),
    }));
  }
}
