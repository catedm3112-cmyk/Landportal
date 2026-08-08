import { cleanIntakeInput, runLeadIntake } from "../lib/intake.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ success: false, message: "Method not allowed" });
  }

  try {
    const input = cleanIntakeInput(req.body || {});
    const result = await runLeadIntake(input);
    const { ok, statusCode, ...rest } = result;
    return res.status(statusCode).json({ success: ok, ...rest });
  } catch (err) {
    return res.status(500).json({
      success: false,
      message: err?.message || "Unexpected lead intake error.",
    });
  }
}
