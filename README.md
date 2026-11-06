# Globie Keeper

Group expenses for people who actually trust each other — until the bill lands.

Globie Keeper is an Expo app with a Fastify + PostgreSQL (TimescaleDB) backend, built for the
PayPal AI Hackathon. One person fronts the table, photographs the receipt, Globie reads it and
splits it, everyone confirms their own lines, and PayPal moves the money. The fronter earns
**Globie points** for paying first and for paying fast.

Full product and engineering spec: [DEV_PLAN.md](DEV_PLAN.md).

## What it does

- **Sign in with PayPal.** Identity-only OAuth: the account proves itself once, the verified PayPal
  email becomes the reimbursement address (so people can pay you back), and no tokens are kept.
- **Agreement first.** A group accepts a lightweight agreement before any money moves, so the
  split rules are never in dispute later.
- **Receipt → allocation.** A photo or video is uploaded, parsed, and split with largest-remainder
  arithmetic in integer minor units — `sum(shares) == bill.total`, no lost satang.
- **Per-member confirmation.** Members confirm only their own lines; the bill flips to `CONFIRMED`
  when no proposed lines remain.
- **PayPal Orders v2.** One order per share, captured server-side, reconciled against signed
  webhooks, deduped, and audited.
- **Globie.** An agent surface that answers free text with database-backed tools; destructive tools
  require a short-lived HMAC confirmation token bound to the exact arguments.
- **Reminders.** pg-boss sweeps queue in-app nudges (email/push/WhatsApp when credentials exist),
  respecting quiet hours and per-stage idempotency.

## Stack

| Layer | Choice |
|---|---|
| Client | Expo SDK 58, React Native 0.88, React 19, Expo Router, React Query, Reanimated 4, `@react-native-vector-icons/ionicons`, `expo-haptics` |
| API | Fastify 5 on Node 22, `@fastify/multipart`, pg-boss 12 |
| Data | PostgreSQL 16 + TimescaleDB 2.31 (plain Postgres falls back cleanly) |
| Payments | PayPal Orders v2 REST + webhook signature verification |
| Delivery | Docker Compose: `db`, `api`, `web` (nginx), `proxy` |

## Quick start

Requirements: Node 22+, Docker (for the database).

```bash
npm install
npm --prefix server install

cp .env.example .env          # then fill in what you need
docker compose up -d db       # TimescaleDB on 127.0.0.1:55432

npm --prefix server run migrate
npm --prefix server run seed  # optional: one demo universe, invite code KHAOSI

npm run api:dev               # Fastify on http://localhost:3001
npm start                     # Expo dev server
```

Health check: `curl http://localhost:3001/api/health`.

The seed is idempotent — running it again rebuilds the same three accounts (an accepted
agreement and a `COLLECTING` 1,200.00 THB bill split 445.00 paid / 400.00 requested / 355.00
confirmed).

## Environment

Everything lives in `.env` at the repo root; both the Expo client and the API read it. See
[.env.example](.env.example) for the annotated list. The ones that change behaviour:

| Variable | Effect when unset |
|---|---|
| `EXPO_PUBLIC_API_URL` | Falls back to `http://localhost:3001` in dev, the deployed origin in prod |
| `DATABASE_URL` | Defaults to the compose database on port 55432 |
| `AGENT_CONFIRMATION_SECRET` | Required in production; agent tools cannot issue confirmations |
| `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | `POST /api/bills/:id/request-payments` answers `409 paypal_not_configured` |
| `PAYPAL_WEBHOOK_ID` | Dev processes unsigned events with a warning; production refuses with `503` |
| `PAYPAL_LOGIN_RETURN_URL` | Defaults to `${PUBLIC_ORIGIN}/api/auth/paypal/callback`; must match the dashboard exactly |
| `PAYPAL_LOGIN_WEB_RETURN_URL` / `PAYPAL_LOGIN_NATIVE_RETURN_URL` | Default to `${PUBLIC_ORIGIN}/paypal/login` and `globiekeeper://auth/return` |
| `VISION_API_KEY` | Receipt AI is skipped and the bill returns to `UPLOADED` with a warning; defaults target DeepSeek (`deepseek-flash`) |
| `NOTIFY_EMAIL` / `NOTIFY_PUSH` / `NOTIFY_WHATSAPP` | Off by default; in-app reminders always work |

`PAYPAL_RETURN_URL` and `PAYPAL_CANCEL_URL` default to `${PUBLIC_ORIGIN}/paypal/return`, which the
client implements in [app/paypal/return.tsx](app/paypal/return.tsx). Only override them if you front
the app with a different hostname.

