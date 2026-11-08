# Devpost submission — Globie Keeper

Target draft: https://devpost.com/submit-to/31302-paypal-ai-hackathon/manage/submissions/1286676/project-overview
Deadline: **Nov 12, 2026 12:00pm PT** (Nov 13, 03:00 ICT).

Everything below is ready to paste into the matching Devpost field. Placeholders that still need a real value are marked `TODO`.

---

## Step 1 — Project overview

**Project name** (60 char limit)

```
Globie Keeper
```

**Elevator pitch** (200 char limit)

```
Split a group bill from a receipt photo, then settle it with PayPal orders that pay the person who fronted the money. No custody, no IOUs.
```

**Thumbnail** — `assets/devpost/01-thumbnail-1440x900-cover.png` (3:2, 1440×900, 530 KB — within the
5 MB limit). Upload it as-is; do not let Devpost crop it.

---

## Step 2 — Project details

### About the project (Markdown)

```markdown
## Inspiration

Every shared meal ends the same way. One person puts their card down, and then spends two weeks
sending gentle reminders to people they like. The apps that promise to fix this usually ask
everyone to join a wallet first, and the money sits inside that wallet until the platform decides
to release it. For a table of friends, both halves of that are wrong: nobody wants a new account
with a balance, and nobody wants a third party holding the cash.

We wanted the boring, honest version. The person who fronts the bill should get paid back
**directly**, by PayPal, into their own account. The app should never hold a cent. The awkward
part — reading the receipt, dividing the satang, chasing the two people who have not paid yet —
is exactly the part software should do.

## What it does

Globie Keeper is a group-expense app with three rules: agree before you spend, confirm only your
own lines, and pay the person who actually paid.

1. **Sign in with PayPal.** Identity only. The verified PayPal email becomes the address other
   members reimburse, and no PayPal tokens are stored on the client.
2. **Accept a lightweight agreement.** The group agrees on the split rules before any money moves,
   so the rules are never in dispute later.
3. **Photograph the receipt.** Globie reads the photo (or a short video), extracts every line item,
   and proposes a per-person allocation.
4. **Confirm your own lines.** Each member confirms only what they ate. The bill finalises when no
   proposed lines remain.
5. **Pay with PayPal.** Whatever the fronter picked in Settings: a PayPal **order** naming them as
   `payee`, or a **PayPal.Me link** with the amount filled in — both settle into their account, not
   ours.
6. **Get a receipt and a score.** A signed webhook closes the loop; the bill flips to `SETTLED` and
   Globie points are awarded for fronting and for paying back quickly.

Globie points reward the behaviour we want: fronting the table earns a flat **15**, and repaying
first in a bill earns **10 / 5 / 3**, capped at 50 points a day.

## How we built it

**Client.** Expo SDK 58 / React Native 0.88 with Expo Router, React 19, React Query, Reanimated 4
and `expo-haptics`. The same codebase runs the native app and the web build that judges can open
in a browser.

**API.** Fastify 5 on Node 22, PostgreSQL 16 with TimescaleDB hypertables for the activity ledger,
and pg-boss for durable background jobs. Every money operation runs inside a transaction that also
writes the ledger event.

**Receipt AI.** The upload endpoint samples frames from a photo or video and sends them to
**DeepSeek `deepseek-flash`**, which returns strict JSON: merchant, currency, line items, tax,
service charge, tip, discount and a per-line confidence. We validate and normalise that JSON before
it touches the database. All money is stored as **integer minor units** (satang, cents), never
floats. Allocation uses **largest-remainder** arithmetic, so `sum(shares) == bill.total` by
construction — no invented and no lost satang. If the vision key is missing, the app degrades to
manual entry instead of hallucinating line items.

**PayPal Orders v2.** Each share becomes one order whose `purchase_units[].payee` is the fronter's
merchant id (falling back to their verified email). The platform's own credentials create and
capture the order, but the money lands in the payee's account — the no-custody claim is enforced by
the order payload, not by a promise in the UI. Captures are reconciled against webhooks whose
signature is verified through PayPal's verification endpoint, and the same settlement function
handles the webhook, the return-page capture and a retry, deduplicated on the capture id. A replayed
webhook cannot pay twice or award points twice.

**PayPal.Me, for the personal account.** Most people splitting a bill have a Personal PayPal account,
which cannot take a merchant-receipt capture. So the fronter can switch mode in Settings → *Getting
paid* and collect through `paypal.me/<handle>/<amount><CUR>` instead. There is no server-side
confirmation for that link — PayPal does not expose its money requests over the API — so the payer
sends the amount, taps **I've paid**, and `POST /api/shares/:id/paid` settles the share through the
same `settleShare` path with the ref `p2p:<share_id>`. The unique index on `(provider,
provider_ref)` still makes a double tap harmless, and order reconciliation skips link shares because
they carry no order id.

**Log in with PayPal.** A single-use, 10-minute state is issued server-side; the callback exchanges
the code, and the app receives a 60-second hand-off code instead of a session token. A
PayPal-linked address refuses the email form, so a typed address cannot inherit a verified account.

**The Globie agent.** Seven database-backed tools: `parse_receipt_media`, `propose_allocation`,
`request_item_confirmation`, `create_payment_request`, `get_bill_status`, `send_reminder` and
`award_points`. The dispatcher authorises every call against the database rather than trusting ids
in the request, and the three tools that move money or message people require a short-lived **HMAC
confirmation token bound to the exact canonicalised arguments** (10-minute TTL). A confirmation for
"remind Ben 400 THB" cannot be replayed for a different amount or member, and every call is written
to an `agent_events` audit table. The agent is intentionally deterministic: the safety property we
care about is authorisation, not improvisation.

**Reminders.** pg-boss sweeps create in-app nudges and dispatch remote channels only when
credentials exist, respecting quiet hours (22:00–08:00), per-stage idempotency and a fallback chain
of in-app → push → email → WhatsApp. A dead Expo push token is cleared and the reminder falls back
to email.

**Delivery.** Docker Compose: `db`, `api`, `web` (nginx) and a reverse proxy. The same compose file
runs locally and on the host behind `keeper.globie.ai`.

## Challenges we ran into

**Money that adds up.** Splitting 1,200.00 THB three ways is not division; it is a rounding policy.
We moved every amount to integer minor units and wrote the allocation as largest-remainder, then
added property-style tests that assert the sum of shares always equals the bill total.

**Exactly-once settlement.** Three paths can settle a share — the PayPal return page, the webhook,
and a retry. They race. We funnelled all three into one transactional `settle` function keyed on the
capture id, with the ledger event and the point award in the same transaction, so the second caller
observes `alreadyPaid` instead of paying twice.

**Routing money without holding it.** The obvious Orders integration collects into the platform's
merchant account, which would quietly turn a splitting app into a custody product. Using
`purchase_units[].payee` was the fix, and it forced us to be strict about which verified PayPal
identity belongs to which member.

**Being honest about delivery channels.** A browser cannot receive Expo push. Rather than show a
toggle that silently does nothing, the settings screen explains, per channel, why it is unavailable
on this build — so judges see the real capability instead of a dead switch.

## Accomplishments that we are proud of

- A complete sandbox loop: sign in → group → receipt → AI extraction → split → confirm → PayPal
  order → capture → webhook → settled, with points and an auditable ledger.
- A no-custody design enforced in the PayPal order payload, not just the marketing copy.
- Receipt extraction that returns typed, confidence-scored JSON and reconciles frames, with a
  graceful manual fallback.
- An agent whose destructive tools cannot fire without a human-confirmed, argument-bound token.
- One codebase shipping to native and web, deployed and reachable at a public URL.

## What we learned

Money is an integer problem before it is a UI problem. Payment integrations fail in the seams —
returns, webhooks, retries — so the settlement path has to be idempotent by design. And "agentic"
does not mean "let the model decide"; the useful, defensible pattern is a small tool surface with
server-side authorisation and an explicit human confirmation for anything irreversible.

## What's next

- Web Push (service worker) so browser users get the same reminders as the native build.
- A dispute flow for lines a member rejects, plus rate limiting on the public API.
- Live PayPal onboarding for fronter merchant ids, instead of the current sandbox mapping.
- Group templates and recurring bills (rent, utilities) on top of the same agreement model.
```

