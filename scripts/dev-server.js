// Local test server that mimics Vercel: /api/<name> runs api/<name>.js, everything else is served from public/.
// Run: ALLOW_MEMORY_DB=1 ADMIN_PASSWORD=test ANTHROPIC_API_KEY=... node scripts/dev-server.js
import http from "http";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";

const root = process.cwd();
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  res.status = c => { res.statusCode = c; return res; };
  res.json = o => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(o)); return res; };
  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
    const file = path.join(root, "api", name + ".js");
    if (!fs.existsSync(file)) return res.status(404).json({ error: "not found" });
    let raw = ""; for await (const ch of req) raw += ch;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    const mod = await import(pathToFileURL(file).href);
    return mod.default(req, res);
  }
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!path.extname(p)) p += ".html";
  const f = path.join(root, "public", path.normalize(p));
  if (!f.startsWith(path.join(root, "public")) || !fs.existsSync(f)) { res.statusCode = 404; return res.end("Not found"); }
  res.setHeader("Content-Type", types[path.extname(f)] || "application/octet-stream");
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3000, () => console.log("dev server on http://localhost:" + (process.env.PORT || 3000)));
