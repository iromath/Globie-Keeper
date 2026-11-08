-- Globie Keeper — the Globie Fund (DEV_PLAN §2.21).
-- A donation is deliberately group-free: it belongs to a person, not a bill.
-- Two rails share one row shape: a PayPal capture into the fund account, or a
-- redemption of Globie points at 1000 points = US$1 (in one-cent steps).
--
-- `points_awards.agreement_id` is NOT NULL in 001_init because every award so
-- far came from a settled share or tip. A redemption has no agreement, so the
-- column has to become nullable. Postgres treats NULLs as distinct in the
-- existing `unique (agreement_id, member_id, reason)` constraint, which means
-- a member may redeem more than once while awards keep their one-per-reason
-- guarantee. /me/points and the group leaderboard both sum `delta` without
-- joining agreements, so they keep working unchanged.

alter table points_awards alter column agreement_id drop not null;

create table if not exists donations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users (id) on delete cascade,
  method text not null check (method in ('paypal', 'points')),
  -- What the fund receives. For the points rail this is the USD equivalent of
  -- the points spent, so one column answers "how much was given?" on both rails.
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null,
  -- Points spent on the points rail; 0 on the PayPal rail.
  points_spent int not null default 0 check (points_spent >= 0),
  -- Sanctuary catalogue identity, copied at donate time so history survives a
  -- catalogue change.
  species_id text not null,
  species_name text,
  quantity int not null default 1 check (quantity between 1 and 1000),
  status text not null default 'proposed'
    check (status in ('proposed', 'requested', 'paid', 'refunded', 'failed')),
  paypal_order_id text,
  paypal_capture_id text,
  paypal_approve_url text,
  -- Amount PayPal actually charged; equals amount_minor on the points rail.
  gross_minor bigint,
  -- Adoption written to mcp.globie.earth. 'none' on the points rail until the
  -- debit commits, then 'pending' → 'adopted'. A failed adoption never unwinds
  -- the gift; the retry route and the outbox sweeper pick it up.
  mcp_status text not null default 'none'
    check (mcp_status in ('none', 'pending', 'adopted', 'failed')),
  mcp_deed_no text,
  mcp_error text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists donations_user_idx
  on donations (user_id, created_at desc);

-- The webhook resolves a donation by the order it created or the capture it
-- was refunded from, so both references must be unique when present.
create unique index if not exists donations_order_idx
  on donations (paypal_order_id) where paypal_order_id is not null;

create unique index if not exists donations_capture_idx
  on donations (paypal_capture_id) where paypal_capture_id is not null;

-- Adoptions waiting on the sanctuary, oldest first.
create index if not exists donations_mcp_pending_idx
  on donations (created_at) where mcp_status = 'pending';
