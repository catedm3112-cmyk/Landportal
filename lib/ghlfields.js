/**
 * GHL (LeadConnector v2) helpers for the Land Analysis engine: contact fetch,
 * custom-field read/write by key, and tag add.
 *
 * Custom fields in GHL are addressed by opaque id, but the engine wants to talk
 * in stable keys (`land_analysis_status`, …). We fetch the location's custom-field
 * catalog once, build a key→id map, and translate. Reads come back on `.value`,
 * writes go out on `.field_value` — that asymmetry is the v2 API's, not ours.
 */

export const GHL_BASE = "https://services.leadconnectorhq.com";
export const LOCATION_ID = "EHl75N7YlN7nOMP30CYm";

const GHL_VERSION = "2021-07-28";

function apiKey() {
  const k = process.env.GHL_API_KEY;
  if (!k) throw new Error("Missing GHL_API_KEY");
  return k;
}

async function ghlFetch(path, init = {}) {
  const res = await fetch(`${GHL_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      Version: GHL_VERSION,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.message || `GHL ${res.status} on ${path}`);
  return data;
}

// ── contact ──────────────────────────────────────────────────────────────────────
export async function getContact(contactId) {
  const data = await ghlFetch(`/contacts/${contactId}`);
  return data?.contact || data || null;
}

// ── custom-field catalog (cached across warm invocations) ────────────────────────
let _fieldMap = null;

// Normalizes a fieldKey/name to its bare key: "contact.land_analysis_status" →
// "land_analysis_status", "Land Analysis Status" → "land_analysis_status".
function bareKey(s) {
  return String(s || "")
    .replace(/^contact\./i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function fieldMap() {
  if (_fieldMap) return _fieldMap;
  const data = await ghlFetch(`/locations/${LOCATION_ID}/customFields`);
  const list = data?.customFields || data?.customField || [];
  const map = new Map();
  for (const f of list) {
    const id = f.id;
    for (const cand of [f.fieldKey, f.key, f.name]) {
      const bk = bareKey(cand);
      if (bk && !map.has(bk)) map.set(bk, id);
    }
  }
  _fieldMap = map;
  return map;
}

// Read a custom-field value off an already-fetched contact object, by key.
export async function readContactField(contact, key) {
  const map = await fieldMap();
  const id = map.get(bareKey(key));
  const cf = contact?.customFields || contact?.customField || [];
  const hit = cf.find((c) => c.id === id || bareKey(c.fieldKey || c.key) === bareKey(key));
  if (!hit) return null;
  return hit.value ?? hit.field_value ?? hit.fieldValue ?? null;
}

// Write custom fields by key. Silently skips keys the location doesn't define.
export async function updateContactFields(contactId, values) {
  const map = await fieldMap();
  const customFields = [];
  for (const [key, value] of Object.entries(values)) {
    const id = map.get(bareKey(key));
    if (id) customFields.push({ id, field_value: value });
  }
  if (!customFields.length) return { skipped: true };
  return ghlFetch(`/contacts/${contactId}`, {
    method: "PUT",
    body: JSON.stringify({ customFields }),
  });
}

// ── tags & notes ────────────────────────────────────────────────────────────────
export async function addTags(contactId, tags) {
  return ghlFetch(`/contacts/${contactId}/tags`, {
    method: "POST",
    body: JSON.stringify({ tags }),
  });
}

export async function addNote(contactId, body) {
  return ghlFetch(`/contacts/${contactId}/notes`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}
