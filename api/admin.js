import crypto from "crypto";
import { cmd, pipeline, hgetall, hset } from "./_lib/db.js";
import { isValidToken } from "./_lib/access.js";
import { DEFAULT_INDIVIDUAL_CAP, DEFAULT_TEAM_CAP, DAILY_CAP, GLOBAL_MONTHLY_CAP, MODEL, today, thisMonth } from "./_lib/config.js";

// Admin actions for the coach. Every request needs the ADMIN_PASSWORD (sent as the x-admin-password header).

function newToken() { return crypto.randomBytes(18).toString("base64url"); }
function newTeamId() { return "t_" + crypto.randomBytes(6).toString("hex"); }
function oneYearFromToday() {
  const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10);
}
function validDate(s) { return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function money(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function cleanName(s) { return String(s || "").trim().slice(0, 120); }

function passwordOk(given) {
  const real = process.env.ADMIN_PASSWORD || "";
  if (!real || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(real).digest();
  return crypto.timingSafeEqual(a, b);
}

function siteUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function listAll(req) {
  const [tokens, teamIds, global] = await pipeline([["SMEMBERS", "clients"], ["SMEMBERS", "teams"], ["GET", `global:${thisMonth()}`]]);
  const clients = [];
  for (const t of tokens || []) {
    const c = await hgetall(`client:${t}`);
    if (c) clients.push({ token: t, link: `${siteUrl(req)}/?k=${t}`, ...c });
  }
  const teams = [];
  for (const id of teamIds || []) {
    const tm = await hgetall(`team:${id}`);
    if (tm) teams.push({ id, ...tm });
  }
  clients.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  teams.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  return {
    clients, teams,
    settings: { model: MODEL, dailyCap: DAILY_CAP, globalMonthlyCap: GLOBAL_MONTHLY_CAP, globalSpentThisMonth: Number(global || 0),
      defaultIndividualCap: DEFAULT_INDIVIDUAL_CAP, defaultTeamCap: DEFAULT_TEAM_CAP, oneYearFromToday: oneYearFromToday(), today: today() },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const failKey = `adminfail:${ip}`;
  try {
    const fails = Number((await cmd("GET", failKey)) || 0);
    if (fails >= 10) return res.status(429).json({ error: "Too many wrong passwords. Try again in an hour." });
    if (!passwordOk(req.headers["x-admin-password"])) {
      await pipeline([["INCR", failKey], ["EXPIRE", failKey, 3600]]);
      return res.status(401).json({ error: "Wrong password." });
    }

    const b = req.body || {};
    switch (b.action) {
      case "list":
        return res.json(await listAll(req));

      case "createTeam": {
        const name = cleanName(b.name);
        if (!name) return res.status(400).json({ error: "Team name is required." });
        const id = newTeamId();
        await hset(`team:${id}`, {
          name, cap: money(b.cap, DEFAULT_TEAM_CAP), spent: 0, active: "1",
          periodEnd: validDate(b.periodEnd) ? b.periodEnd : oneYearFromToday(), created: new Date().toISOString(),
        });
        await cmd("SADD", "teams", id);
        return res.json({ ok: true, id });
      }

      case "updateTeam": {
        const tm = await hgetall(`team:${b.id}`);
        if (!tm) return res.status(404).json({ error: "No such team." });
        const f = b.fields || {};
        await hset(`team:${b.id}`, {
          name: f.name !== undefined ? cleanName(f.name) || tm.name : undefined,
          cap: f.cap !== undefined ? money(f.cap, Number(tm.cap)) : undefined,
          periodEnd: validDate(f.periodEnd) ? f.periodEnd : undefined,
          active: f.active === undefined ? undefined : (f.active ? "1" : "0"),
          spent: f.resetSpent ? 0 : undefined,
        });
        return res.json({ ok: true });
      }

      case "createClient": {
        const name = cleanName(b.name);
        if (!name) return res.status(400).json({ error: "Client name is required." });
        let teamId = "";
        if (b.teamId) {
          if (!(await hgetall(`team:${b.teamId}`))) return res.status(400).json({ error: "That team doesn't exist." });
          teamId = b.teamId;
        }
        const token = newToken();
        await hset(`client:${token}`, {
          name, email: String(b.email || "").trim().slice(0, 200), teamId,
          // team members draw from the team pool; a personal cap of 0 means "no personal cap"
          cap: teamId ? money(b.cap, 0) : money(b.cap, DEFAULT_INDIVIDUAL_CAP),
          spent: 0, sessions: 0, active: "1",
          periodEnd: teamId ? "" : (validDate(b.periodEnd) ? b.periodEnd : oneYearFromToday()),
          created: new Date().toISOString(),
        });
        await cmd("SADD", "clients", token);
        return res.json({ ok: true, token, link: `${siteUrl(req)}/?k=${token}` });
      }

      case "updateClient": {
        if (!isValidToken(b.token)) return res.status(400).json({ error: "Bad token." });
        const c = await hgetall(`client:${b.token}`);
        if (!c) return res.status(404).json({ error: "No such client." });
        const f = b.fields || {};
        if (f.teamId !== undefined && f.teamId !== "" && !(await hgetall(`team:${f.teamId}`))) return res.status(400).json({ error: "That team doesn't exist." });
        await hset(`client:${b.token}`, {
          name: f.name !== undefined ? cleanName(f.name) || c.name : undefined,
          email: f.email !== undefined ? String(f.email).trim().slice(0, 200) : undefined,
          cap: f.cap !== undefined ? money(f.cap, Number(c.cap)) : undefined,
          periodEnd: validDate(f.periodEnd) ? f.periodEnd : undefined,
          teamId: f.teamId !== undefined ? f.teamId : undefined,
          active: f.active === undefined ? undefined : (f.active ? "1" : "0"),
          spent: f.resetSpent ? 0 : undefined,
        });
        return res.json({ ok: true });
      }

      case "newLink": {
        // Replaces a client's link (for example, if it was forwarded). The old link stops working.
        if (!isValidToken(b.token)) return res.status(400).json({ error: "Bad token." });
        if (!(await hgetall(`client:${b.token}`))) return res.status(404).json({ error: "No such client." });
        const fresh = newToken();
        await cmd("RENAME", `client:${b.token}`, `client:${fresh}`);
        await pipeline([["SREM", "clients", b.token], ["SADD", "clients", fresh]]);
        return res.json({ ok: true, token: fresh, link: `${siteUrl(req)}/?k=${fresh}` });
      }

      case "deleteClient": {
        if (!isValidToken(b.token)) return res.status(400).json({ error: "Bad token." });
        await pipeline([["DEL", `client:${b.token}`], ["SREM", "clients", b.token]]);
        return res.json({ ok: true });
      }

      default:
        return res.status(400).json({ error: "Unknown action." });
    }
  } catch (e) {
    console.error("admin error:", e);
    return res.status(500).json({ error: String(e.message || e) });
  }
}
