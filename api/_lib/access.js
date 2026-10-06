import { cmd, hgetall } from "./db.js";
import { DAILY_CAP, GLOBAL_MONTHLY_CAP, WARN_AT, today, thisMonth } from "./config.js";

export function isValidToken(t) {
  return typeof t === "string" && /^[A-Za-z0-9_-]{20,64}$/.test(t);
}

function pastEnd(periodEnd) {
  return periodEnd && today() > periodEnd;
}

// Looks up a client and works out whether they may use the coach right now.
// Returns { ok, status, message, client, team, fraction, warn }.
export async function checkAccess(token) {
  if (!isValidToken(token)) return { ok: false, status: 401, message: "This link isn't valid. Please use the personal link your coach sent you." };
  const client = await hgetall(`client:${token}`);
  if (!client) return { ok: false, status: 401, message: "This link isn't valid. Please use the personal link your coach sent you." };
  if (client.active === "0") return { ok: false, status: 403, message: "Access to the coach is paused for this link. Please contact your coach." };

  let team = null;
  if (client.teamId) {
    team = await hgetall(`team:${client.teamId}`);
    if (!team) return { ok: false, status: 403, message: "Your team's access isn't set up. Please contact your coach." };
    if (team.active === "0") return { ok: false, status: 403, message: "Your team's access to the coach is paused. Please contact your coach." };
  }

  const periodEnd = team ? team.periodEnd : client.periodEnd;
  if (pastEnd(periodEnd)) return { ok: false, status: 403, client, team, message: "Your license period has ended. Please contact your coach to renew." };

  // The governing allowance: the team pool for team members, otherwise the client's own cap.
  // A team member can also have a personal cap if one is set.
  const fractions = [];
  if (team) fractions.push(Number(team.spent || 0) / Math.max(Number(team.cap || 0), 0.01));
  if (!team || Number(client.cap || 0) > 0) fractions.push(Number(client.spent || 0) / Math.max(Number(client.cap || 0), 0.01));
  const fraction = Math.max(...fractions);

  if (fraction >= 1) return { ok: false, status: 402, client, team, fraction, message: "You've reached this year's coaching allowance. Please contact your coach to extend it." };

  const daily = Number((await cmd("GET", `daily:${token}:${today()}`)) || 0);
  if (daily >= DAILY_CAP) return { ok: false, status: 429, client, team, fraction, message: "You've reached today's limit for the coach. It resets tomorrow." };

  const global = Number((await cmd("GET", `global:${thisMonth()}`)) || 0);
  if (global >= GLOBAL_MONTHLY_CAP) return { ok: false, status: 503, client, team, fraction, message: "The coach is temporarily unavailable. Please contact your coach." };

  return { ok: true, client, team, fraction, warn: fraction >= WARN_AT };
}
