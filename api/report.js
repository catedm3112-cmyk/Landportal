// api/report.js
// Renders the TruTerra Land Analysis report from contact custom-field JSON.
// URL: /r/:slug  (rewritten via vercel.json; slug = GHL contactId)
// Per-property OG tags baked in -> correct iMessage preview on every report.

const GHL_BASE = "https://services.leadconnectorhq.com";
const CF_JSON_KEY = "land_analysis_json";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function money(n) {
  return "$" + Number(n).toLocaleString("en-US");
}

function render(d, slug) {
  const range = `${money(d.value_low)} – ${money(d.value_high)}`;
  const comps = (d.comps || [])
    .map(
      (c) => `<div class="comp"><div><div class="where">${esc(c.location)}</div><div class="desc">${esc(c.desc)}</div></div><div class="num"><div class="price">${esc(c.price)}</div><div class="peracre">${esc(c.per_acre)}</div></div></div>`
    )
    .join("");
  const date = new Date(d.generated).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Land Analysis — ${esc(d.address)} | TruTerra</title>
<meta property="og:type" content="website">
<meta property="og:site_name" content="TruTerra — Land Advisory">
<meta property="og:title" content="Your Land Analysis — ${esc(d.address)}">
<meta property="og:description" content="Prepared property valuation from TruTerra Land Advisory: market range, comparables, and property details.">
<meta property="og:image" content="${process.env.REPORT_BASE_URL || "https://landportal-coral.vercel.app"}/og-cover.png">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image"><meta name="theme-color" content="#1A1A18">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=Montserrat:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--ink:#1A1A18;--paper:#FAF8F4;--card:#FFF;--gold:#C8965A;--tan:#C8B89A;--rule:#E7E0D2;--muted:#6E685C}
*{margin:0;padding:0;box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font-family:'Montserrat',sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
.wrap{max-width:680px;margin:0 auto}
header{background:var(--ink);color:#F5F1E8;padding:44px 24px 40px}
.brandline{display:flex;align-items:center;gap:12px;margin-bottom:34px}
.mark{width:34px;height:34px}.brand{font-family:'Cormorant Garamond',serif;font-size:26px;font-weight:500}.brand span{color:var(--tan)}
.eyebrow{font-size:11px;font-weight:600;letter-spacing:.28em;text-transform:uppercase;color:var(--gold);margin-bottom:10px}
h1{font-family:'Cormorant Garamond',serif;font-weight:500;font-size:34px;line-height:1.15}
.meta{margin-top:18px;font-size:12.5px;color:#B8B2A4;display:flex;flex-wrap:wrap;gap:6px 22px}.meta b{color:#E8E2D4}
.hero{background:var(--card);border-bottom:1px solid var(--rule);padding:40px 24px 44px;text-align:center}
.hero .eyebrow{color:var(--muted)}
.range{font-family:'Cormorant Garamond',serif;font-weight:600;font-size:42px;line-height:1.05;margin:6px 0 4px}
.range em{font-style:normal;color:var(--gold);padding:0 4px}
.basis{font-size:12.5px;color:var(--muted)}
section{padding:36px 24px;border-bottom:1px solid var(--rule)}
.sec-title{font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600;margin-bottom:4px}
.sec-sub{font-size:12.5px;color:var(--muted);margin-bottom:22px}
.facts{display:grid;grid-template-columns:1fr 1fr;gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:10px;overflow:hidden}
.fact{background:var(--card);padding:16px 16px 14px}
.fact .k{font-size:10.5px;font-weight:600;letter-spacing:.18em;text-transform:uppercase;color:var(--muted);margin-bottom:4px}
.fact .v{font-size:14.5px;font-weight:600;line-height:1.35}
.comp{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:16px 0;border-bottom:1px dashed var(--rule)}
.comp:last-of-type{border-bottom:none}
.comp .where{font-weight:600;font-size:14.5px}.comp .desc{font-size:12.5px;color:var(--muted);margin-top:2px}
.comp .num{text-align:right;flex:none}.comp .price{font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600}
.comp .peracre{font-size:11.5px;color:var(--gold);font-weight:600}
.comps-note{margin-top:14px;font-size:12.5px;color:var(--muted);border-left:2px solid var(--tan);padding-left:12px}
.callout{background:var(--card);border:1px solid var(--rule);border-left:3px solid var(--gold);border-radius:10px;padding:20px}
.callout .k{font-size:10.5px;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--gold);margin-bottom:8px}
.callout p{font-size:14px;line-height:1.65}
.cta{background:var(--ink);color:#F5F1E8;text-align:center;padding:44px 24px 48px;border-bottom:none}
.cta .sec-title{color:#F5F1E8}.cta p{font-size:13.5px;color:#B8B2A4;max-width:420px;margin:8px auto 26px}
.btns{display:flex;flex-direction:column;gap:12px;max-width:340px;margin:0 auto}
.btn{display:block;text-decoration:none;font-weight:700;font-size:14px;letter-spacing:.08em;text-transform:uppercase;padding:16px 20px;border-radius:8px}
.btn-gold{background:linear-gradient(135deg,var(--gold),#B8834A);color:#1A1A18}
.btn-line{border:1px solid #4A463C;color:#E8E2D4}
footer{padding:30px 24px 44px;text-align:center;font-size:12px;color:var(--muted)}
footer .fbrand{font-family:'Cormorant Garamond',serif;font-size:19px;color:var(--ink)}footer .fbrand span{color:var(--gold)}
footer .disclaimer{margin-top:16px;font-size:11px;line-height:1.6;max-width:520px;margin-left:auto;margin-right:auto}
@media(min-width:560px){h1{font-size:40px}.range{font-size:54px}.btns{flex-direction:row}.btn{flex:1}}
</style></head><body><div class="wrap">
<header><div class="brandline">
<svg class="mark" viewBox="0 0 48 48" fill="none" stroke="#C8B89A" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M4 40 L20 16 L30 30 L36 20 L44 40 Z"/><path d="M16 40 L16 30 L24 22 L32 30 L32 40"/></svg>
<div class="brand">Tru<span>Terra</span></div></div>
<div class="eyebrow">Land Analysis</div>
<h1>${esc(d.address)}<br>${esc(d.county)} County, Tennessee</h1>
<div class="meta"><div>Prepared for <b>${esc(d.prepared_for)}</b></div><div><b>${esc(date)}</b></div><div>Parcel <b>${esc(d.parcel_id)}</b></div></div>
</header>
<div class="hero"><div class="eyebrow">Opinion of Market Value</div>
<div class="range">${money(d.value_low)}<em>–</em>${money(d.value_high)}</div>
<div class="basis">Based on current market data and public records</div></div>
<section><div class="sec-title">Your Property</div><div class="sec-sub">As recorded with the ${esc(d.county)} County Assessor</div>
<div class="facts">
<div class="fact"><div class="k">Acreage</div><div class="v">${esc(d.acres)} deeded acres</div></div>
<div class="fact"><div class="k">Zoning</div><div class="v">${esc(d.facts?.zoning_guess || "See report")}</div></div>
<div class="fact"><div class="k">Utilities</div><div class="v">${esc(d.facts?.utilities_guess || "See report")}</div></div>
<div class="fact"><div class="k">Parcel</div><div class="v">${esc(d.parcel_id)}</div></div>
</div></section>
<section><div class="sec-title">What the Market Shows</div><div class="sec-sub">Current land activity in your area</div>
${comps}<div class="comps-note">${esc(d.market_note)}</div></section>
<section><div class="callout"><div class="k">Worth Knowing</div><p>${esc(d.strategic_note)}</p></div></section>
<section class="cta"><div class="sec-title">Questions about your number?</div>
<p>I'm glad to walk the property with you and firm up where you land in the range — no obligation either way.</p>
<div class="btns"><a class="btn btn-gold" href="tel:+18655057782">Call Dillon</a>
<a class="btn btn-line" href="sms:+18655057782?&body=${encodeURIComponent(`Hi Dillon, I received my land analysis for ${d.address} and have a question.`)}">Text Us</a></div></section>
<footer><div class="fbrand">Tru<span>Terra</span> · Land Advisory</div>
<div>dillon@truterra-group.com · <a href="https://truterra-group.com" style="color:inherit">truterra-group.com</a></div>
<div class="disclaimer">This report is an opinion of value prepared from public records and current market data. It is not a formal appraisal. Comparable figures reflect current offerings and are subject to change. Prepared ${esc(date)}.</div></footer>
</div>
<script>fetch('/api/track?slug=${esc(slug)}',{method:'POST'}).catch(()=>{});</script>
</body></html>`;
}

export default async (req, res) => {
  const slug = req.query.slug;
  if (!slug) return res.status(400).send("Not found");
  try {
    const r = await fetch(`${GHL_BASE}/contacts/${slug}`, {
      headers: { Authorization: `Bearer ${process.env.GHL_API_KEY}`, Version: "2021-07-28" },
    });
    const j = await r.json();
    const f = (j.contact?.customFields || []).find((x) => (x.fieldKey || "").endsWith(CF_JSON_KEY) || x.id === "u1nD05qbxNDboQQgsnrH");
    if (!f?.value) return res.status(404).send("Report not found");
    const data = JSON.parse(f.value);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=300");
    return res.status(200).send(render(data, slug));
  } catch (e) {
    return res.status(500).send("Report temporarily unavailable");
  }
};
