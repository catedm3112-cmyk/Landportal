function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function scoreLead(property) {
  if (!property) {
    return {
      status: "missing_data",
      score: 0,
      tags: ["Land Lead - Parcel Not Matched"],
      reasons: ["No parcel match found."],
    };
  }

  const tags = ["Land Lead - Parcel Matched"];
  const reasons = [];
  let score = 50;

  const acres = toNumber(property.lotSizeAcres);

  if (property.situsCounty) {
    reasons.push(`County identified: ${property.situsCounty}.`);
  } else {
    score -= 10;
    reasons.push("County missing.");
  }

  if (acres !== null) {
    reasons.push(`Acreage identified: ${acres}.`);

    if (acres >= 5) {
      score += 25;
      tags.push("Land Lead - 5+ Acres");
    } else if (acres >= 1) {
      score += 10;
      tags.push("Land Lead - 1+ Acre");
    } else {
      score -= 15;
      tags.push("Land Lead - Small Parcel");
    }
  } else {
    score -= 15;
    reasons.push("Acreage missing.");
  }

  if (property.ownerName) {
    score += 10;
    reasons.push("Owner identified.");
  } else {
    score -= 10;
    reasons.push("Owner missing.");
  }

  if (property.apn) {
    score += 10;
    reasons.push("APN identified.");
  } else {
    score -= 10;
    reasons.push("APN missing.");
  }

  score = Math.max(0, Math.min(100, score));

  let status = "needs_review";

  if (score >= 75) {
    status = "qualified";
    tags.push("Land Lead - Qualified");
  } else if (score >= 45) {
    status = "needs_review";
    tags.push("Land Lead - Needs Review");
  } else {
    status = "not_qualified";
    tags.push("Land Lead - Low Priority");
  }

  return {
    status,
    score,
    tags,
    reasons,
  };
}
