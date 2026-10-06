import { checkAccess } from "./_lib/access.js";
import { WARN_AT } from "./_lib/config.js";

// Lets the chat page check a link before the client starts typing.
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  try {
    const a = await checkAccess((req.body || {}).token);
    if (!a.ok) return res.status(a.status).json({ ok: false, error: a.message, fraction: a.fraction });
    const firstName = String(a.client.name || "").trim().split(/\s+/)[0] || "";
    return res.status(200).json({ ok: true, firstName, fraction: a.fraction, warn: a.fraction >= WARN_AT, firstSession: Number(a.client.sessions || 0) === 0 });
  } catch (e) {
    console.error("status error:", e);
    return res.status(500).json({ ok: false, error: "The coach couldn't be reached just now. Please try again in a moment." });
  }
}
