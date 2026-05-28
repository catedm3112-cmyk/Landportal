export default async function handler(req, res) {
  const signature = req.headers["x-webhook-signature"];
  const body = req.body || null;

  console.log("LandPortal callback received", {
    signaturePresent: Boolean(signature),
    body,
  });

  return res.status(200).json({
    success: true,
    message: "LandPortal callback received.",
  });
}