`PAYPAL_LOGIN_*` belongs to sign-in rather than payments — see
[Log in with PayPal](#log-in-with-paypal) below.

## Demo path

1. Sign in — **Continue with PayPal**, or type an email if the server has no PayPal credentials.
2. Create a group and open the invite (or join with `KHAOSI` from the seed).
3. Accept the agreement.
4. Open the bill, photograph the receipt, let Globie propose an allocation.
5. Confirm your own lines; the last confirmation finalises shares.
6. `Request payments` creates one PayPal order per share.
7. Tap pay in **My shares** — the system browser opens PayPal, and the return page captures the
   order and reports the Globie points earned.
8. `Bill settled. Everyone is square.`

## Log in with PayPal

Identity only: this proves who a member is, and never touches money. The Orders flow below is a
separate integration sharing the same client ID and secret.

1. In the same sandbox app, enable **Log in with PayPal** and tick `openid`, `profile`, `email`
   under the user-info fields.
2. Register the **Return URL** as `${PUBLIC_ORIGIN}/api/auth/paypal/callback` — it is matched
   literally, so `PAYPAL_LOGIN_RETURN_URL` must equal what the dashboard holds. That route is
   served by the API, so on a local dev machine it is `http://localhost:3001/api/auth/paypal/callback`,
   not the app's own origin.
3. Allow `globiekeeper://auth/return` as a return target if you test the native app.

The browser never sees the secret: `GET /api/auth/paypal/start` 302s to PayPal with a single-use
state (10 minutes), the callback exchanges the code server-side, and the app receives a 60-second
hand-off code instead of a session token. `POST /api/auth/paypal/handoff` spends that code once and
returns the normal bearer session. A PayPal-linked address refuses the email form with
`409 use_paypal_login`, so a typed address cannot inherit a verified account.

Without `PAYPAL_CLIENT_ID` the email form still signs people in; tapping PayPal returns to the
landing page with `?error=paypal_not_configured` and a readable message instead of a dead end.
The client side lives in [lib/paypal-login.ts](lib/paypal-login.ts) and
[app/paypal/login.tsx](app/paypal/login.tsx).

## PayPal sandbox

1. Create an app at <https://developer.paypal.com/dashboard/applications/sandbox>.
2. Set `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`.
3. Point a webhook at `${PUBLIC_ORIGIN}/api/paypal/webhook` with the capture events
   (`PAYMENT.CAPTURE.COMPLETED`, `DENIED`, `DECLINED`, `REFUNDED`, `REVERSED`), then set
   `PAYPAL_WEBHOOK_ID` so signatures are verified.
4. Use sandbox personal accounts to approve the order as the payer.

Without a public origin you can still exercise the loop end to end: the return page captures
server-side, and the webhook handler accepts synthetic payloads in development.

## Layout

```
app/                     Expo Router screens (every file is a route)
  _layout.tsx            root stack, session gate, mascot toast host
  (tabs)/_layout.tsx     bottom tab navigator: Home / Shares / Activity
  (tabs)/index.tsx       groups, balances, create/join
  (tabs)/me/shares.tsx   outstanding shares + pay
  (tabs)/me/activity.tsx recent activity feed
  join.tsx               invite redemption
  groups/[id]/index.tsx  timeline + Globie chat
  groups/[id]/bill.tsx   capture, allocation, confirmation
  groups/[id]/leaderboard.tsx
  paypal/return.tsx      PayPal return/cancel landing
  paypal/login.tsx       Log in with PayPal hand-off landing (web)
components/              chat, groups, ledger, ui
lib/                     API client, session, money, queries, types, PayPal sign-in
server/src/routes/       auth, groups, agreements, bills, shares, me, paypal, agent, health
server/src/jobs/         pg-boss workers: reminders, outbox, sweeps
server/src/lib/          money, settlement, paypal, receipt, notify, ids, agent tools
db/migrations/           SQL migrations (Timescale hypertables + rollups)
db/seed.ts               demo universe
deploy/                  nginx web + proxy configs
postman/                 runnable collection, including the agent challenge flow
scripts/                 deploy.sh, backup.sh, preview.mjs
```

## Caveats

- This is a hackathon build, not a custody product. It does not hold funds: PayPal moves money
  directly between members.
- Receipt extraction needs a vision provider; without one the app degrades to manual entry instead
  of inventing line items.
- Rate limiting, the dispute flow, and client-side push registration are not implemented yet; see
  §11.2 of [DEV_PLAN.md](DEV_PLAN.md).

## Scripts

```bash
npm run lint        # expo lint
npm run typecheck   # tsc --noEmit
npm run build:web   # expo export -p web -> web-dist
npm run preview     # serve web-dist + in-memory API on :8080 (no Postgres needed)
npm run api:dev     # Fastify with tsx watch
npm run api:build   # compile the server
```

Server-side: `npm --prefix server run migrate | seed | typecheck | build | start`.

## License

MIT — see [LICENSE](LICENSE).
