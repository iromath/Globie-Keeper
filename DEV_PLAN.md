# Dev Plan — AI Group Bill & Reimbursement Agent (PayPal AI Hackathon 2026)

**App name:** Globie Keeper — "Globie" alone always refers to the in-app points, never the product
**Branding constraint:** original name and assets; do not use "ขุนทอง" or any KBank asset
**Event:** PayPal AI Hackathon ("Build what's next with PayPal and AI")
**Submission deadline:** Nov 12, 2026, 12:00 PM PT = **Nov 13, 2026, 03:00 Asia/Bangkok**
**Plan target:** submit by **Nov 11, 2026**
**Deploy target:** `https://keeper.globie.ai` (web) + `https://keeperapi.globie.ai` (API), domains on `globie.ai`
**Database:** PostgreSQL 16 + TimescaleDB
**Client:** Expo SDK 58 universal app (iOS + Android + web from one codebase), TypeScript
**API:** Fastify 5 on Node 22 (separate service)
**Team:** 1–4 people

---

## 0. What changed in this revision

| Change | Why it matters |
|---|---|
| Product reframed from "bill splitter" to **agreement-first reimbursement** | The real job is not dividing a bill; it is letting one or two people front cash and getting everyone else to pay their own share without friction |
| Added **one-tap agreement + acceptance** | Creates commitment before the meal ends and gives the app a defensible state machine |
| Added **per-member item confirmation** | Members confirm their own items and prices, which removes the "I didn't order that" objection |
| Added **photo and video receipt capture** | Video handles long receipts and multiple shots; AI extracts and reconciles |
| Added **gamification** (Hero, Globie) | Drives repayment speed and makes the group chat socially engaging |
| Added **multi-channel reminders** (email, WhatsApp, push) | Meets users where they already are instead of requiring another inbox |
| Database moved from Supabase to **self-hosted PostgreSQL + TimescaleDB** | Keeps data on our server and gives a real time-series backbone for ledger events, points, and leaderboard analytics |
| Everything deploys on **our own live server** | No vendor dependency for the demo; matches the required URL |
| Client stack: **Next.js PWA → Expo SDK 58 universal app** | One codebase compiles to iOS, Android, and web — no separate rebuild, and store binaries stay possible after the hackathon |
| API split out into **Fastify 5** on the same host | Expo Router is a client, not a server; PayPal webhooks, ffmpeg, and pg-boss need a long-lived Node process |
| Added **Log in with PayPal** (§2.17) | Identity was the last password-less hole — a typed email proved nothing. A verified email plus payer ID makes each account claimable only by its owner and pre-fills the reimbursement address |

---

## 1. Product definition

### 1.1 One-liner

An AI group treasurer for cash-first moments: create an agreement in one tap, scan the receipt, let everyone confirm their own items, and settle each share through PayPal — with smart reminders and a leaderboard that rewards the people who front the bill and the people who pay back fast.

### 1.2 The scenario

A group of friends eats at a restaurant that only accepts local cash. One or two members pay the restaurant upfront. The group needs a fair, fast, low-awkwardness way to reimburse them.

Current behavior: someone photographs the receipt, posts it in the group chat, everyone guesses what they owe, and the person who fronted the cash spends the next two weeks chasing people.

### 1.3 The problem

Reimbursement fails for four reasons:

1. **No commitment** — nobody formally agreed to pay before the expense happened
2. **No shared truth** — the receipt is an image, and item ownership is disputed
3. **No ownership** — each member cannot see and confirm their own share
4. **No gentle pressure** — reminders feel rude, so they are delayed or skipped

Across borders, add currency mismatch and incompatible payment rails.

Khun Thong (KBank/KBTG) validated the domestic chat-native version in Thailand, but it is THB-only, bank-rail-bound, command-based, and organizer-centric.

### 1.4 What we are deliberately NOT building

- Not a Khun Thong or Splitwise clone
- Not a merchant POS or restaurant payment integration
- Not a reminder bot with no settlement
- Not a static prototype, mockup, or clickable design
- Not a crypto product; Globie is a non-transferable in-app point with no cash value

### 1.5 The wedge

| Khun Thong | Globie Keeper |
|---|---|
| Thailand, THB only | Cross-border groups, multi-currency display and settlement |
| Thai bank transfer + e-slip OCR | PayPal Orders / Invoicing, card or balance funding |
| Organizer creates a bill after the fact | **Agreement before the meal, one-tap acceptance by every member** |
| Organizer assigns amounts | **Each member confirms their own items and prices** |
| Command-based bot | LLM agent that proposes, explains, and handles exceptions |
| Manual proof of payment | Webhook-verified payment state |
| No incentive design | Hero status + Globie points for fronting and fast repayment |

### 1.6 Core user loop

1. **Agree** — organizer starts an agreement: currency, estimated total, who fronts the cash, repayment deadline; every member taps once to accept
2. **Eat** — the fronters pay the restaurant in cash
3. **Capture** — a member uploads a photo or a short video of the receipt
4. **Extract** — AI reads items, quantities, tax, service charge, tip, discount, and total
5. **Confirm** — each member receives "confirm your items" and taps Confirm or Dispute; the agent resolves ambiguity
6. **Settle** — shares are finalized; each member gets a PayPal payment request for their own amount
7. **Reward** — webhooks mark shares paid; each capture lands in the fronter's own PayPal account, the first to reimburse earns Globie points, and fronters earn Hero status

### 1.7 Personas

- **The Fronter** — pays the restaurant, wants reimbursement without chasing
- **The Member** — wants to see exactly what they owe and pay in two taps
- **The Organizer** — creates the agreement and resolves disputes
- **The Group** — wants fairness and a little fun, not a finance app

### 1.8 Scope

**Must ship (MVP)**
- Group + invite link, lightweight session (no forced signup before viewing a bill)
- Agreement creation and one-tap acceptance with consent record
- Photo receipt upload and structured extraction
- Item-level allocation with per-member confirmation
- PayPal Orders v2 create + capture per share, webhook-verified
- Live ledger with per-person status
- Email + in-app reminders
- Agent chat for questions, corrections, and reminders
- Chat-style group interface (Expo, one codebase for iOS, Android, web)
- Self-hosted deployment at the required URL

**Should ship (differentiators)**
- Video receipt capture (ffmpeg frame sampling)
- Expo push notifications on native; in-app + email on web
- WhatsApp reminders via a sandbox/test sender
- Hero and Globie leaderboard
- Direct reimbursement: every capture settles into the fronter's PayPal account
- AG Grid ledger/admin dashboard
- Currency conversion preview

**Stretch only if the MVP is green**
- Multi-receipt bills (split across several photos)
- Recurring shared bills via PayPal Subscriptions
- Telegram channel
- Group voting to resolve disputes
- Eco-partner redemption for Globie

**Explicitly out of scope**
- Real money (sandbox only)
- Card data storage (never)
- Crypto, wallets, or transferable tokens
- Native iOS/Android store submission (binaries are reachable, review is out of scope)
- Merchant POS integration
- LINE Official Account (approval lead time)

---

## 2. Architecture

### 2.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Client | **Expo SDK 58 + expo-router + TypeScript**, NativeWind for the chat UI | One codebase compiles to iOS, Android, and web; no store review for the demo |
| Web build | Expo web `output: "single"` (SPA), served from the domain root | The app owns `keeper.globie.ai` end to end |
| API | **Fastify 5** on Node 22 | Webhooks, uploads, PayPal calls, and ffmpeg scheduling need a long-lived process |
| Database | **PostgreSQL 16 + TimescaleDB** (Docker, self-hosted) | Relational core plus time-series for ledger, points, reminders, analytics |
| Auth | Signed invite tokens + member JWT (`expo-secure-store` on native, storage on web) | Portable across platforms; no forced signup |
| Capture | `expo-image-picker` / `expo-camera` on native, `<input capture>` on web | Photo and video on both targets |
| Push | `expo-notifications` on native; in-app + email on web | Expo push service fans out to APNs/FCM |
| Jobs | pg-boss on the same Postgres | Reminders, retries, video processing; no extra Redis service |
| Media | ffmpeg worker + local persistent volume | Extract frames from receipt videos |
| AI | Vision-capable LLM + tool-calling agent | Receipt extraction, item mapping, explanations, reminder copy |
| Payments | PayPal Orders v2, Invoicing v2, Webhooks, Agent Toolkit/MCP | Real settlement state; orders settle to the fronter as payee |
| Ledger UI | AG Grid on web; `FlashList` on native | AG Grid is a DOM library and stays a web-surface integration |
| Proxy | Easypanel + Cloudflare TLS | One hostname per service: `keeper.` → web, `keeperapi.` → api |
| Deploy | Prebuilt Docker Hub images (`tradex367/globie-keeper-{api,web}`) run on the Easypanel host | Reproducible, self-hosted, no build on the server |
| Tests | Vitest + Playwright (web) + Postman collection | Reproducible judging |

### 2.2 Design principles

