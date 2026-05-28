const LAND_PORTAL_BASE_URL = "https://landportal.com/wp-json/lp-rest-api/v1";

function getToken() {
  const token = process.env.LAND_PORTAL_JWT;
  if (!token) throw new Error("Missing LAND_PORTAL_JWT");
  return token;
}

async function landPortalGet(path) {
  const res = await fetch(`${LAND_PORTAL_BASE_URL}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: "application/json",
    },
    cache: "no-store",
  });

  const data = await res.json().catch(() => null);

  if (!res.ok || data?.success === false) {
    throw new Error(data?.message || `LandPortal request failed: ${res.status}`);
  }

  return data;
}

export function normalizeProperty(property, fallback) {
  return {
    propertyId: property?.propertyid ?? fallback?.propertyid ?? null,
    fips: property?.fips ?? fallback?.fips ?? null,
    apn: property?.apn ?? fallback?.apn ?? null,

    situsAddress: property?.situsfullstreetaddress ?? fallback?.address ?? null,
    situsCity: property?.situscity ?? fallback?.city ?? null,
    situsState: property?.situsstate ?? fallback?.state ?? null,
    situsZip: property?.situszip5 ?? fallback?.zip ?? null,
    situsCounty: property?.situscounty ?? fallback?.county ?? null,

    ownerName: property?.ownername1full ?? fallback?.owner ?? null,
    ownerFirstName: property?.owner1firstname ?? null,
    ownerLastName: property?.owner1lastname ?? null,

    mailingAddress: property?.mailingfullstreetaddress ?? null,
    mailingCity: property?.mailingcity ?? null,
    mailingState: property?.mailingstate ?? null,
    mailingZip: property?.mailingzip5 ?? null,

    legalDescription: property?.legaldescription ?? null,
    lotSizeAcres: property?.lotsizeacres ?? null,
    landUseCode: property?.landusecode ?? null,
    zoning: property?.zoning ?? property?.zoningcode ?? null,

    raw: property,
  };
}

export async function getPropertyByIdAndFips(propertyid, fips) {
  const data = await landPortalGet(
    `/property-data?propertyid=${encodeURIComponent(String(propertyid))}&fips=${encodeURIComponent(fips)}`
  );

  return {
    property: normalizeProperty(data?.data?.property),
    meta: data?.meta ?? null,
  };
}

export async function searchAndFetchProperty(params) {
  const { propertyid, fips, apn, parcel, owner, state = "TN" } = params;

  if (propertyid && fips) {
    const direct = await getPropertyByIdAndFips(propertyid, fips);
    return {
      success: true,
      matchType: "direct_propertyid_fips",
      searchMatch: null,
      ...direct,
    };
  }

  const query = apn || parcel || owner;
  if (!query) {
    throw new Error("Missing parcel/APN/owner search input.");
  }

  const searchType = owner ? "owner" : "parcelnumb";

  const searchPath =
    `/search?type=${encodeURIComponent(searchType)}` +
    `&query=${encodeURIComponent(query)}` +
    (fips
      ? `&fips=${encodeURIComponent(fips)}`
      : state
      ? `&state=${encodeURIComponent(state)}`
      : "");

  const searchData = await landPortalGet(searchPath);
  const features = searchData?.data?.features ?? [];

  if (!features.length) {
    return {
      success: false,
      message: "No matching parcel found.",
      matchType: searchType,
      searchMatch: null,
      property: null,
      meta: searchData?.meta ?? null,
    };
  }

  const match = features[0]?.properties;

  if (!match?.propertyid || !match?.fips) {
    throw new Error("LandPortal match missing propertyid or fips.");
  }

  const propertyData = await landPortalGet(
    `/property-data?propertyid=${encodeURIComponent(String(match.propertyid))}&fips=${encodeURIComponent(match.fips)}`
  );

  return {
    success: true,
    matchType: searchType,
    searchMatch: match,
    property: normalizeProperty(propertyData?.data?.property, match),
    meta: {
      search: searchData?.meta ?? null,
      property: propertyData?.meta ?? null,
    },
  };
}
