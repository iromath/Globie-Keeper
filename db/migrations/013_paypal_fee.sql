-- Optional fee coverage (DEV_PLAN §2.20).
-- PayPal always deducts its cut from the payee, so a fronter repaid the exact
-- share silently loses it. A member opt-in grosses the request up: the payer is
-- asked for net + estimated fee and the fronter receives the net.
--
-- The net stays canonical. `fee_minor` / `gross_minor` are a snapshot of how
-- the order was requested, never a change to `amount` / `bills.total`.
--
-- Ships off by default: no seed, migration or backfill may set it true. Live
-- mode additionally refuses it server-side until PAYPAL_FEE_COVER_LIVE_ALLOWED
-- is set (the payer-side surcharge is prohibited by the US and TH agreements).
alter table members
  add column if not exists cover_paypal_fee boolean not null default false;

alter table shares
  add column if not exists fee_minor bigint not null default 0;

-- Nullable: null means "no order was created with a grossed-up amount yet".
alter table shares
  add column if not exists gross_minor bigint;

alter table tips
  add column if not exists fee_minor bigint not null default 0;

alter table tips
  add column if not exists gross_minor bigint;

alter table payments
  add column if not exists fee_minor bigint not null default 0;