1. **Deterministic money, probabilistic language.** The LLM parses receipt text, maps items to people, asks clarifying questions, and drafts reminder copy. It never computes amounts that move money.
2. **Agreement is the source of truth.** Every share traces back to a signed agreement, a bill item, and a member confirmation.
3. **Humans confirm money movements.** The agent proposes; a member confirms their items; the organizer confirms sending requests.
4. **Append-only audit.** Every state change writes an immutable event. TimescaleDB stores those events for analytics and replay.
5. **Sandbox honesty.** No real funds, no custody claims, no implied money-transmission service.

### 2.3 System diagram

```
Expo universal app (iOS / Android / web, chat UI)
  |  agreements, receipt upload, item confirmation, pay, leaderboard
  v
Fastify API (REST under /api)
  |-- PostgreSQL + TimescaleDB (core tables + hypertables)
  |-- pg-boss worker
  |      |-- reminder scheduler / outbox delivery
  |      |-- video frame extraction (ffmpeg)
  |      |-- leaderboard and points aggregation
  |-- Agent orchestrator (LLM + tools)
  |      |-- parse_receipt_media()
  |      |-- propose_allocation()
  |      |-- request_item_confirmation()
  |      |-- create_payment_request()  -> PayPal Orders (payee = fronter)
  v
PayPal REST APIs (sandbox)
  |
  +--> Webhooks -> /api/paypal/webhook -> ledger update -> points award
```

### 2.4 State machines

**Agreement**
```
DRAFT -> PENDING_ACCEPTANCE -> ACTIVE -> RECEIPT_PENDING -> CONFIRMING
      -> SETTLING -> SETTLED -> CLOSED
Any state -> CANCELLED
```

**Member share**
```
PROPOSED -> CONFIRMED -> REQUESTED -> PAID -> SETTLED
         -> DISPUTED -> (re-proposed | resolved)
Any pre-PAID state -> CANCELLED
PAID -> REFUNDED
```

**Bill**
```
UPLOADED -> PARSING -> PARSED -> ALLOCATED -> CONFIRMED -> FINALIZED -> COLLECTING -> SETTLED
```

Rules:
- Sending payment requests is blocked until every allocation is `CONFIRMED` or explicitly resolved by the organizer
- The sum of shares must equal the bill total exactly, in minor units
- Any post-finalization change creates a new bill version and a new share set

### 2.5 Data model — relational core

```
users(id, email, display_name, paypal_payer_id,
      paypal_email, paypal_verified, paypal_linked_at, created_at)

groups(id, name, default_currency, owner_id, invite_token, created_at)

members(id, group_id, user_id, role, paypal_email, status, joined_at)

agreements(id, group_id, currency, estimated_total, deadline,
           terms_snapshot jsonb, status, created_by, created_at)

agreement_acceptances(id, agreement_id, member_id, accepted_at,
                      consent_version, ip_hash)

bills(id, agreement_id, merchant, currency,
      subtotal, tax, service_charge, tip, discount, total,
      status, version, created_at)

bill_media(id, bill_id, kind, storage_key, mime_type, duration_s,
           frames_extracted, status, created_at)

bill_items(id, bill_id, name, qty, unit_price, line_total,
           confidence, source_frame)

allocations(id, bill_item_id, member_id, qty, amount,
            status, created_at)

item_confirmations(id, allocation_id, member_id, status,
                   confirmed_amount, note, created_at)

disputes(id, allocation_id, opened_by, reason, status,
         resolution, resolved_by, created_at)

shares(id, bill_id, member_id, amount, currency, status,
       paypal_order_id, paypal_capture_id, due_at, paid_at)

payments(id, share_id, provider, provider_ref, amount, currency,
         status, raw_payload, created_at)

reminders(id, share_id, scheduled_for, sent_at, channel, template,
          message, idempotency_key, status)

notification_outbox(id, channel, recipient, template, payload,
                    idempotency_key, attempts, next_attempt_at, status)

paypal_login_states(state_hash, return_to, created_at)
auth_handoffs(code_hash, user_id, expires_at, used_at, created_at)
```

Bill states: `UPLOADED -> PARSING -> PARSED -> ALLOCATED -> CONFIRMED -> FINALIZED -> COLLECTING -> SETTLED` plus `CANCELLED`.
Share states: `PROPOSED -> CONFIRMED -> REQUESTED -> PAID -> SETTLED` plus `DISPUTED`, `FAILED`, `REFUNDED`.

### 2.6 TimescaleDB design

**Why TimescaleDB is justified here**

The product generates high-volume, append-only, time-stamped facts: ledger events, item confirmations, reminders, notification delivery, points awards, webhook receipts, agent actions. The leaderboard and repayment-speed metrics are rolling-window queries over those facts. TimescaleDB gives us:

- `time_bucket` queries for daily/weekly group activity and repayment speed
- Continuous aggregates so the leaderboard does not scan raw history
- Compression and retention to keep a small self-hosted server healthy
- A clean audit trail for agreement acceptance and money state changes

Core transactional tables stay as ordinary Postgres tables. Timescale is additive, not a replacement for relational modeling.

**Hypertables**

```
ledger_events(time timestamptz, event_id uuid, group_id, agreement_id,
              share_id, member_id, event_type, amount_minor, currency,
              metadata jsonb)

points_events(time timestamptz, event_id uuid, group_id, member_id,
              delta int, reason text, agreement_id, share_id)

notification_events(time timestamptz, event_id uuid, channel, template,
                    member_id, status, provider_ref)

agent_events(time timestamptz, event_id uuid, group_id, actor, tool,
             input jsonb, output jsonb, latency_ms)

webhook_events(time timestamptz, event_id text, event_type,
               payload jsonb, processed_at)
```

**Continuous aggregates**

```
group_activity_1d     -- time_bucket('1 day'): events, settled_minor, active_members
member_repayment_1d   -- avg seconds from REQUESTED to PAID per member
```

**Leaderboard query shape**

```sql
SELECT member_id,
       sum(delta) FILTER (WHERE reason = 'globie') AS globie,
       count(*) FILTER (WHERE reason = 'hero')     AS hero_count
FROM points_events
WHERE group_id = $1
  AND time > now() - interval '30 days'
GROUP BY member_id
ORDER BY globie DESC, hero_count DESC;
```

**Policies**
- Chunk interval: 1 day for high-volume event tables
- Compression after 7 days; retention 90 days for raw webhooks and agent events
- Continuous aggregates retained indefinitely
- Core relational tables are never hypertables

**Fallback:** if the Timescale extension fails to load, the app still runs on plain Postgres; only analytics and the leaderboard degrade. Do not put correctness-critical state exclusively in a hypertable.

### 2.7 Receipt AI pipeline (photo and video)

**Input limits**
- Photo: JPEG/PNG/HEIC, up to 15 MB
- Video: MP4/MOV, up to 60 seconds and 100 MB
- Client-side compression before upload; server-side validation of MIME and magic bytes

**Pipeline**
1. Store media in a private volume; generate a signed access URL
2. For video, ffmpeg samples 4–6 frames (scene changes plus evenly spaced) at max 1280px wide
3. Run vision extraction per frame into the receipt JSON schema
4. Merge frames: choose the highest-confidence value per field; union line items; detect duplicates
5. Reconcile totals: `subtotal + tax + service + tip - discount == total`; flag mismatch rather than guessing
6. Return a draft bill with per-item confidence and a "needs review" flag
7. Member-facing confirmation cards; organizer correction UI
8. If extraction fails twice, fall back to manual entry with the image shown alongside

**Receipt JSON schema**

```json
{
  "merchant": "string|null",
  "currency": "ISO-4217",
  "items": [{"name": "string", "qty": 1, "unit_price_minor": 0, "line_total_minor": 0, "confidence": 0.0}],
  "subtotal_minor": 0,
  "tax_minor": 0,
  "service_charge_minor": 0,
  "tip_minor": 0,
  "discount_minor": 0,
  "total_minor": 0,
  "warnings": ["string"]
}
```

All money is stored as integer minor units. No floating point.

### 2.8 Allocation and confirmation

1. Assign each item to one or more members
2. Shared items split equally among assignees
3. Tax, service charge, and tip prorate by each member's subtotal share
4. Discounts prorate the same way
5. Round to minor units; assign the remainder to the fronter
6. Assert `sum(shares) == bill.total`; block sending otherwise
7. Each member confirms their own allocation; disputes reopen only that allocation
8. Finalization requires all allocations confirmed or organizer-resolved, with an audit entry

### 2.9 PayPal integration

| Capability | API | Use |
|---|---|---|
| OAuth | `/v1/oauth2/token` | Server-side client credentials |
| Create order | `POST /v2/checkout/orders` | One order per member share, with `purchase_units[].payee` set to the fronter |
| Capture | `POST /v2/checkout/orders/{id}/capture` | After payer approval; funds settle to the payee, not to us |
| Invoicing | `/v2/invoicing/invoices` | Email-based fallback collection |
| Webhooks | `PAYMENT.CAPTURE.COMPLETED`, `CHECKOUT.ORDER.APPROVED`, `INVOICING.INVOICE.PAID` | Verified state updates |
| Agent toolkit | PayPal MCP server | Expose PayPal actions as agent tools |

