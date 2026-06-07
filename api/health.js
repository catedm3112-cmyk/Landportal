export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    service: "truterra-landportal-ghl-integration",
    env: {
      LAND_PORTAL_JWT: Boolean(process.env.LAND_PORTAL_JWT),
      GHL_API_KEY: Boolean(process.env.GHL_API_KEY),
      ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  });
}
