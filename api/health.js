export default function handler(req, res) {
  return res.status(200).json({
    ok: true,
    service: "truterra-landportal-ghl-integration",
    landPortalApi: "v2",
    env: {
      LAND_PORTAL_API_V2_KEY: Boolean(process.env.LAND_PORTAL_API_V2_KEY),
      GHL_API_KEY: Boolean(process.env.GHL_API_KEY),
      ANTHROPIC_API_KEY: Boolean(process.env.ANTHROPIC_API_KEY),
    },
  });
}