**Implementation rules**
- Idempotency key derived from `share_id + attempt`
- Verify webhook signature; store the raw payload; deduplicate on event ID
- Recompute amounts server-side from allocations; never trust client input
- One currency per order; show conversion separately and label it indicative
- Block payment-request creation unless the bill is `CONFIRMED` and totals reconcile

**The fronter is the payee, not the platform.** The fronter settles the merchant bill however they actually paid — cash, card, PromptPay, anything, entirely outside PayPal. Members then reimburse *them*: the order is created with our API credentials but names `purchase_units[].payee` as the fronter's PayPal account (`members.paypal_email` today, `members.paypal_merchant_id` when we switch to merchant ids), so the capture moves money from the payer straight to the fronter. The platform never holds funds and there is no payout batch. Webhooks still arrive at `/api/paypal/webhook` because we are the API caller, so verification, dedupe and the `amountMatches()` guard remain authoritative.

A fronter with no `paypal_email` blocks collection: `POST /bills/:id/request-payments` (and the tip equivalent) answer `409 fronter_paypal_missing` instead of quietly collecting into the platform account. The fix is in-app — `PATCH /me {paypalEmail}` writes it to every active membership, and Settings → *Getting paid* exposes the field.

**Signing in is a separate API.** Orders, capture and webhooks above never authenticate a person; identity comes from the Identity API described in §2.17. The two share `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` and the `api-m(.sandbox)` hosts, nothing else.

### 2.10 API surface

```
POST   /api/auth/session
GET    /api/auth/paypal/start
GET    /api/auth/paypal/callback
POST   /api/auth/paypal/handoff

POST   /api/groups
POST   /api/groups/:id/members
GET    /api/groups                          the caller's memberships
GET    /api/groups/:id

POST   /api/agreements
POST   /api/agreements/:id/accept
POST   /api/agreements/:id/cancel

POST   /api/agreements/:id/bills
POST   /api/bills/:id/media               multipart upload
POST   /api/bills/:id/parse               async job
GET    /api/bills/:id
PATCH  /api/bills/:id/allocations
POST   /api/allocations/:id/confirm
POST   /api/allocations/:id/dispute
POST   /api/bills/:id/finalize

POST   /api/bills/:id/request-payments
POST   /api/paypal/webhook
GET    /api/bills/:id/ledger
POST   /api/shares/:id/capture

GET    /api/me/shares
GET    /api/groups/:id/leaderboard
GET    /api/me/points
POST   /api/agent/message
GET    /api/health
```

### 2.11 Agent tool contract

```
parse_receipt_media(bill_id) -> { items[], totals, warnings[], confidence }
propose_allocation(bill_id, hints) -> { allocations[], questions[] }
request_item_confirmation(bill_id) -> { sent: n }
create_payment_request(bill_id, share_id) -> { paypal_order_id, approve_url, amount }
get_bill_status(bill_id) -> { shares[], totals, outstanding }
send_reminder(share_id, tone) -> { message, sent_at }
award_points(agreement_id, share_id, reason) -> { delta, balance }
```

**Guardrails**
- `create_payment_request`, `send_reminder` and `award_points` require a server-side confirmation token
- Every tool call is logged to `agent_events` with input, output, latency, and actor
- The agent cannot invent members, amounts, or currencies; all IDs come from the database

### 2.12 Gamification rules

| Mechanic | Rule | Anti-gaming |
|---|---|---|
| **Hero** | Awarded to members who front cash for an agreement. Leaderboard 1st place = largest total fronted in the group over 30 days; tie-break = earliest acceptance | Only counts settled agreements; self-dealing excluded; refunds reverse the award |
| **Globie** | Non-transferable in-app points. First member to reimburse after requests are sent: 10; second: 5; third: 3; everyone else: 1 | Only reimbursements to another member count; one award per share; unique `(agreement_id, member_id, reason)`; cap 50/day; refunds reverse |
| **Leaderboard** | Rolling 30 days, per group: Hero totals, Globie balance, repayment speed, reliability | Computed from append-only `points_events` and `member_repayment_1d` |

**Legal copy in-app:** "Globie points are a non-transferable engagement reward with no cash value and no redemption guarantee." Do not call them crypto tokens.

### 2.13 Notifications

**Channels**
- Email: SMTP or a transactional provider with a verified sender
- Push: `expo-notifications` + Expo Push Service (APNs/FCM) on native; web users fall back to in-app and email
- WhatsApp: Meta WhatsApp Cloud API or Twilio sandbox, template-based; demo-only because template approval is outside our control
- In-app: chat timeline messages

**Architecture**
- `notification_outbox` with `idempotency_key`; pg-boss worker delivers with exponential backoff
- `users.push_token` stores the Expo push token; tokens are deactivated on `DeviceNotRegistered`
- Reminder schedule: T-24h, due date, +24h, +72h, then weekly until paid or cancelled
- Quiet hours 22:00–08:00 in the member's timezone; queue instead of sending
- Per-member, per-channel consent with opt-out
- Every send is logged to `notification_events`

**Fallback order:** in-app → push → email → WhatsApp. Web has no push channel, so web-only members get in-app and email. Never make WhatsApp a hard dependency for the demo.

### 2.14 Repository layout

```
/
  app/                        Expo universal client (expo-router)
    app/
      _layout.tsx
      index.tsx                groups + create agreement
      groups/[id]/index.tsx    chat timeline
      groups/[id]/bill.tsx     receipt capture, allocation, confirmation
      groups/[id]/leaderboard.tsx
      me/shares.tsx
    components/                chat/ receipt/ confirm/ ledger/ leaderboard/ ui/
    lib/                       api client, session token, money, queries
    app.json                   web.output, experiments.baseUrl, plugins
  server/                     Fastify API + workers
    src/
      index.ts                 bootstrap, plugins, error handler
      routes/                  agreements, bills, allocations, shares, webhook, agent
      db/                      pool, migration runner
      paypal/                  orders (payee = fronter), invoicing, webhook verification
      agent/                   tool definitions + orchestrator
      jobs/                    pg-boss: parse, reminders, aggregates
      lib/                     money (minor units), config, ids
    Dockerfile
  db/
    migrations/                SQL migrations, Timescale setup
    seed.ts
  docker-compose.yml
  scripts/
    deploy.sh
    backup.sh
  tests/
  postman/
  .env.example
  LICENSE
  README.md
```

### 2.15 Deployment target — `globie.ai` on Easypanel

**Public URLs**
- Web app: `https://keeper.globie.ai`
- API: `https://keeperapi.globie.ai` (all routes under `/api`)

**Topology.** `globie.ai` is on Cloudflare, which resolves `*.globie.ai` to the self-hosted Easypanel origin. Easypanel owns TLS and routes each subdomain to its service, so the app no longer needs a path prefix or a bundled TLS proxy:

```
browser ──> Cloudflare (keeper.globie.ai)    ──> Easypanel ──> web   :80   (Expo export in nginx)
browser ──> Cloudflare (keeperapi.globie.ai) ──> Easypanel ──> api   :3001 (Fastify)
                                                                 db    :5432 (Timescale, internal only)
```

**Implementation requirements**
- Expo web export keeps `web.output: "single"`; `experiments.baseUrl` is **not** set, so the bundle is served from `/` and client-side routes fall back to `index.html`
- The API knows both hostnames: `PUBLIC_ORIGIN=https://keeperapi.globie.ai` and `WEB_ORIGIN=https://keeper.globie.ai`. The first builds PayPal callback URLs, the second is where the API sends a browser after sign-in and where invite links point; both are in the CORS allow-list
- The client reads its API base from `EXPO_PUBLIC_API_URL`; when unset, a production bundle falls back to `https://keeperapi.globie.ai` and web link origins to `https://keeper.globie.ai`
- PayPal `return_url` / `cancel_url` are platform-aware: browser URL for web, `globiekeeper://paypal/return` deep link opened by `expo-web-browser` on native
- PayPal checkout on native opens in the system browser (never an embedded WebView); the app resumes via deep link and re-fetches state from the API
- Migrations run on deploy; seed the demo only via an explicit command
- `GET /api/health` checks API, database, and worker heartbeat
- `.env` with `600` permissions; secrets never committed; only `EXPO_PUBLIC_*` values reach the client bundle
- **Webhook URL:** `https://keeperapi.globie.ai/api/paypal/webhook`
- Nightly `pg_dump` + uploads snapshot; documented restore command

**Images.** Both services ship as self-contained Docker Hub images built off this repo, so the deploy host only pulls:
- `tradex367/globie-keeper-api:latest` — `server/Dockerfile`, root context, carries `db/migrations`
- `tradex367/globie-keeper-web:latest` — `deploy/Dockerfile.web`, carries the Expo export in nginx

Pin a digest or a different tag with `API_IMAGE` / `WEB_IMAGE`. The bundled `proxy` service and `scripts/deploy.sh` remain for one-origin setups (staging, a raw VPS, local prod rehearsal); Easypanel does not use them.

**TLS is a hard dependency.** PayPal must reach the webhook over a trusted certificate and judges should not see browser warnings. Cloudflare/Easypanel supplies it for both subdomains; the origin's own self-signed cert is never user-visible.

