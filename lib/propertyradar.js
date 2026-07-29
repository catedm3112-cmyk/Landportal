// lib/propertyradar.js
// PropertyRadar API v1 client.
//
// COST MODEL — read before changing anything here.
// Every property returned by a pay-per-record endpoint counts as one Export
// against the monthly quota and is NON-REFUNDABLE. The API provides a free
// pre-flight: Purchase=0 returns a count only and does not bill. So every call
// in this module defaults to Purchase=0, and spending is an explicit,
// deliberate act by the caller (`purchase: true`). Never flip that default.
//
// Env: PropertyRadarapi (the token as named in Vercel). Alternates accepted so
// a later rename doesn't silently break enrichment.

const RADAR_BASE = "https://api.propertyradar.com/v1";

function token() {
  return (
    process.env.PropertyRadarapi ||
    process.env.PROPERTY_RADAR_TOKEN ||
    process.env.PROPERTYRADAR_API_KEY ||
    null
  );
}

export function radarConfigured() {
  return Boolean(token());
}

async function radarPost(path, body, { purchase = 0, limit, start, fields } = {}) {
  const t = token();
  if (!t) throw new Error("PropertyRadar token not configured");

  const qs = new URLSearchParams({ Purchase: String(purchase ? 1 : 0) });
  if (limit != null) qs.set("Limit", String(limit));
  if (start != null) qs.set("Start", String(start));
  if (fields) qs.set("Fields", Array.isArray(fields) ? fields.join(",") : String(fields));

  const r = await fetch(`${RADAR_BASE}${path}?${qs}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${t}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PropertyRadar ${r.status}: ${text.slice(0, 200)}`);
  }
  if (!r.ok || json.error) {
    throw new Error(`PropertyRadar ${r.status}: ${json.error || text.slice(0, 200)}`);
  }
  return json;
}

const crit = (name, value) => ({ name, value: Array.isArray(value) ? value : [value] });

/** Raw criteria search. Defaults to a free count-only call. */
export function searchProperties(criteria, opts = {}) {
  return radarPost("/properties", { Criteria: criteria }, opts);
}

function resultRows(res) {
  return res?.results || res?.Results || res?.data || [];
}
// PropertyRadar returns BOTH `totalResultCount` (how many properties match the
// criteria) and `resultCount` (how many rows this response actually contains —
// always 0 on a free Purchase=0 call). The match count is the former; reading
// `resultCount` makes every free pre-flight look like a miss.
function resultCount(res) {
  return (
    res?.totalResultCount ??
    res?.TotalResultCount ??
    res?.totalCount ??
    res?.resultCount ??
    resultRows(res).length
  );
}

/** Free-records remaining, as reported by the last response. */
export function freeRemaining(res) {
  return res?.quantityFreeRemaining ?? null;
}

/**
 * Two-phase lookup: confirm the criteria resolve to exactly one property using
 * the free count call, then spend a single export to fetch it.
 * Returns { matched, count, property, spent }.
 */
export async function resolveOne(criteria, { maxAcceptable = 1 } = {}) {
  const counted = await searchProperties(criteria, { purchase: 0 });
  const count = resultCount(counted);

  if (count === 0) return { matched: false, count: 0, property: null, spent: false };
  if (count > maxAcceptable) {
    // Ambiguous — refuse to spend an export on a coin flip.
    return { matched: false, count, property: null, spent: false, ambiguous: true };
  }

  const bought = await searchProperties(criteria, { purchase: 1, limit: 1 });
  return { matched: true, count, property: resultRows(bought)[0] || null, spent: true };
}

export function byAddress({ address, city, state = "TN", zip }) {
  const c = [crit("Address", address), crit("State", state)];
  if (city) c.push(crit("City", city));
  if (zip) c.push(crit("ZipFive", String(zip)));
  return c;
}

export function byApn(apn, state = "TN") {
  return [crit("APN", apn), crit("State", state)];
}

export function byRadarId(radarId) {
  return [crit("RadarID", radarId)];
}

export function byOwnerName(name, state = "TN") {
  return [crit("OwnerName", name), crit("State", state)];
}

async function radarGet(path, { purchase = 0, fields, limit } = {}) {
  const t = token();
  if (!t) throw new Error("PropertyRadar token not configured");
  const qs = new URLSearchParams({ Purchase: String(purchase ? 1 : 0) });
  if (fields) qs.set("Fields", Array.isArray(fields) ? fields.join(",") : String(fields));
  if (limit != null) qs.set("Limit", String(limit));

  const r = await fetch(`${RADAR_BASE}${path}?${qs}`, {
    headers: { Authorization: `Bearer ${t}`, Accept: "application/json" },
  });
  const text = await r.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`PropertyRadar ${r.status}: ${text.slice(0, 200)}`);
  }
  if (!r.ok || json.error) {
    throw new Error(`PropertyRadar ${r.status}: ${json.error || text.slice(0, 200)}`);
  }
  return json;
}

