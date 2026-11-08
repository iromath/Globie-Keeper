# PayPal AI Hackathon — submission state & checklist

Deadline: **Thu Nov 12, 2026 12:00pm PT** = **Fri Nov 13, 2026 03:00 ICT**.
Judging: Dec 1–15, 2026. Winners: ~Dec 21, 2026.
Landing page: https://paypalaihackathon.devpost.com/ · Rules: https://paypalaihackathon.devpost.com/rules

## Current state (snapshot 2026-11-07)

- Live web: https://keeper.globie.ai (HTTP 200)
- Live API: https://keeperapi.globie.ai/api — `/health` returns `status: ok`, `env: production`, `database.ok: true`, `worker.running: true`
- Git: `master` = `1c3e23b`, working tree clean, **10 commits ahead of `origin/master`**
- GitHub `iromath/Globie-Keeper`: **private** (`404` on the public URL) and missing those 10 commits
- Licence: MIT `LICENSE` at repo root, README `## License` section
- AI in product: DeepSeek `deepseek-flash` vision receipt → strict JSON (`server/src/lib/receipt.ts`); Globie "agent" is a deterministic 7-tool dispatcher (`server/src/lib/agent.ts`, `server/src/routes/agent.ts`) with HMAC confirmation tokens for the 3 money/message-moving tools; free-form conversation is a read-only layer over the bill context (`POST /api/agent/chat`, `server/src/lib/assistant.ts`) that cannot write
- PayPal: Orders v2 sandbox, `purchase_units[].payee` routing (`merchant_id` first), webhook signature verification, Log in with PayPal
- Demo account: `globie.member@personal.example.com` ("Member Globie"), group **Volunteer Dinner** (3 members)
- Secrets hygiene: only `.env.example` tracked; live keys absent from the tree
- Not done: push, un-private, README judge section, screenshots, demo video, Devpost draft

## P0 — blockers

- [ ] `git push origin master` (10 commits unpublished)
- [ ] Make `iromath/Globie-Keeper` **public**
- [ ] Repo About: description, website `https://keeper.globie.ai`, topics (`paypal`, `expo`, `fastify`, `bill-splitting`, `ai`), MIT chip visible
- [ ] Re-check the public page for leaked secrets after flipping visibility
- [ ] Keep PayPal sandbox app + DeepSeek key valid through **Dec 15** (judging end)

## P1 — README as judge entry point

- [ ] "Judge quick start": hosted demo URL, demo login, group "Volunteer Dinner", sandbox buyer credentials
- [ ] "What was built during the submission period (Oct 1 – Nov 12, 2026)" — first commit is 2026-11-06, so all work falls inside the window
- [ ] Note the no-Postgres fallback: `npm run preview` (in-memory API)
- [ ] 3–4 screenshots: bill board, receipt split, PayPal checkout, Globie award
- [ ] Reframe the caveats block as roadmap, not gaps

## P2 — Devpost form

- [ ] Name/tagline: Globie Keeper — split the bill, no custody
- [ ] Sections: Inspiration / What it does / How we built it / Challenges / Accomplishments / What we learned / What's next
- [ ] Built with tags (PayPal, DeepSeek, Expo, React Native, Fastify, PostgreSQL, Docker)
- [ ] **Tools** (mandatory): DeepSeek `deepseek-flash` vision and how it is used; PayPal Orders v2 and how it is used
- [ ] Video URL, repo URL, live demo URL
- [ ] Thumbnail 3:2 (1440×900)
- [ ] English only

## P3 — demo video (< 3 min, public YouTube)

- [ ] 0:00–0:20 problem + no-custody claim
- [ ] 0:20–0:50 PayPal sign-in → group
- [ ] 0:50–1:30 receipt scan → AI extraction → largest-remainder split
- [ ] 1:30–2:10 member confirms → PayPal order → pays fronter directly
- [ ] 2:10–2:35 webhook settles → Globie award (fronter 15 vs member 7)
- [ ] 2:35–2:55 agent reminder with HMAC confirmation
- [ ] Public upload, 1080p, captions, no third-party music/logos

## P4 — judging lifts (criteria are equally weighted)

- [ ] Technological Implementation: pitch the two layers — the HMAC-confirmed executor + `agent_events` audit trail, and the read-only LLM conversational layer (`POST /api/agent/chat`) grounded in the bill context; intent parsing stays client-side and deterministic
- [ ] Best Use of Agentic Commerce ($5,000): frame the 3 confirmation-gated tools + 10-min TTL + payee-routed capture as agent-initiated commerce with human-in-the-loop authorization
- [ ] Design: capture the shared header/footer at 1280 and 390×844
- [ ] Presentation: video must show the end-to-end flow running (mockups are explicitly disqualified)

## P5 — optional sponsor prizes

- [ ] Postman ($1,000 ×3): `postman/` collection already covers the agent challenge flow — add a run button + 3-bullet write-up
- [ ] AG Grid / Bryntum / APIMatic / Channel3 / Render: skip unless a visible integration is added

## Recommended order

1. Push + un-private + About
2. README judge section + screenshots
3. Record video
4. Fill the Devpost draft
5. Optional: LLM intent router