**Resource guardrails**
- Cap video at 60s/100MB; process one video at a time per worker
- Set ffmpeg timeouts; reject unsupported codecs
- Configure Postgres shared_buffers and Timescale compression for the server size

### 2.16 Security and privacy

- Receipts may contain card last-4, names, and merchant data: private storage, signed URLs, delete-after-settle option
- Hash IP addresses used for consent records; do not store raw IPs
- No secrets in client bundles; all PayPal and LLM calls server-side
- Rate-limit invite joins, uploads, and agent messages
- Authorization check on every group, bill, allocation, and share read
- Logs redact emails, PayPal payer IDs, and webhook payload bodies
- Sandbox credentials only; rotate after the hackathon

### 2.17 Log in with PayPal — identity and account linking

Source: `https://developer.paypal.com/log-in/how-it-works` (with `/log-in/build`, `/log-in/build-button/`, `/log-in/references`). This is the **Identity API** — plain OAuth 2.0 + OIDC — and is deliberately separate from the Orders work in §2.9: payments never authenticate a person, and sign-in never moves money.

**Protocol**

| Step | Call |
|---|---|
| 1. Consent | `GET https://www.sandbox.paypal.com/connect?flowEntry=static&client_id=…&response_type=code&scope=openid%20profile%20email&redirect_uri=<encoded>&state=…` (live host: `www.paypal.com/connect`) |
| 2. Return | `GET <redirect_uri>?code=<authorization_code>&scope=…` |
| 3. Exchange | `POST /v1/oauth2/token`, header `Authorization: Basic base64(client_id:secret)`, form `grant_type=authorization_code&code=…` → `access_token` (28800 s), `refresh_token`, `nonce`, `scope` |
| 4. Read user | `GET /v1/identity/oauth2/userinfo`, header `Authorization: Bearer <access_token>` |
| Refresh (unused today) | same token endpoint with `grant_type=refresh_token` |

Scopes map to exactly what we store: `openid` → PayPal payer ID, `profile` → full name, `email` → email plus verified flag, `address` → postal fields, `https://uri.paypal.com/services/paypalattributes` → account verification status. The reimbursement payee (§2.9) is keyed by **email**, so `openid profile email` is the baseline set.

Dashboard prerequisites (`Apps & Credentials` → sandbox → app → **Features** → *Add-on services* → **Log in with PayPal** checkbox → **Manage**): tick the feature first, then register the **Return URL** (must equal `PAYPAL_LOGIN_RETURN_URL` exactly, e.g. `https://keeperapi.globie.ai/api/auth/paypal/callback`) and tick the same user-info fields the scope string requests. Sandbox is usable immediately; **live requires PayPal app review.** PayPal refuses `http://localhost` return URLs (`422 INVALID_PARAMETER_VALUE`), so local sign-in needs an https tunnel whose callback is registered, or has to run against the deployed API.

A disabled feature is indistinguishable from a bad client id: `/connect` returns HTTP 200 with the generic *"Sorry about that … (invalid client_id or redirect_uri)"* page for an unregistered app, a bogus client id, a missing `redirect_uri` and the legacy `/webapps/auth/protocol/openidconnect/v1/authorize` path alike. Diagnose it before touching env vars — a `client_credentials` token against `api-m.sandbox.paypal.com` proves the credentials themselves are fine. After saving, the app needs up to three hours to propagate, and every user-info checkbox renders locked until the app passes review.

**Flow — server-side redirect, one path for web and native**

The secret never leaves the server (§2.16), `state` is verified server-side, and the client never has to hand a code back from a webview:

```
app ──start──> GET /api/auth/paypal/start        server mints state, stores its hash
                 └─ 302 → paypal.com/connect?flowEntry=static&fullPage=true&…
browser ──────> GET /api/auth/paypal/callback?code&state
                 ├─ verify + consume state
                 ├─ POST /v1/oauth2/token        (Basic client_id:secret)
                 ├─ GET  /v1/identity/oauth2/userinfo
                 ├─ upsert users, link PayPal, mint session
                 └─ 302 → web:    {webOrigin}/paypal/login?handoff=…
                          native: globiekeeper://auth/return?handoff=…
app ──finish──> POST /api/auth/paypal/handoff {code}
                 └─ {token, userId, displayName}   ← identical to POST /api/auth/session
```

The callback answers with the **same `{token, userId, displayName}` shape** that `POST /api/auth/session` returns, so `lib/api.ts::signIn`, `lib/session-context.tsx` and the stored-session record keep exactly one code path.

**Rules**

- `state` is 32 random bytes, stored SHA-256 hashed in `paypal_login_states` with a 10-minute TTL and consumed exactly once; an unknown, expired or replayed value fails before any token exchange.
- The session token never travels in a URL. The redirect carries a 60-second, single-use `handoff` code (`auth_handoffs`), exchanged for the real token by `POST /api/auth/paypal/handoff`. This keeps tokens out of browser history, `Referer` headers and API access logs.
- `access_token` and `refresh_token` are **discarded** after `userinfo`. Nothing downstream needs them; not storing them removes rotation and breach surface.
- The scope string sent must match the user-info fields ticked in the dashboard, or PayPal rejects the authorize URL. Keep one constant, `PAYPAL_LOGIN_SCOPES`.
- Native opens the sheet with `WebBrowser.openAuthSessionAsync(authorizeUrl, 'globiekeeper://auth/return')` and treats anything but `type === 'success'` as a user cancel (no error toast). Web does a plain navigation instead of a popup, because a sheet is the wrong affordance in a browser.
- `fullPage=true` on the authorize URL: inside the native auth sheet the popup layout renders squeezed.

**Account merge and takeover rules** (the decisive part, against `users_email_unique on lower(email)`)

1. Upsert by `lower(email)`; an existing row is **linked**, never duplicated.
2. A row that already carries a different `paypal_payer_id` answers `409 paypal_already_linked`. Never re-link.
3. A PayPal-linked row refuses email-only `POST /api/auth/session` with `409 use_paypal_login`. Without this, the password-less flow in §2.10 lets anyone who types a victim's address inherit a verified account.
4. On link, backfill `members.paypal_email` for that user's rows where it is null, so the fronter's reimbursement payee is set without asking twice.

**Changes**

| File | Change |
|---|---|
| `db/migrations/005_paypal_login.sql` | `users.paypal_email/paypal_verified/paypal_linked_at`; partial unique index on `paypal_payer_id`; `paypal_login_states(state_hash, return_to, created_at)`; `auth_handoffs(code_hash, user_id, expires_at, used_at, created_at)` |
| `server/src/lib/config.ts` | `paypalLoginReturnUrl` (defaults to `${publicOrigin}/api/auth/paypal/callback`), `paypalLoginScopes` (defaults to `openid profile email`), `paypalLoginWebReturnUrl`, `paypalLoginNativeReturnUrl` |
| `server/src/lib/ids.ts` | `createOpaqueCode()` — 32 random bytes, base64url — shared by the `state` value and the handoff code |
| `server/src/lib/paypal.ts` | `buildLoginAuthorizeUrl(state)`, `exchangeAuthorizationCode(code)`, `fetchUserInfo(accessToken)`, `type PayPalIdentity`. No `refreshLoginToken`: both tokens are discarded after `userinfo`. Reuses the existing `apiBase()` and leaves the `client_credentials` `accessToken()` untouched so Orders/webhooks do not regress |
| `server/src/routes/auth.ts` | `GET /auth/paypal/start`, `GET /auth/paypal/callback` (redirect-only, never throws — `start` too: unconfigured answers `302 …?error=paypal_not_configured`), `POST /auth/paypal/handoff` (atomic CTE consume), reusing `createSessionToken()` / `hashToken()`; `POST /auth/session` answers `409 use_paypal_login` for a linked row |
| `lib/api.ts` | `payPalLoginUrl(surface)`, `completePayPalHandoff(code)` — through the same `storeSession()` tail as `signIn` |
| `lib/paypal-login.ts` | `startPayPalLogin()` (web navigation vs `openAuthSessionAsync`), `readPayPalReturn(url)`, `payPalErrorMessage(code)` for the five callback error codes |
| `lib/session-context.tsx` | `signInWithPayPal()` and `completePayPalLogin(code)` on `SessionState`, both writing through the one session setter |
| `components/sign-in.tsx` + `components/ui/{theme,button}.tsx` | PayPal-branded button above an "or use email" divider; `colors.paypal` / `colors.paypalInk` and the `'paypal'` `Button` variant. The email form stays as the unconfigured fallback |
| `app/paypal/login.tsx` + `app/_layout.tsx` | Web return page; `Gate` renders it when `!session` and the path ends in `/paypal/login`, since today a missing session always renders `SignIn` |
| `scripts/preview.mjs` | `__redirect` / `__status` fixture answers for `start`, `callback` and `handoff`, so the whole flow is reviewable in the browser without Postgres |

**Sandbox test pass**

