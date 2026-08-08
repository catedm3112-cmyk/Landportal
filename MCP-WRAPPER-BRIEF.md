# Handoff brief: landportal MCP wrapper for GHL Super Agents
**For: local Claude Code, working in `/Users/dmc/Documents/landportal`**
**Requested by Dillon · Aug 7, 2026**

## Why
GHL Super Agents (Agent Studio → Apps) support "+ Add custom MCP". The new TruTerra Ops Super Agent triages every inbound lead; giving it a thin MCP over landportal's existing lib functions lets it pull parcel facts and the lead score *during* triage — natively inside GHL. This replaces most of what the draft "Ai Operations Asst" workflow (14 versions) was trying to do.

## What to build
One new Vercel function in the existing landportal project: `api/mcp.js`, an MCP server over **Streamable HTTP** (`@modelcontextprotocol/sdk`), reusing the existing `lib/` modules directly — do NOT self-call the HTTP endpoints.

### Tools (v1 — deliberately read/enrich-only, least privilege)
1. **`enrich_property`** — input: `{ propertyInput (address|APN|parcel), owner?, state? (default "TN") }`. Wraps `searchAndFetchProperty` from `lib/landportal.js`. Returns the property object with the existing confirmed/unconfirmed pattern intact.
2. **`score_lead`** — input: the property object (or `propertyInput` to resolve-then-score). Wraps `scoreLead` from `lib/scoring.js`. Returns `{ score, status, tags, reasons }`.
3. **`intake_lead`** — input: `{ contactId, propertyInput?, owner?, source? }`. Mirrors `api/lead-intake-webhook.js` (enrich → score → tag contact → contact note) so the agent can run full intake in one call. Reuse that handler's logic as a shared function rather than duplicating.
4. **`land_analysis_status`** — input: `{ contactId }`. Reads the four Land Analysis custom fields (status `v38gufyBCk4NQWps4kua`, value range `ESSwcgMa05dRJbCkfDnY`, report URL `gjiHDIBFPD7orJJ4Zu8C`) so the agent can answer "where's the analysis for this contact" without touching the JSON blob.

### Explicitly OUT of v1
- No `run_land_analysis` tool — the full engine runs up to 300s, far beyond an in-chat tool call, and delivery is human-gated by Dillon. If wanted later, expose `queue_land_analysis` that fires the existing webhook async and returns immediately with "queued".
- No send/message/delete tools of any kind.

## Constraints & details
- **Auth:** bearer token via env var (e.g., `MCP_SECRET`, same pattern as `LAND_ANALYSIS_SECRET`). Check what the GHL "Add custom MCP" dialog supports for auth headers and match it; if it only takes a URL, put the token in the path/query and rotate it.
- **Timeouts:** keep every v1 tool under ~30s; `enrich_property` should reuse the 60s `maxDuration` pattern already in `vercel.json` (add the route + function entry).
- **Responses:** small, structured JSON. Preserve the "confirmed value + source | unconfirmed + verifyWith" discipline from the engine — the agent prompt forbids invented values, so the tool must never return guesses either.
- **Tool descriptions matter:** write them for the Super Agent as the consumer, e.g. `enrich_property`: "Look up a Sevier-area parcel by address or APN. Returns confirmed facts (acreage, zoning, owner, flood, slope) with sources. Use before classifying a landowner/seller lead."
- **Testing:** `test-mcp-full.js` pattern from the ghl-mcp repo is a good reference for a smoke test. Definition of done: URL + token pasted into GHL's Add custom MCP dialog, tools visible in the agent's Apps list, and one live triage run where the agent calls `enrich_property` on a real parcel and cites the result in its contact note.

## Context files to read first
- `api/lead-intake-webhook.js` (the flow being wrapped)
- `lib/landportal.js`, `lib/scoring.js`, `lib/ghl.js`
- `vercel.json` (routing + maxDuration pattern)
- `/Users/dmc/Documents/memory/ghl.md` (location IDs, standing rules — TruTerra location `EHl75N7YlN7nOMP30CYm` is the only target)
- `/Users/dmc/Documents/TruTerra LLC/truterra-ops-agent-prompt.md` (the agent that will consume these tools)