### Built with

```
PayPal Orders v2, Log in with PayPal, PayPal Webhooks, DeepSeek, deepseek-flash, Expo, React Native, Expo Router, React 19, TypeScript, Fastify, PostgreSQL, TimescaleDB, pg-boss, Docker, nginx, React Query, Reanimated
```

### "Try it out" links

| Label | URL |
|---|---|
| Live demo | https://keeper.globie.ai |
| Source code | https://github.com/iromath/Globie-Keeper |
| API health | https://keeperapi.globie.ai/api/health |

### Gallery images

Upload in this order (all live in `assets/devpost/`). The first five are 1440×900 composed stills; the
rest are unretouched screens of the live app.

| # | File | Shows |
|---|---|---|
| 1 | `02-demo-read-the-receipt.png` | Receipt photo → every extracted line with confidence notes |
| 2 | `03-demo-money-moves.png` | Purchase units routed to the fronter's payee, not to Globie |
| 3 | `04-demo-leaderboard.png` | Hero board: 15 Globie to front, +5 to repay, +2 to tip |
| 4 | `05-demo-the-table.png` | Group, invite code and the bill at a glance |
| 5 | `06-app-home-desktop.png` | Home — balances, points, open bills |
| 6 | `07-app-group-desktop.png` | Group "Volunteer Dinner", invite N955J8 |
| 7 | `08-app-bill-desktop.png` | Bill "Openmind Kitchen" — total, confidence notes |
| 8 | `09-app-bill-items-desktop.png` | Who had what, per-line shares |
| 9 | `10-app-hero-board-desktop.png` | Hero board with the three members |
| 10 | `11-app-shares-desktop.png` | My shares and the pay action |
| 11 | `12-app-activity-desktop.png` | Settlement feed and Globie awards |
| 12 | `13-app-settings-desktop.png` | PayPal merchant + honest push state |
| 13 | `14-mobile-home.png` | Mobile 390×844 — home |
| 14 | `15-mobile-group.png` | Mobile — group |
| 15 | `16-mobile-bill.png` | Mobile — bill |