- Happy path on a sandbox **personal** account, once through the native auth sheet and once through the web redirect.
- Cancel at consent, dismiss the native sheet, and kill the app mid-flow — no session is created and the button is reusable.
- Replay the same `state`, forge a `state`, and use an expired `handoff` code: all rejected, nothing written.
- Sign in with PayPal as an email that already exists from `POST /auth/session` → one `users` row, now linked.
- Second PayPal account against that linked user → `409 paypal_already_linked`; email-only sign-in against it → `409 use_paypal_login`.
- Confirm §2.9 is unaffected: order creation, capture and webhook replay still behave as in §11.1.
- Local dry run without credentials: `scripts/preview.mjs` answers `start` with a 302 to `/paypal/login?handoff=…`, that page trades the code for a session, and an unknown code returns `400 invalid_handoff`.
- Unconfigured API: `GET /api/auth/paypal/start` puts the browser back on `…/paypal/login?error=paypal_not_configured` and the page shows the client's own message — no JSON error contract, no dead end.
- `npx tsc --noEmit`, `npx expo lint` and the web export stay green.

---

### 2.18 Give a tip — anyone can thank the fronter

The fronter already absorbed the risk of paying the whole bill; a tip is the group's optional, voluntary thank-you on top of each member's own share. It is a *gesture*, not a debt: it never settles anything, is never required, and one member can tip at most once per bill.

**Why tips cannot reuse `shares` or `payments`**

| Constraint (verified in the schema) | Consequence |
|---|---|
| `shares` has `unique (bill_id, member_id)` | a tip cannot be a second share row for the same member |
| `payments.share_id` is `not null` | a tip capture cannot be written as a payment |
| the webhook answers `ignored: 'amount_mismatch'` when a capture ≠ `share.amount` | a tip capture would be dropped |
| `payments` rows roll up into `rollUpBill` | a tip would make an unfinished bill look settled |

So a tip is its own money row, resolved by the same webhook.

**Data — `db/migrations/006_tips.sql`**

```sql
tips (
  id, bill_id, agreement_id, from_member_id, to_member_id,
  amount bigint check (amount > 0), currency, message,
  status check (status in ('proposed','requested','paid','refunded','failed')),
  paypal_order_id, paypal_capture_id, paypal_approve_url,
  paid_at, created_at,
  unique (bill_id, from_member_id)     -- one tip per member per bill
)
```

Partial unique indexes on `paypal_order_id` and `paypal_capture_id` keep the webhook lookup single-valued.

**Endpoints**

| Call | Behaviour |
|---|---|
| `GET /api/bills/:id/tips` | `{canTip, frontedBy, frontedByName, totalMinor, myTip, tips[]}`. `canTip` is true only for `FINALIZED\|COLLECTING\|SETTLED` and only when the caller is not the fronter |
| `POST /api/bills/:id/tips {amountMinor, message?}` | reuses an unpaid tip row (a changed amount opens a fresh order), then `createOrder({target:{kind:'tip', id}, payee:{email: fronter}})`; answers `{tipId, paypalOrderId, approveUrl, amountMinor, alreadyRequested}` |
| `POST /api/tips/:id/capture` | eager capture like a share: `captureOrder` → `settleTip` → `{status:'paid', pointsAwarded}` |

Errors: `bill_not_finalized`, `fronter_missing`, `fronter_paypal_missing`, `cannot_tip_self`, `tip_already_paid`, `tip_in_progress` (an open checkout for a different amount), `paypal_not_configured`.

**PayPal**

`createOrder` now takes `target: {kind: 'share' | 'tip'; id}` and a mandatory `payee`; the idempotency header is `globie-${kind}-${id}` and the return URL carries `?share=` or `?tip=`, so one `/paypal/return` screen serves both. Webhook order is `findShare → findTip → share_not_found`, with the identical `amountMatches()` guard applied to `tip.amount`.

**Settlement**

- `requestTip` resolves the recipient's `paypal_email` before anything else and raises `409 fronter_paypal_missing` when it is absent — a tip with no payee would otherwise land in the platform account.
- `settleTip` takes the same `pg_advisory_xact_lock(hashtext(agreement_id))` as `settleShare`, flips the row to `paid`, awards a flat **+2 Globie** (`points_awards.reason='tip'`, `points_events`), and logs `tip.paid`.
- It writes **no** `payments` row and never calls `rollUpBill`: an unpaid bill can never look paid because of a tip.
- The capture itself settles into the fronter's PayPal account, exactly like a share — there is no batch and nothing left to pay out.
- A refund reverses the +2 (`tip.refunded` + negative `points_events`).

**UI**

- `app/groups/[id]/bill.tsx`: a "Tip the fronter" card once the bill is locked — three one-tap sizes (20/50/100), the member's own tip state, and the list of tips already given.
- `app/(tabs)/me/shares.tsx` keeps sending the *share* to checkout; paid shares vanish from that list, which is why the tip entry lives on the bill screen.
- `app/paypal/return.tsx` branches on `?tip=` and thanks the member with Baby Kae Na (`+2 Globie`), replacing the route with Home.
- Tips never appear in the leaderboard ranking; they only move the Globie balance.

**Test pass**

- Tip from a member → approve → capture → tip `paid`, +2 Globie, `tip.paid` in the timeline, money visible in the fronter's sandbox balance.
- Fronter opens the bill → no tip buttons, sees the tip list and the total.
- Fronter without a PayPal email → `POST /bills/:id/tips` answers `409 fronter_paypal_missing`; after Settings → *Getting paid* saves an address, the same call succeeds.
- Replay the capture and the webhook → one award, `alreadyPaid: true`.
- Refund in the PayPal dashboard → tip `refunded`, Globie reversed.
- `npx tsc --noEmit`, `npx expo lint`, server `npm run typecheck` stay green.

---

### 2.19 FX display currency — "see it in my money"

Every amount in Globie is a debt denominated in the *group's* currency and settled through PayPal in that currency. A member who thinks in EUR or USD should still be able to read ฿1,300.00 as "≈ €34.56" — but that number must never become the number we charge.

**The hard rule: FX is presentation only**

| Invariant | What breaks if a converted amount enters the money path |
|---|---|
| `shares.amount` must equal the captured amount | webhook answers `ignored: 'amount_mismatch'` |
| `tips.amount` must equal the captured amount | same guard; the tip never settles |
| `purchase_units[].amount.currency_code` is fixed at order creation | the payer sees a total PayPal never charges |
| the agent's confirmation token is the binding number | the user approves a number PayPal will not charge |

So the canonical minor amount is always the one stored and sent; the displayed currency is a *rendering* decision made on the client from a rate, never a stored conversion.

**P0 prerequisite — the exponent table (ship first, alone)**

`server/src/lib/paypal.ts` treated only `JPY` as zero-decimal and `lib/money.ts` hardcoded `exponent = 2` / `locale = 'en-US'`. Any KRW/VND/CLP/HUF/ISK amount would be charged 100× too high, and KWD/BHD/OMR 10× too low. Replace both with one shared ISO-4217 table:

- exponent **0**: `BIF CLP DJF GNF ISK JPY KMF KRW PYG RWF UGX UYI VND VUV XAF XOF XPF`
- exponent **3**: `BHD IQD JOD KWD LYD OMR TND`
- exponent **2**: everything else

`formatMinor()` also drops `locale = 'en-US'` in favour of the device locale, so grouping and decimal separators are right for the reader.

**Where the rate comes from — and what PayPal will and will not give us**

PayPal publishes **no** public exchange-rate endpoint: all 13 published OpenAPI specs were grepped for `rate|curren|fx` paths and none exists. Two things do exist:

| Where | Field | When |
|---|---|---|
| Orders v2 capture | `purchase_units[].payments.captures[].seller_receivable_breakdown.exchange_rate = {source_currency,target_currency,value}` | after capture, merchant-side only |
| Orders v2 request | `payment_instruction.payee_receivable_fx_rate_id` | FXaaS-onboarded merchants only |

The second one belongs to **FX as a Service**, a business-account program with its own FX API: rates published at a daily *Rate Refresh Time* for a 24-hour *Rate Period*, each carrying an **FX ID** that must accompany the transaction, and re-priced mid-period if the underlying rate moves more than **3.5%**. It is not self-serve, so it is not available to this app today.

Therefore the honest split:

- **Layer A — indicative rates, before payment.** Sourced from `https://open.er-api.com/v6/latest/THB` (no key, ~166 currencies, updated daily) and always rendered with a `≈` and a footnote: *"PayPal sets the final rate at checkout."* Optional secondary source `https://api.frankfurter.dev/v1/latest?base=THB` (ECB reference, ~30 currencies) — the two agreed to 0.05% at time of writing.
- **Layer B — authoritative, after payment.** The capture's `exchange_rate` is already persisted inside `payments.raw_payload`; surface it on the ledger row as *"converted at 0.02945 — received ฿1,178.00"*. No new API call, no new trust boundary.

**Rate math**

```
targetMinor = round(sourceMinor × rate × 10^(targetExp − sourceExp))
```

Rates stored as `numeric(20,10)`, converted with integer arithmetic — never `float` in JS, never a float column.

**Data — `db/migrations/007_display_currency.sql`**

```sql
alter table users add column if not exists display_currency char(3);
create table if not exists fx_rates (
  base char(3) not null,
  quote char(3) not null,
  rate numeric(20,10) not null check (rate > 0),
  as_of timestamptz not null,
  source text not null,
  primary key (base, quote)
);
```