/**
 * People linked to a property, with the other properties each one owns.
 *
 * This is the ONLY reliable way to roll up an owner's holdings. Searching by
 * OwnerName is a text match: "WILSON,JERRY L" in TN returns two parcels in
 * Anderson County belonging to a different Jerry L Wilson, and does not even
 * include the Sevier parcel whose Owner field is that exact string. The
 * property -> person edge is identity-based and does not have that failure mode.
 */
export async function propertyPersons(radarId, { purchase = true } = {}) {
  if (!radarId) return [];
  const res = await radarGet(`/properties/${radarId}/persons`, { purchase });
  return resultRows(res);
}

/**
 * Full holdings for whoever owns `radarId`: the subject plus every other
 * property tied to the same PersonKey. Costs one export for the persons call;
 * OtherProperties comes back inside it, so the rollup itself is not per-property.
 */
export async function ownerPortfolio(radarId, { purchase = true } = {}) {
  const people = await propertyPersons(radarId, { purchase });
  const owner =
    people.find((p) => /owner/i.test(p.OwnershipRole || "")) || people[0] || null;
  if (!owner) return { owner: null, others: [], totalParcels: 0 };

  const others = (owner.OtherProperties || []).map((o) => ({
    radarId: o.RadarID,
    address: o.Address,
  }));

  return {
    owner: {
      personKey: owner.PersonKey || null,
      firstName: owner.FirstName || null,
      lastName: owner.LastName || null,
      name: [owner.FirstName, owner.LastName].filter(Boolean).join(" ") || null,
      age: owner.Age || null,
      role: owner.OwnershipRole || null,
      occupation: owner.Occupation || null,
      mailAddress: Array.isArray(owner.MailAddress)
        ? owner.MailAddress[0]?.Address || null
        : owner.MailAddress || null,
      hasPhoneOnFile: Array.isArray(owner.Phone) && owner.Phone.length > 0,
      hasEmailOnFile: Array.isArray(owner.Email) && owner.Email.length > 0,
    },
    others,
    totalParcels: others.length + 1,
  };
}

/**
 * Resolve one property by address and return its RadarID plus owner fields.
 * Two-phase: free count first, spend only on an unambiguous single match.
 */
export async function resolveProperty({ address, city, state = "TN", zip, apn }) {
  const criteria = apn ? byApn(apn, state) : byAddress({ address, city, state, zip });
  const counted = await searchProperties(criteria, { purchase: 0 });
  const count = resultCount(counted);
  if (count !== 1) {
    return { matched: false, count, property: null, ambiguous: count > 1 };
  }
  const bought = await searchProperties(criteria, { purchase: 1, limit: 1, fields: RADAR_FIELDS });
  return { matched: true, count, property: resultRows(bought)[0] || null };
}

// Passing Fields REPLACES the default response set, so RadarID and the
// physical/financial attributes must be listed explicitly or they vanish.
// Validated against the live API — an unknown name returns a 400 naming it.
export const RADAR_FIELDS = [
  "RadarID", "Address", "City", "ZipFive", "County", "APN", "Owner",
  "LotSizeAcres", "AdvancedPropertyType", "AssessedValue", "YearBuilt", "SqFt",
  "isFreeAndClear", "isSiteVacant", "TotalLoanBalance", "DistressScore",
  "inForeclosure", "inTaxDelinquency", "isListedForSale", "Latitude", "Longitude",
].join(",");

/** Trim a raw PropertyRadar property to the fields the report cares about. */
export function summarizeProperty(p = {}) {
  const pick = (...keys) => {
    for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== "") return p[k];
    return null;
  };
  return {
    radarId: pick("RadarID", "radarId"),
    apn: pick("APN", "apn"),
    address: pick("Address", "SiteAddress", "address"),
    city: pick("City", "SiteCity"),
    county: pick("County", "SiteCounty"),
    zip: pick("ZipFive", "SiteZip"),
    acres: pick("Acres", "LotAcres", "acres"),
    useDescription: pick("AdvancedPropertyType", "PropertyType", "UseDescription"),
    owner: pick("Owner", "OwnerName", "PrimaryName"),
    ownerOccupied: pick("OwnerOccupied", "isOwnerOccupied"),
    mailAddress: pick("MailAddress", "OwnerMailAddress"),
    assessedValue: pick("AssessedValue", "TotalAssessedValue"),
    marketValue: pick("AVM", "EstimatedValue", "MarketValue"),
    lastSalePrice: pick("LastTransferValue", "SalePrice", "LastSalePrice"),
    lastSaleDate: pick("LastTransferRecDate", "SaleDate", "LastSaleDate"),
    yearBuilt: pick("YearBuilt"),
    squareFeet: pick("SquareFeet", "BuildingSqft"),
    zoning: pick("Zoning"),
  };
}
