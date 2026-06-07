function getGhlToken() {
  const token = process.env.GHL_API_KEY;
  if (!token) throw new Error("Missing GHL_API_KEY");
  return token;
}

async function ghlRequest(path, init) {
  const res = await fetch(`https://services.leadconnectorhq.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getGhlToken()}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const data = await res.json().catch(() => null);

  if (!res.ok) {
    throw new Error(data?.message || `GHL request failed: ${res.status}`);
  }

  return data;
}

// First version uses contact tags + notes.
// Custom field write-back should be enabled after verifying exact GHL custom field IDs/API payload shape.
export async function updateContactBasic(params) {
  const { contactId, tags } = params;

  return ghlRequest(`/contacts/${contactId}`, {
    method: "PUT",
    body: JSON.stringify({
      tags,
    }),
  });
}

export async function addContactNote(params) {
  const { contactId, body } = params;

  return ghlRequest(`/contacts/${contactId}/notes`, {
    method: "POST",
    body: JSON.stringify({
      body,
    }),
  });
}