**Endpoints**

| Call | Behaviour |
|---|---|
| `GET /api/fx/rates?base=THB` | `{base, asOf, source, stale, rates}`. Served from an in-memory cache refreshed at most hourly; on upstream failure answers the last known-good snapshot with `stale: true` rather than an error |
| `GET /api/me` | adds `displayCurrency` (may be `null`) |
| `PATCH /api/me {displayCurrency}` | validates ISO-4217 via the existing `currencyCode()` validator and stores it; `null` clears the override |

`display_currency` is a *preference*, not a re-denomination: `GET /me/shares` keeps returning the group currency in `currency`.

**Client**

- `lib/fx-store.ts` / `lib/fx-store.web.ts` — the same native/web split as `session.ts`: `expo-secure-store` on device, `localStorage` on web, so the choice survives a reload before the profile call resolves.
- `lib/fx.ts` — pure conversion + `formatMinor` wrapper; no React.
- `MoneyProvider` / `useMoney()` in `app/_layout.tsx`, mirroring `SessionProvider`: holds `{displayCurrency, setDisplayCurrency, rates, asOf, converting}`, hydrates from the device first, then reconciles with `/me`.
- **Precedence:** saved account choice → saved device choice → device-locale currency (`expo-localization`, new dependency) → group currency. `converting` is false when the display currency equals the amount's currency, so nothing renders differently by default.
- A `CurrencyPill` in the Home header opens a searchable sheet; picking a currency writes device then server.

**Call sites** — `formatMinor(` is used in 10 files (17 calls): `components/ledger/share-row.tsx`, `components/chat/timeline.tsx`, `components/chat/globie-chat.tsx`, `app/(tabs)/me/shares.tsx`, `app/(tabs)/me/activity.tsx`, `app/(tabs)/index.tsx`, `app/groups/[id]/leaderboard.tsx`, `app/groups/[id]/index.tsx`, `app/groups/[id]/bill.tsx`. Each switches to `useMoney().format()`; the canonical value stays visible next to the conversion wherever a member is about to pay.

**Tip presets stay canonical.** `TIP_PRESETS = [20, 50, 100]` remain THB minor amounts; only their labels are converted, so `POST /bills/:id/tips` always receives the amount PayPal will actually charge.

**Test pass**

- Switch display currency to EUR → every list shows `≈ €…`, the checkout button still says THB, and the capture amount is unchanged.
- Pick a currency, reload on web, reopen on device → choice restored from the server.
- Kill the upstream rate host → `/api/fx/rates` answers the cached snapshot with `stale: true`; screens keep rendering.
- A JPY group round-trips a ¥ amount at exponent 0 and a KWD group at exponent 3.
- After a real capture, the ledger row shows PayPal's own `exchange_rate`, not the market one.
- `npx tsc --noEmit`, `npx expo lint`, server `npm run typecheck` stay green.

---

## 3. Milestones

Dates are fixed against the submission deadline, not effort estimates.

### Phase 0 — Foundations (Oct 26–27)
- Devpost registration, eligibility, age of majority
- PayPal sandbox app; verify Orders, Invoicing, webhooks
- Expo SDK 58 app scaffold with `expo-router`; runs on web and on a physical phone
- Fastify API scaffold with config, logging, and error handling
- Docker Compose with PostgreSQL 16 + TimescaleDB; extension enabled and verified
- Web export served from the root of `keeper.globie.ai`; Cloudflare/Easypanel TLS confirmed
- Repo, MIT license visible in About, README skeleton, CI-free deploy script
- Brand check: confirm "Globie Keeper" and "Globie" are trademark-clear; secure domain and handles
- Decide demo currency pair; verify sandbox support before locking the story

**Exit:** the Expo web build loads at the required URL and the same codebase opens on a phone; a sandbox order is created and captured via curl; test webhook reaches the API; Timescale hypertable exists and a `time_bucket` query returns.

### Phase 1 — Agreements and identity (Oct 28–30)
- Core relational schema + Timescale migrations + seed script
- Group creation, invite link, lightweight payer session
- Log in with PayPal (§2.17): authorize → code → server-side token exchange → `userinfo` → linked session, with a single-use `state` and a one-time handoff code
- Agreement creation with terms snapshot
- One-tap acceptance with consent record and audit event
- Group chat-style Expo shell shared by web and native

**Exit:** three members accept an agreement; the acceptance events are queryable and immutable.

### Phase 2 — Receipt AI and confirmation (Oct 31–Nov 2)
- Photo upload + vision extraction + reconciliation
- Video upload + ffmpeg frame sampling + multi-frame merge
- Allocation engine with unit tests (rounding, proration, discounts)
- Member confirmation cards and dispute flow
- Organizer correction UI
- "My share" view for each member

**Exit:** a real photo and a real video both produce a reconciled bill; three members confirm different items; shares sum exactly.

### Phase 3 — Money loop (Nov 3–5)
- PayPal Orders per share with the fronter as `payee`, so every capture settles to them
- Webhook signature verification, deduplication, ledger updates
- `409 fronter_paypal_missing` gate plus the Settings → *Getting paid* field
- Idempotency tests: replay webhook, retry capture, double-click pay
- Collection status in chat and ledger

**Exit:** three sandbox payers settle into the fronter's sandbox account; ledger is correct after replay.

### Phase 4 — Agent, points, notifications (Nov 6–7)
- Chat agent with tool calling and clarification
- Hero and Globie award rules with unique constraints
- Leaderboard from `points_events` + continuous aggregate
- Email + in-app reminders; Expo push on native if time allows
- WhatsApp sandbox template as a demo-only channel
- Notification outbox, retries, quiet hours

**Exit:** agent drives a correction and a reminder; points are awarded exactly once; all channels deliver or fall back cleanly.

### Phase 5 — Polish and proof (Nov 8–9)
- Mobile-first polish: loading, empty, error, retry, offline
- AG Grid ledger/admin view
- Seeded demo group + reset control
- README with architecture, setup, env vars, sandbox accounts, custody caveat
- Postman collection, Playwright happy path
- Fresh-clone test on a clean machine

**Exit:** a judge can use the hosted demo or run it locally without help.

### Phase 6 — Submission (Nov 10–11)
- Record and edit the video (target 2:40, hard cap 3:00)
- Devpost description, tools list, setup instructions
- Submit Nov 11; verify repo visibility and license
- Nov 12 reserved for submission-form issues only

**Exit:** submission is live with every required field and link.

---

## 4. Judging alignment

| Criterion | What we show | Evidence |
|---|---|---|
| Technological Implementation | PayPal Orders with a third-party `payee` + webhooks, TimescaleDB event pipeline, ffmpeg video parsing, agent tool calling | Live transactions settling to the fronter, webhook log, `time_bucket` queries, tests |
| Design | Chat-native universal app, one-tap agreement, per-member confirmation, clear payment state | Polished 4-screen demo on a phone, same UI on web |
| Potential Impact | Cash-first groups, travelers, expats, shared households, cross-border reimbursement | Named personas and a real scenario |
| Innovation | Agreement-first + per-item confirmation + agent settlement + social incentives | Contrast with Khun Thong and Splitwise |
| Presentation | 3-minute agreement-to-settled story with a visible leaderboard | Video with architecture beat |

**Sponsor strategy — cash only.** Ignore prizes that pay credits or subscriptions only (Render credits, APIMatic subscriptions alone). Cash prizes worth targeting: AG Grid ($5,000 / $2,000 / 3×$1,000), APIMatic (3×$1,000), Bryntum (3×$1,000), Channel3 ($1,500). Pick **one** to integrate deeply — AG Grid for the ledger is the natural fit — because only one sponsor prize can be won. Tools without cash prizes (Postman, Elastic, Zapier, KERNEL, Astropods) may still be used if they help, but are not a strategy.

---

## 5. Demo script (2:40)

| Time | Beat |
|---|---|
| 0:00–0:15 | Cash-only restaurant; two friends front the bill; the group chat problem |
| 0:15–0:35 | Create agreement in one tap; three members accept on their phones |
| 0:35–1:00 | Upload a receipt video; AI extracts items and totals live |
| 1:00–1:25 | Each member confirms their own items; one dispute and agent resolution |
| 1:25–1:55 | Shares finalize; three PayPal sandbox payments; ledger updates from webhooks |
| 1:55–2:15 | Automated reminder on WhatsApp/push to the last payer; they pay |
| 2:15–2:30 | Hero + Globie leaderboard updates; the fronter's PayPal balance already shows the reimbursements |
| 2:30–2:40 | Architecture, TimescaleDB event pipeline, impact, no-custody design |

**Video constraints:** under 3 minutes, public on YouTube, English narration or subtitles, no third-party logos or copyrighted music, real app footage.

---

## 6. Acceptance tests