`17-mobile-bill-items.png` and `18-mobile-hero-board.png` are spare mobile shots; use them only if you
drop one of the desktop frames.

### Demonstration video

`https://youtu.be/M0XQjK16DU4` — unlisted YouTube, 59.5 s, 1920×1080, burned-in captions.
Title: "Globie Keeper — AI bill splitting for friend groups (demo)".

---

## Step 3 — Additional info

**Submitter type:** Individual
**Country of residence:** Thailand
**Canada province:** N/A
**Organization:** N/A
**New or existing:** New

**If it existed before, explain what already existed…**

```
N/A — new project. The repository's first commit is dated 2026-11-06, so every part of Globie
Keeper (client, API, database schema, PayPal integration, receipt AI, agent and deployment) was
built during the submission period.
```

**Explain how your project meets the main technology requirement.**

```
PayPal tools used
- PayPal Orders v2 (sandbox): one order per member share. Each order sets
  purchase_units[].payee to the member who fronted the bill (merchant id first, verified PayPal
  email as fallback), so the capture settles directly into that person's account and the platform
  never holds funds. Orders are created and captured server-side.
- PayPal.Me (sandbox): the fronter's second collection mode, for Personal accounts. The server builds
  paypal.me/<handle>/<amount><CUR>, stores it on the share and settles on the payer's "I've paid"
  confirmation through the same settlement function, deduplicated on the p2p:<share_id> ref.
- PayPal Webhooks: PAYMENT.CAPTURE.COMPLETED / DENIED / DECLINED / REFUNDED / REVERSED are
  received at /api/paypal/webhook and verified with PayPal's verify-webhook-signature endpoint
  before anything is written. Settlement is deduplicated on the capture id.
- Log in with PayPal (OpenID Connect, openid/profile/email): identity-only sign-in. The verified
  PayPal email becomes the reimbursement address; no PayPal tokens are stored client-side. The
  callback uses a single-use state and a 60-second hand-off code instead of a bearer token in a
  URL.

AI tool used
- DeepSeek `deepseek-flash` (vision): the receipt endpoint samples frames from an uploaded photo or
  short video and asks DeepSeek for strict JSON — merchant, currency, line items, quantities, line
  totals, tax, service charge, tip, discount and per-line confidence, with all amounts as integers
  in minor units. The response is validated and normalised server-side, then reconciled into a
  draft allocation. If no vision key is configured, the app degrades to manual entry rather than
  inventing items.

How they work together: the AI turns an unstructured receipt into typed amounts; PayPal moves those
amounts directly between members. The app is the coordinator, never the custodian.
```

