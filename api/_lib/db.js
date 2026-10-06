// Tiny Redis client for Upstash's REST API (no dependencies).
// Vercel's Upstash integration sets KV_REST_API_URL / KV_REST_API_TOKEN
// (older setups use UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).
// For local testing only, ALLOW_MEMORY_DB=1 uses an in-memory store.

const URL_ = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useMemory = !URL_ || !TOKEN;

if (useMemory && process.env.ALLOW_MEMORY_DB !== "1") {
  // Fail loudly rather than silently losing usage tracking.
  console.error("Database is not configured: add the Upstash Redis integration in Vercel.");
}

export function dbConfigured() {
  return !useMemory || process.env.ALLOW_MEMORY_DB === "1";
}

// ---------- in-memory fallback (local testing only) ----------
const mem = new Map();
const expiries = new Map();
function alive(k) {
  const e = expiries.get(k);
  if (e && Date.now() > e) { mem.delete(k); expiries.delete(k); }
  return mem.has(k);
}
function memCmd(args) {
  const [c, ...a] = args;
  const C = String(c).toUpperCase();
  const k = a[0];
  switch (C) {
    case "GET": return alive(k) ? mem.get(k) : null;
    case "SET": {
      const nx = a.includes("NX");
      if (nx && alive(k)) return null;
      mem.set(k, String(a[1]));
      const exI = a.indexOf("EX");
      if (exI >= 0) expiries.set(k, Date.now() + Number(a[exI + 1]) * 1000);
      return "OK";
    }
    case "DEL": { let n = 0; for (const x of a) if (mem.delete(x)) n++; return n; }
    case "EXISTS": return alive(k) ? 1 : 0;
    case "EXPIRE": if (alive(k)) { expiries.set(k, Date.now() + Number(a[1]) * 1000); return 1; } return 0;
    case "INCR": { const v = (alive(k) ? Number(mem.get(k)) : 0) + 1; mem.set(k, String(v)); return v; }
    case "INCRBYFLOAT": { const v = (alive(k) ? Number(mem.get(k)) : 0) + Number(a[1]); mem.set(k, String(v)); return String(v); }
    case "HSET": {
      const h = alive(k) ? mem.get(k) : {};
      for (let i = 1; i < a.length; i += 2) h[a[i]] = String(a[i + 1]);
      mem.set(k, h); return 1;
    }
    case "HGETALL": {
      if (!alive(k)) return [];
      const h = mem.get(k); return Object.entries(h).flat();
    }
    case "HINCRBYFLOAT": {
      const h = alive(k) ? mem.get(k) : {};
      const v = Number(h[a[1]] || 0) + Number(a[2]); h[a[1]] = String(v); mem.set(k, h); return String(v);
    }
    case "HINCRBY": {
      const h = alive(k) ? mem.get(k) : {};
      const v = Number(h[a[1]] || 0) + Number(a[2]); h[a[1]] = String(v); mem.set(k, h); return v;
    }
    case "SADD": { const s = alive(k) ? mem.get(k) : new Set(); a.slice(1).forEach(x => s.add(x)); mem.set(k, s); return 1; }
    case "SREM": { if (!alive(k)) return 0; const s = mem.get(k); a.slice(1).forEach(x => s.delete(x)); return 1; }
    case "SMEMBERS": return alive(k) ? [...mem.get(k)] : [];
    case "RENAME": { if (!alive(k)) throw new Error("no such key"); mem.set(a[1], mem.get(k)); mem.delete(k); return "OK"; }
    default: throw new Error("memory db: unsupported command " + C);
  }
}

// ---------- public API ----------
export async function cmd(...args) {
  if (useMemory) {
    if (process.env.ALLOW_MEMORY_DB !== "1") throw new Error("Database is not configured.");
    return memCmd(args);
  }
  const r = await fetch(URL_, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(args.map(String)),
  });
  const j = await r.json();
  if (j.error) throw new Error("Database error: " + j.error);
  return j.result;
}

export async function pipeline(cmds) {
  if (useMemory) return cmds.map(c => memCmd(c));
  const r = await fetch(URL_ + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds.map(c => c.map(String))),
  });
  const j = await r.json();
  if (!Array.isArray(j)) throw new Error("Database error: " + JSON.stringify(j));
  return j.map(x => { if (x.error) throw new Error("Database error: " + x.error); return x.result; });
}

export async function hgetall(key) {
  const flat = await cmd("HGETALL", key);
  if (!flat || (Array.isArray(flat) && flat.length === 0)) return null;
  if (!Array.isArray(flat)) return flat;
  const o = {};
  for (let i = 0; i < flat.length; i += 2) o[flat[i]] = flat[i + 1];
  return o;
}

export async function hset(key, obj) {
  const args = ["HSET", key];
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) args.push(k, String(v));
  if (args.length > 2) await cmd(...args);
}