1. Three members accept an agreement; acceptance records are immutable and attributed
2. A photo receipt parses; item sum plus tax/tip/discount equals the printed total
3. A 30-second receipt video yields frames and a reconciled bill
4. Reassigning an item recalculates shares and preserves the exact total
5. Each member can confirm only their own allocation; another member cannot confirm on their behalf
6. A dispute blocks finalization until resolved or organizer-overridden with an audit entry
7. Payment requests cannot be created before finalization
8. Three sandbox payers settle; each share reaches PAID exactly once
9. Replaying a webhook or retrying a capture does not duplicate a payment or a point award
10. Globie is awarded once per share; refunds reverse it; the daily cap holds
11. Hero totals only include settled agreements and exclude self-dealing
12. Leaderboard matches a hand-computed result for a seeded dataset
13. Reminder outbox retries a failed send and respects quiet hours
14. WhatsApp failure falls back to email without breaking the flow
15. Fresh clone + documented env vars produces a running app
16. No secrets, payer PII, or raw webhook payloads in client logs
17. Log in with PayPal produces one linked account on both web and native; a replayed `state`, a forged `state`, and an expired handoff code each create no session (§2.17)
18. A PayPal-linked email refuses email-only sign-in, and a second PayPal account cannot relink or take over that row

---

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Judged as a Khun Thong/Splitwise clone | Lead with agreement-first + per-item confirmation + social incentives; original branding |
| "Mockup" disqualification | Real sandbox transactions and webhook state changes in the demo |
| PayPal peer-to-peer/custody limits | We never hold funds: orders name the fronter as `payee`, so each capture settles to them. The fronter settles the merchant outside PayPal |
| Third-party payee rejected in sandbox | Verify in Phase 0 with two sandbox accounts; the 409 gate and settings field are already in place, so the fallback is a fronter-owned business account, not platform custody |
| Vision errors on receipts | Seeded fixture, confidence flags, correction UI, manual fallback |
| Video processing overloads the server | 60s/100MB cap, single worker concurrency, ffmpeg timeout, queue |
| Agent hallucinating amounts | Deterministic split engine; LLM never computes money |
| TimescaleDB adds operational risk | Core state in ordinary tables; analytics degrade gracefully; verify extension in Phase 0 |
| WhatsApp template approval delays | Email + push are the default; WhatsApp is demo-only with a sandbox sender |
| Multi-channel scope creep | Ship in-app + email first; push second; WhatsApp last |
| Gamification seen as gimmick | Tie Hero to real behavior (fronting) and Globie to repayment speed; show it on the settlement screen |
| Self-hosted TLS not trusted | Domain + Let's Encrypt or a trusted tunnel; verify PayPal test webhook in Phase 0 |
| Two hostnames, one codebase (API on `keeperapi.`, SPA on `keeper.`) | Keep `PUBLIC_ORIGIN` and `WEB_ORIGIN` separate in the API, allow both in CORS, and never derive the web link origin from the API origin |
| Expo web export differs from native rendering | Build the web bundle every day, not just at the end; test the four demo screens on both surfaces |
| PayPal checkout unusable inside an in-app WebView | Open checkout with `expo-web-browser` in the system browser and resume via deep link; never use an embedded WebView |
| Live "Log in with PayPal" is blocked by app review | Ship the sandbox flow behind `PAYPAL_ENV`; keep email sign-in as the unconfigured fallback; file the Privacy policy and User agreement URLs with the app early (§2.17) |
| Expo push needs FCM/APNs credentials | Push is a "should"; email + in-app must work without any push credential |
| Native builds blocked by store review | Demo from Expo Go / dev client and the web build; store submission stays post-hackathon |
| Region or age eligibility | Confirm all members meet the age of majority before submitting |

---

## 8. Submission checklist

- [ ] Public GitHub repo with an OSI license visible in the About section
- [ ] README with setup, env vars, sandbox accounts, architecture, and the custody caveat
- [ ] Working demo at `https://keeper.globie.ai`, or reproducible local run
- [ ] PayPal test webhook reaches the deployed server over trusted TLS
- [ ] Text description covering features, users, PayPal usage, and AI usage
- [ ] Tools list: exact AI model/service and PayPal products used
- [ ] YouTube demo video under 3 minutes, publicly visible
- [ ] All materials in English
- [ ] No third-party trademarks or copyrighted media in the video
- [ ] Sponsor tool usage documented if claiming a cash sponsor prize
- [ ] Submission completed on Devpost before the deadline
- [ ] Project is original, solely owned, and meaningfully built during the window

---

## 9. Open decisions

1. **Brand name** — original, trademark-clear
2. **Demo market** — US-only simplicity vs. a Thailand/US cross-border story
3. **Second currency** — only if sandbox support is verified in Phase 0
4. **WhatsApp provider** — Meta Cloud API vs. Twilio sandbox (pick one in Phase 0)
5. **Third-party `payee` support** — verify early with two sandbox accounts; without it the fallback is a fronter-owned business account
6. **Globie redemption story** — engagement-only for the hackathon; no redemption promise
7. **PayPal login in sandbox or live** — the demo runs sandbox-only; a live "Log in with PayPal" needs PayPal app review (weeks), so the email sign-in stays as the unconfigured fallback (§2.17)

---

## 10. Role split

| Role | Owns |
|---|---|
| Full-stack lead | Expo app (web + native), Fastify API, auth, agreements, item confirmation, ledger |
| Payments engineer | PayPal Orders with a third-party `payee`, webhooks, idempotency, no-custody review |
| AI + data engineer | Receipt photo/video pipeline, agent tools, Timescale schema, aggregates, points |
| Design/producer | Mobile UX, leaderboard, demo data, video, submission copy |

**Solo order of attack:** agreement + confirmation → receipt parse → PayPal settlement → reminders → points/leaderboard → video. Cut video parsing and WhatsApp before cutting the agreement, confirmation, or settlement loop.

---

## 11. Build status

Snapshot: **2026-11-06**. Updated whenever a milestone lands, so the plan and the repo never drift.

### 11.1 Done and verified against a live database

Local stack: PostgreSQL on `127.0.0.1:55432` (TimescaleDB optional; plain Postgres falls back cleanly), migrations `001_init.sql` through `009_payee_direct.sql` applied, Fastify 5 on Node 22, pg-boss 12.

