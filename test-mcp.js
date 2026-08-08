// test-mcp.js — live protocol test for api/mcp.js.
// Usage: node test-mcp.js "https://landportal-coral.vercel.app/api/mcp?key=SECRET" ["<propertyInput>"]
// Runs: initialize -> tools/list -> tools/call enrich_property -> bad-key 401 check.

const url = process.argv[2];
const sample = process.argv[3] || "301 Matterhorn Dr, Gatlinburg";

if (!url) {
  console.error("Usage: node test-mcp.js <mcp-url-with-key> [propertyInput]");
  process.exit(1);
}

async function rpc(endpoint, method, params, id) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    const dataLines = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (dataLines.length) {
      try {
        body = JSON.parse(dataLines[dataLines.length - 1]);
      } catch {}
    }
  }
  return { status: res.status, body, raw: text.slice(0, 300) };
}

let failures = 0;
function check(label, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

const r1 = await rpc(url, "initialize", {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "truterra-test", version: "1.0" },
}, 1);
check(
  "initialize",
  r1.status === 200 && r1.body?.result?.serverInfo?.name === "truterra-landportal",
  r1.body?.result?.serverInfo?.name || `HTTP ${r1.status} ${r1.raw}`
);

const r2 = await rpc(url, "tools/list", {}, 2);
const toolNames = (r2.body?.result?.tools || []).map((t) => t.name).sort();
check(
  "tools/list has all 4 tools",
  JSON.stringify(toolNames) ===
    JSON.stringify(["enrich_property", "intake_lead", "land_analysis_status", "score_lead"]),
  toolNames.join(", ") || `HTTP ${r2.status} ${r2.raw}`
);

const r3 = await rpc(url, "tools/call", {
  name: "enrich_property",
  arguments: { propertyInput: sample, state: "TN" },
}, 3);
let enriched = null;
try {
  enriched = JSON.parse(r3.body?.result?.content?.[0]?.text || "null");
} catch {}
check(
  "enrich_property returns structured result",
  r3.status === 200 && enriched && typeof enriched.success === "boolean",
  enriched
    ? `success=${enriched.success} matchType=${enriched.matchType} apn=${enriched.property?.apn || "-"} acres=${enriched.property?.lotSizeAcres || "-"} county=${enriched.property?.situsCounty || "-"} owner=${(enriched.property?.ownerName || "-").slice(0, 30)}`
    : `HTTP ${r3.status} ${r3.raw}`
);

const badUrl = url.replace(/key=[^&]+/, "key=wrong");
const r4 = await rpc(badUrl, "tools/list", {}, 4);
check("wrong key rejected with 401", r4.status === 401, `HTTP ${r4.status}`);

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
