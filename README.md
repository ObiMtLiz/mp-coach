**Middle Path Coach**

A private coaching companion for Middle Path clients. Each client gets a personal link. Usage is counted against an annual allowance for each client (or a shared pool for each team). The client is warned at 80% and stopped at 100%.

---

**How it works**

- `public/index.html` is the client's chat page. The conversation lives only in the client's browser. The app stores no transcripts.
- `public/admin.html` (at `/admin`) is your page for adding clients and teams, copying links, and watching usage.
- `api/chat.js` holds the API key, checks the client's link and allowance, sends the conversation to Claude with the coaching prompt, and records the cost.
- `prompt/instructions.md` holds the coaching instructions and `prompt/materials.txt` holds the Middle Path materials. Edit them in GitHub to change the coach; Vercel redeploys automatically.
- Usage data (clients, teams, spend) is kept in Upstash Redis, added through Vercel.

---

**Settings (Vercel → Project → Settings → Environment Variables)**

Required:
- `ANTHROPIC_API_KEY`: the production API key from console.anthropic.com
- `ADMIN_PASSWORD`: the password for /admin
- `KV_REST_API_URL` and `KV_REST_API_TOKEN`: added automatically when you connect Upstash Redis

Optional (defaults shown):
- `MODEL` = claude-sonnet-5-5. If you switch to a model the app doesn't know, also set `PRICE_INPUT_PER_MTOK` and `PRICE_OUTPUT_PER_MTOK`.
- `DAILY_CAP_PER_CLIENT` = 5. Dollars per client per day; a safety net if a link is forwarded.
- `GLOBAL_MONTHLY_CAP` = 300. Dollars per month for the whole app.
- `WARN_AT` = 0.8
- `DEFAULT_INDIVIDUAL_CAP` = 150 and `DEFAULT_TEAM_CAP` = 1500. These are only the defaults offered on the admin page.

Changes to environment variables take effect on the next deploy (Deployments → ⋯ → Redeploy).

---

**Renewing a license**

On /admin, choose Edit to set the new end date, then Reset usage.

**If a link is forwarded**

On /admin, choose New link. The old link stops working immediately; send the client the new one.

---

**Local testing**

`ALLOW_MEMORY_DB=1 ADMIN_PASSWORD=test ANTHROPIC_API_KEY=... node scripts/dev-server.js`, then open http://localhost:3000/admin.