| Area | State | Evidence |
|---|---|---|
| Server skeleton, health routes, config, migration runner | Done | `GET /health` and `GET /api/health` return 200 |
| Session auth (opaque bearer token, SHA-256 hash stored) | Done | `POST /api/auth/session` upserts user and rotates token |
| Groups: create, join by invite token, detail, timeline, leaderboard | Done | Detail returns `{group, members, agreement, bill, me}`; leaderboard flags the fronter `isHero: true` |
| Agreements: create, list, one-tap accept, status machine | Done | Accept is idempotent; ledger records `agreement.*` events |
| Bills: create, media upload (photo or video), detached parse, read | Done | Multipart upload stores under `var/media/<billId>/`; `GET /api/bills/:id` returns `{bill, allocations, shares}` |
| Allocations: replace-set with largest-remainder `allocate()` | Done | Per-item weights split a 16,000 line as 8,000 / 8,000 with no penny loss |
| Per-member confirmation of own lines | Done | Non-owner confirm rejected `not_your_line`; bill flips to `CONFIRMED` only when no `proposed` lines remain |
| Finalize: shares, residue to the fronter, `sum(shares) == bill.total` assertion | Done | 29,500 items + 2,065 tax produced Ana 19,065 / Ben 12,500 THB minor = 31,565 exactly |
| Request payments (PayPal Orders v2, one order per share) | Done against the live sandbox | Each order sets `purchase_units[].payee` to the fronter's PayPal email, so a capture settles to them and never to us. A local smoke run created order `38L31957VN943501N` with `payee.email_address = ana@example.com`, 355.00 THB, status `PAYER_ACTION_REQUIRED` |
| Tips to the fronter (§2.18) | Done for order creation | `POST /api/bills/:id/tips` created `2NF49481XL416121G` at 100.00 THB payable to the same fronter (description *"Globie Keeper — tip for Ana"*); `POST /api/tips/:id/capture` is wired to `settleTip` but, like a share, needs a buyer approval to run |
| Fronter payee gate and *Getting paid* setting | Done | `POST /api/bills/:id/request-payments` and `POST /api/bills/:id/tips` answer `409 fronter_paypal_missing` when the fronter has no `paypal_email`; `GET /api/me` returns it, `PATCH /api/me {paypalEmail}` writes it to every active membership, and Settings → *Getting paid* exposes the field |
| `POST /api/paypal/webhook` | Done | Verifies the signature, dedupes into `webhook_receipts`, reconciles the amount, audits into `webhook_events`; a replayed `PAYMENT.CAPTURE.COMPLETED` answers `{ok:true,duplicate:true}` |
| Settlement: share `paid`, `payments` row, ledger `share.paid`, bill `SETTLED`, agreement `settled` | Done | Two captured shares rolled the bill and agreement to `settled`; `ledger_events` carries `hours_to_pay` for the repayment aggregate |
| Globie points 10 / 5 / 3 / 1 and refunds | Done | Rank 1 awarded 10, rank 2 awarded 5; `points_awards` unique per `(agreement_id, member_id, reason)`, 50/day cap, refunds reverse |
| `POST /api/shares/:id/capture` | Done | Captures server-side after browser approval; a double-click resolves to `alreadyPaid` |
| `/api/me/shares`, `/api/me/points` | Done | Outstanding shares returned oldest deadline first with `outstandingMinor` and display currency |
| `POST /api/agent/message` over the §2.11 tool contract | Done | All seven tools run against the live database; each call appends `agent_events` with input, output, latency and actor, including refused calls |
| Agent confirmation tokens | Done | `create_payment_request`, `send_reminder` and `award_points` answer `confirmationRequired` + a 10-minute HMAC token bound to the exact arguments; a tampered argument or a different call is rejected `invalid_confirmation` |
| Agent guardrails | Done | `propose_allocation` rejects a member from another group (`invalid_member_ids`); `award_points` refuses an unpaid share; `create_payment_request` surfaces the fronter's missing payee as `fronter_paypal_missing`; ids, amounts and currencies always come from the database |
| Client/server error contract | Done | Every failure is flat `{code, message}`; `lib/api.ts` needs no adapter |
| Expo screens: home, group, bill, leaderboard, my shares | Done | `app/groups/[id]/bill.tsx` drives the whole flow and opens checkout with `expo-web-browser` in the system browser; `app/(tabs)/me/shares.tsx` pays a share and reports Globie earned |
| Native-feeling client shell | Done | `app/(tabs)/_layout.tsx` mounts a custom bottom bar (`components/ui/tab-bar.tsx`) for Home / Shares / Activity; the web app fills the browser with no phone bezel, holding one centred column (`maxContentWidth`, 960 on web / 720 on device) with the bar's destinations capped to that column; Reanimated drives the tab capsule, screen transitions and the celebrate burst, `expo-haptics` fires on selection and success. Verified in a browser at 1400×900 and 390×844: no bezel or fake status bar, pushed screens centre their stack header over the column, the agreement amount sits on its own line so it no longer ellipsises on a narrow phone, tab state flips `aria-selected`, the capsule springs `opacity 0→1`, and 27 icon glyphs stay out of the accessibility tree |
| Baby Kae Na, the Globie Keeper mascot | Done | `components/ui/mascot.tsx` draws her as animated SVG (blink, bob, sway, bloom shine, halo) with three crops — `full` for the sign-in mark, `face` for hero cards and empty states, `badge` for ≤48 px avatars in chat, timeline, activity and toasts; `MascotToastProvider` raises her from the top of the screen for every event (table opened, joined, agreement set/accepted, receipt read, split proposed, share confirmed, bill locked, requests sent, paid/settled with the Globie chip), `SuccessPulse` (124 px, halo, check badge) celebrates settles, and launcher art is regenerated from the same SVG into `icon.png`, `splash-icon.png`, `favicon.png` and the Android adaptive layers |
| pg-boss workers: reminder sweep and outbox delivery | Done | The sweep queued a `late-72h` reminder for an overdue share and wrote a `reminder.sent` ledger event; the outbox delivered it in-app and by SMTP (real message accepted by a local sink), then marked both rows `sent` with `notification_events` recording the Message-ID |
| Reminder cadence and quiet hours | Done | A share 4 days past due resolves to the `late-72h` stage with `final` tone; a member in quiet hours gets in-app now and email queued for exactly 08:00 local; re-running the sweep queues nothing (`reminders.idempotency_key`) |
| Outbox retry | Done | An unconfigured WhatsApp row came back `queued`, `attempts = 1`, `last_error = "whatsapp is not configured"`, retry in 30 s; the delay doubles to a one-hour cap over 5 attempts, then the row is `failed` |
| `db/seed.ts` (§2.14) | Done | `npm --prefix server run seed` rebuilds one demo universe — invite `KHAOSI`, an accepted agreement and a `COLLECTING` bill whose shares are 445.00 paid / 400.00 requested / 355.00 confirmed (1,200.00 THB total) — every line split with `allocate()`; a second run overwrites the same three accounts |
| `postman/` collection | Done | Five folders run in order: health, auth, seeded demo (no credentials), agent tools (challenge → confirmed for `send_reminder` and `award_points`), and the full create flow that needs `VISION_API_KEY` |
| `scripts/deploy.sh` and `scripts/backup.sh` | Done | Deploy pulls the published images, migrates and health-checks `http://127.0.0.1:8080/api/health` without seeding; backup writes a timestamped custom-format `pg_dump` plus an uploads tarball |
| Reverse proxy and images | Done | `deploy/web.conf` and `deploy/proxy/default.conf` serve the Expo export at `/` and forward `/api/*`; `deploy/proxy/https.conf.example` is the TLS block and `nginx -t` accepts the mounted config. `tradex367/globie-keeper-api` and `tradex367/globie-keeper-web` are published to Docker Hub for the Easypanel host |
| Worker heartbeat on `/health` | Done | `GET /health` reports `worker: {ok, enabled, running, lastHeartbeatAt, heartbeatAgeSeconds}` fed by `markWorkerHeartbeat()`, and a sweep older than 15 minutes turns the route into `503 degraded` |
| Globie chat surface | Done | `components/chat/globie-chat.tsx` mounted on the group screen: free text maps to one of the seven tools, "pay the fronter back" routes to `create_payment_request`, a `confirmationRequired` answer parks the token behind `AWAITING YOUR OK` and replays the identical arguments, and `share_id` is resolved through `get_bill_status` with member chips |

Typecheck (`tsc --noEmit`) and production build (`tsc`) are clean.

### 11.2 Known gaps in the demo path

- **Receipt AI is inactive without `VISION_API_KEY`.** `lib/receipt.ts` refuses to invent data: the bill returns to `UPLOADED` with the warning *"Receipt AI could not read this upload"*, and the UI shows `bill.warnings` so the demo degrades to manual entry instead of lying.
- **The buyer side has accounts but no finished run.** Orders are created for real (§11.1), and approving is what turns `PAYER_ACTION_REQUIRED` into a capture. Two sandbox personal accounts now exist in the developer dashboard — `globie.fronter@personal.example.com` (THB 0, the payee) and `globie.member@personal.example.com` (THB 1,000, the payer); credentials are in the dashboard, not in this repo. On the deployed `keeper-db` the Volunteer Dinner fronter already carries `members.paypal_email = globie.fronter@personal.example.com`, so new reimbursement orders resolve a payee instead of returning `409 fronter_paypal_missing`. `PAYPAL_WEBHOOK_ID` is still blank, so the webhook stays unsigned in development.
- **Webhooks are unsigned in development.** Without `PAYPAL_WEBHOOK_ID` the receiver logs a warning and processes the event; production refuses with `503 paypal_webhook_unconfigured`.
- **Only in-app reminders are on by default.** `NOTIFY_EMAIL`, `NOTIFY_PUSH` and `NOTIFY_WHATSAPP` stay off until `SMTP_URL`, an Expo token or WhatsApp credentials exist, so every member always gets the in-app nudge and nothing fails on a missing provider.
- **The workers run inside the API process.** `JOBS_ENABLED=false` turns them off; `docker compose` still starts a single service, not a separate `worker` one.
- **Sign-in has not been exercised end to end.** §2.17 ships Log in with PayPal (verified email plus payer ID) and refuses email-only sign-in for linked accounts; the consent round trip needs a sandbox personal account, which now exists, so only the run itself is missing. The email form is what actually signs people in today.
- **`notification_events` has no `group_id`**, so the delivery audit is queryable by member and channel but not per group.

### 11.3 Next up, in order

1. `db/seed.ts`, `postman/` collection, `scripts/deploy.sh`, `scripts/backup.sh`, and the reverse-proxy block. — **done**, see §11.1.
2. Wire the client chat surface to `POST /api/agent/message` so the demo drives Globie by conversation. — **done**: `components/chat/globie-chat.tsx`, mounted on `app/groups/[id]/index.tsx`.
3. Log in with PayPal (§2.17): `005_paypal_login.sql`, the identity helpers in `server/src/lib/paypal.ts`, `/auth/paypal/{start,callback,handoff}`, `signInWithPayPal` with the web/native branch, the branded button on `components/sign-in.tsx`, and `app/paypal/login.tsx` behind the `Gate` change. — **done**: server and client both typecheck, lint and export; the preview fixtures now walk the flow end to end in a browser; README, `.env.example` and the Postman `01b` folder document the setup and cover `start` plus the `handoff` reject path. The sandbox consent round trip is the only part left, and it is credential-gated (§11.2).
4. No-custody reimbursement (§2.9 / §2.18): `purchase_units[].payee` on every order, `009_payee_direct.sql`, the `409 fronter_paypal_missing` gate, `PATCH /me {paypalEmail}`, and Settings → *Getting paid*. — **done**: Payouts v1 and the `create_payout` tool are deleted, so the capture is the settlement and the platform never holds funds; typecheck, lint and the server suite are green. A live capture into a third-party payee is the one sandbox check left (§11.2).

Nothing else is queued. What is left is credential-gated, not code: `VISION_API_KEY` for the receipt path and `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_WEBHOOK_ID` for a live sandbox capture (§11.2). Log in with PayPal adds nothing new to that list beyond registering the dashboard **Return URL** — it reuses the same client ID and secret.

### 11.4 Rebuild check

```bash
cd server && npm run migrate && npm run typecheck && npm run build && npm run dev
npx expo start          # web + native from one codebase
```
