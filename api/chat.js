import fs from "fs";
import path from "path";
import { cmd, pipeline } from "./_lib/db.js";
import { checkAccess } from "./_lib/access.js";
import { MODEL, MAX_OUTPUT_TOKENS, REQUESTS_PER_MINUTE, WARN_AT, costOf, today, thisMonth } from "./_lib/config.js";

// ---------- system prompt: materials + instructions, loaded once per instance ----------
let SYSTEM = null;
function systemPrompt() {
  if (!SYSTEM) {
    const dir = path.join(process.cwd(), "prompt");
    const materials = fs.readFileSync(path.join(dir, "materials.txt"), "utf8");
    const instructions = fs.readFileSync(path.join(dir, "instructions.md"), "utf8");
    SYSTEM = materials + "\n<instructions>\n" + instructions.trim() + "\n</instructions>\n";
  }
  return SYSTEM;
}

const MAX_MESSAGES = 240;
const MAX_CHARS = 20000;
const MAX_REPORT_B64 = 4_000_000; // ~3 MB file

function bad(res, status, message) {
  return res.status(status).json({ error: message });
}

function validMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) return false;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const want = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== want || typeof m.content !== "string") return false;
    if (m.content.length === 0 || m.content.length > MAX_CHARS) return false;
  }
  return messages[messages.length - 1].role === "user";
}

function longDate() {
  return new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Los_Angeles" });
}

function appNote({ first, summary, hasReport }) {
  let note = first
    ? "This is the client's FIRST session with the Middle Path Coach."
    : "This is not the client's first session.";
  note += summary ? " The client shared this summary from an earlier session:\n\"\"\"\n" + summary + "\n\"\"\"" : " No earlier summary shared.";
  if (hasReport) note += " The client has attached their MP Mirror report.";
  note += ` Today's date is ${longDate()}.`;
  return `[App note: ${note}]`;
}

const CONFIRM_NUDGE = "[App note: Your last reply opened with a confirm. Unless this message carries a feeling, meaning, value, or shift you haven't reflected yet, skip the confirm this time: a few words of acknowledgment at most, then your question.]";

function openedWithConfirm(text) {
  const paras = String(text || "").trim().split(/\n\s*\n/).filter(p => p.trim());
  return paras.length >= 2 && !paras[0].trim().endsWith("?");
}

function buildMessages(messages, note, report) {
  const out = messages.map(m => ({ role: m.role, content: [{ type: "text", text: m.content }] }));
  const firstBlocks = [{ type: "text", text: note }];
  if (report) {
    const doc = report.mediaType === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: report.data }, title: report.name || "MP Mirror report" }
      : { type: "document", source: { type: "text", media_type: "text/plain", data: report.data }, title: report.name || "MP Mirror report" };
    doc.cache_control = { type: "ephemeral" };
    firstBlocks.push(doc);
  }
  out[0].content = [...firstBlocks, ...out[0].content];
  // Prompt rules alone didn't stop the coach confirming at the top of every turn, so nudge per turn:
  // if the coach's previous reply opened with a confirm, ask it to skip one this time unless there's new feeling or meaning.
  const prev = messages.length >= 3 ? messages[messages.length - 2].content : "";
  if (openedWithConfirm(prev)) {
    out[out.length - 1].content.push({ type: "text", text: CONFIRM_NUDGE });
  }
  // cache the conversation so far, so each turn only pays full price for what's new
  const last = out[out.length - 1].content;
  last[last.length - 1].cache_control = { type: "ephemeral" };
  return out;
}

async function callClaude(messages) {
  const body = {
    model: MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
    messages,
  };
  let lastErr = "";
  const started = Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0 && Date.now() - started > 20_000) break; // stay inside Vercel's time limit
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(50_000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.ok) return j;
    lastErr = `${r.status}: ${j?.error?.message || JSON.stringify(j).slice(0, 300)}`;
    if (![429, 500, 502, 503, 529].includes(r.status)) break;
    await new Promise(s => setTimeout(s, 2000 * (attempt + 1)));
  }
  throw new Error(lastErr);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return bad(res, 405, "Method not allowed");
  if (!process.env.ANTHROPIC_API_KEY) return bad(res, 500, "The coach isn't configured yet (missing ANTHROPIC_API_KEY).");

  const { token, sessionId, messages, summary, report } = req.body || {};
  try {
    const access = await checkAccess(token);
    if (!access.ok) return res.status(access.status).json({ error: access.message, fraction: access.fraction });

    if (!validMessages(messages)) return bad(res, 400, "That message couldn't be sent. Try starting a new session.");
    if (typeof sessionId !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(sessionId)) return bad(res, 400, "Missing session id.");
    if (summary != null && (typeof summary !== "string" || summary.length > 8000)) return bad(res, 400, "The summary is too long (8,000 characters max).");
    if (report != null) {
      if (typeof report !== "object" || typeof report.data !== "string" || report.data.length > MAX_REPORT_B64) return bad(res, 400, "The report is too large (about 3 MB max).");
      if (!["application/pdf", "text/plain"].includes(report.mediaType)) return bad(res, 400, "The report must be a PDF or a text file.");
    }

    // rate limit
    const minuteKey = `rl:${token}:${Math.floor(Date.now() / 60000)}`;
    const [count] = await pipeline([["INCR", minuteKey], ["EXPIRE", minuteKey, 120]]);
    if (Number(count) > REQUESTS_PER_MINUTE) return bad(res, 429, "That's a lot of messages in a minute. Please wait a moment and try again.");

    // first-session flag, fixed for the life of this session
    const sessKey = `sess:${token}:${sessionId}`;
    let first = await cmd("GET", sessKey);
    if (first === null) {
      const isFirst = Number(access.client.sessions || 0) === 0 ? "1" : "0";
      const set = await cmd("SET", sessKey, isFirst, "NX", "EX", 60 * 60 * 24 * 30);
      if (set === "OK") await cmd("HINCRBY", `client:${token}`, "sessions", 1);
      first = await cmd("GET", sessKey);
    }

    const note = appNote({ first: first === "1", summary: summary && summary.trim(), hasReport: !!report });
    const result = await callClaude(buildMessages(messages, note, report));
    const reply = (result.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const cost = costOf(result.usage || {});

    const dayKey = `daily:${token}:${today()}`;
    const ops = [
      ["HINCRBYFLOAT", `client:${token}`, "spent", cost.toFixed(6)],
      ["HSET", `client:${token}`, "lastUsed", new Date().toISOString()],
      ["INCRBYFLOAT", dayKey, cost.toFixed(6)],
      ["EXPIRE", dayKey, 60 * 60 * 48],
      ["INCRBYFLOAT", `global:${thisMonth()}`, cost.toFixed(6)],
    ];
    if (access.team) ops.push(["HINCRBYFLOAT", `team:${access.client.teamId}`, "spent", cost.toFixed(6)]);
    await pipeline(ops);

    const after = await checkAccess(token);
    const fraction = after.fraction ?? access.fraction;
    return res.status(200).json({
      reply: reply || "(The coach didn't return a reply. Please try sending that again.)",
      fraction,
      warn: fraction >= WARN_AT,
    });
  } catch (e) {
    console.error("chat error:", e);
    return bad(res, 502, "The coach couldn't respond just now (" + String(e.message || e).slice(0, 200) + "). Please try again in a moment.");
  }
}