**Additional sponsor tools:** Postman (a runnable collection covering the API and the agent
confirmation flow ships in `postman/`). Select "None, used other AI tools" if you prefer not to
claim the optional prize.

**Public code repository URL**

```
https://github.com/iromath/Globie-Keeper
```

> **Blocker:** this repository is currently **private**. It must be public before the deadline, with
> the MIT licence visible in the About sidebar.

**Working demo URL**

```
https://keeper.globie.ai
```

**Testing instructions / credentials**

```
Open https://keeper.globie.ai in a desktop or mobile browser.

Sign-in: the demo build accepts an email address (there is no password). Use
globie.member@personal.example.com to enter the seeded demo identity, or any address you control.
The same email returns you to the same account.

Demo data: the account is already in the group "Volunteer Dinner" (3 members) with a THB 254.66
bill from a receipt photo. A second account can join the same table with invite code N955J8.

Walkthrough: open the group → open the bill → review the AI-extracted lines → confirm your own
lines → "Request payments" → open "My shares" → tap pay. The PayPal sandbox checkout opens in the
system browser; approve it with the sandbox buyer account below. The return page captures the order
and reports the Globie points earned.

PayPal sandbox buyer: online-buyer@openmindprojects.net / GlobieSandbox2026!
Note: everything runs against the PayPal sandbox. No real money moves.
```

**PayPal integration experience:** 9

**Why / feedback**

```
The Orders v2 resource is small and predictable, and `purchase_units[].payee` solved our core
design problem: paying the person who fronted the bill without the platform ever holding funds.
Webhook signature verification through the API (rather than hand-rolling certificate checks) was
also a clean win.

The friction was mostly in the seams: matching return URLs literally across web and native, and
testing webhooks locally without a public origin. Better first-party tooling for replaying signed
sandbox webhooks against localhost would have saved us the most time.
```

**Open to follow-up contact:** Yes

---

## Before pressing Submit

- [ ] Make `github.com/iromath/Globie-Keeper` **public**; confirm the MIT licence chip in About
      — still private; the owner said he will flip it himself before Submit
- [x] Upload the 3:2 thumbnail — `assets/devpost/01-thumbnail-1440x900-cover.png`, live at `software_thumbnail_photos/005/802/887`
- [x] Upload the gallery images in the order listed above — 15/15 uploaded (`software_photos/005/802/906…920`)
- [x] Record and upload the demo video — `https://youtu.be/M0XQjK16DU4` (unlisted, 59.5 s)
- [x] Fill the sandbox buyer credentials in Testing instructions — `online-buyer@openmindprojects.net` / `GlobieSandbox2026!` (password reset and re-login verified on 2026-11-08)
- [x] Confirm `https://keeper.globie.ai` and `https://keeperapi.globie.ai/api/health` both answer — 200 / 200 on 2026-11-08
- [ ] Keep the PayPal sandbox app and DeepSeek key valid through **Dec 15, 2026**
