// api/mcp.js — Streamable HTTP MCP server exposing landportal enrichment to the
// TruTerra Ops Super Agent (GHL Agent Studio -> Apps -> Add custom MCP).
//
// v1 is deliberately read/enrich-only (see MCP-WRAPPER-BRIEF.md): no send/message/
// delete tools, and no run_land_analysis — the full engine runs up to 300s and its
// delivery is human-gated by Dillon.
//
// Auth: the GHL "Add custom MCP" dialog takes a URL (+ optional OAuth), no custom
// headers — so the shared secret rides in the URL: /api/mcp?key=<MCP_SECRET>.
// Env required: MCP_SECRET, GHL_API_KEY, LAND_PORTAL_API_V2_KEY.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { searchAndFetchProperty } from "../lib/landportal.js";
import { scoreLead } from "../lib/scoring.js";
import { runLeadIntake, smartPropertyQuery } from "../lib/intake.js";
import { getContact, cfValue } from "../lib/ghl.js";

// Land Analysis contact custom fields (same map as api/land-analysis.js).
const CF = {
  status: "v38gufyBCk4NQWps4kua",
  valueRange: "ESSwcgMa05dRJbCkfDnY",
  reportUrl: "gjiHDIBFPD7orJJ4Zu8C",
};

function json(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function buildServer() {
  const server = new McpServer({ name: "truterra-landportal", version: "1.0.0" });

  server.tool(
    "enrich_property",
    "Look up a parcel (East Tennessee / Sevier County focus) by address, APN, or parcel number, optionally with the owner name. Returns county-record facts: APN, acreage, county, situs address, owner, and match type. Facts come from Land Portal county records — anything missing or unmatched is unknown; never guess it. Use this before classifying a landowner/seller lead that names a property, and cite the confirmed facts in your contact note.",
    {
      propertyInput: z
        .string()
        .describe("Address, APN, or parcel number exactly as the lead gave it"),
      owner: z.string().optional().describe("Owner name if known (improves matching)"),
      state: z.string().optional().describe("Two-letter state code, default TN"),
    },
    async ({ propertyInput, owner, state }) => {
      const r = await searchAndFetchProperty(smartPropertyQuery(propertyInput, owner, state));
      return json({
        success: r.success,
        matchType: r.matchType,
        property: r.property,
        message: r.message ?? null,
      });
    }
  );

  server.tool(
    "score_lead",
    "Score a land lead 0-100 from parcel facts (acreage, county, owner, APN completeness). Pass the property object returned by enrich_property, or pass propertyInput to resolve-then-score in one call. Returns { score, status, tags, reasons }. Informational only — apply YOUR OWN exact tags from your instructions, not the tags this tool returns.",
    {
      property: z
        .record(z.any())
        .optional()
        .describe("Property object from a previous enrich_property call"),
      propertyInput: z
        .string()
        .optional()
        .describe("Address/APN/parcel to resolve first, if no property object"),
      owner: z.string().optional().describe("Owner name (used with propertyInput)"),
      state: z.string().optional().describe("Two-letter state code, default TN"),
    },
    async ({ property, propertyInput, owner, state }) => {
      if (!property && !propertyInput) {
        return json({
          success: false,
          message: "Pass either property (from enrich_property) or propertyInput.",
        });
      }
      let resolved = property || null;
      let matchType = "provided_object";
      if (!resolved) {
        const r = await searchAndFetchProperty(smartPropertyQuery(propertyInput, owner, state));
        resolved = r.property;
        matchType = r.matchType;
      }
      const score = scoreLead(resolved);
      return json({ success: true, matchType, score });
    }
  );

  server.tool(
    "intake_lead",
    "Run the full one-shot intake on a GHL contact: enrich the parcel, score it, then WRITE to the contact (adds legacy 'Land Lead - …' scoring tags and a parcel-enrichment note). Mirrors the lead-intake webhook. Do NOT use this during normal triage — you already tag and note contacts yourself with exact tag strings; this is for backfill or explicit one-shot enrichment requests only.",
    {
      contactId: z.string().describe("GHL contact ID to enrich and write to"),
      propertyInput: z
        .string()
        .optional()
        .describe("Address, APN, or parcel number for the contact's property"),
      owner: z.string().optional().describe("Owner name, if property input is missing"),
      source: z.string().optional().describe("Where this intake came from"),
    },
    async ({ contactId, propertyInput, owner, source }) => {
      const result = await runLeadIntake({
        contactId,
        propertyInput,
        owner,
        state: "TN",
        source: source || "mcp",
      });
      const { ok, statusCode, meta, searchMatch, ...rest } = result;
      return json({ success: ok, ...rest });
    }
  );

  server.tool(
    "land_analysis_status",
    "Check where the Land Analysis stands for a GHL contact. Reads the Land Analysis Status, Value Range, and Report URL fields. Read-only. Use when someone asks about the status of an analysis. NEVER trigger or promise report delivery — that is human-approved by Dillon.",
    {
      contactId: z.string().describe("GHL contact ID to check"),
    },
    async ({ contactId }) => {
      const contact = await getContact(contactId);
      if (!contact) {
        return json({ success: false, message: "Contact not found." });
      }
      const status = cfValue(contact, CF.status);
      const valueRange = cfValue(contact, CF.valueRange);
      const reportUrl = cfValue(contact, CF.reportUrl);
      return json({
        success: true,
        contactId,
        analysisStatus: status || "not_started",
        valueRange: valueRange || null,
        hasReport: !!reportUrl,
        reportUrl: reportUrl || null,
      });
    }
  );

  return server;
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const key =
    url.searchParams.get("key") ||
    (req.headers.authorization || "").replace(/^Bearer\s+/i, "");

  if (!process.env.MCP_SECRET || key !== process.env.MCP_SECRET) {
    return res
      .status(401)
      .json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Stateless MCP endpoint — POST only." },
      id: null,
    });
  }

  // The Streamable HTTP spec wants both types in Accept; normalize picky clients.
  const accept = String(req.headers.accept || "");
  if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
    req.headers.accept = "application/json, text/event-stream";
  }

  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: new server per request
      enableJsonResponse: true,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: err?.message || "Internal server error" },
        id: null,
      });
    }
  }
}
