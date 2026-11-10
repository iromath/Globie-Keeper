-- ---------------------------------------------------------------------------
-- 018 · The group votes how to divide, and sets a late-payment fee
--
-- `split_mode` on the agreement is the vote's current outcome. It is the
-- default for every bill in the agreement; the fronter can still override it
-- per bill. Only two options are ever voted on:
--
--   item   by line item — each member pays for what they had
--   equal  evenly — the total is shared across active members
--
-- A tie falls back to `item` so nobody has to break it.
--
-- Late fee is a monthly rate in basis points (300 = 3% per month) charged on
-- top of an overdue share, capped as a share of that share. Zero means there
-- is no late fee at all and nobody can be charged extra for paying late.
-- ---------------------------------------------------------------------------

alter table agreements
  add column if not exists split_mode text not null default 'item';
alter table agreements
  add column if not exists late_fee_bps integer not null default 0;
alter table agreements
  add column if not exists late_fee_cap_bps integer;

alter table agreements drop constraint if exists agreements_split_mode_check;
alter table agreements add constraint agreements_split_mode_check
  check (split_mode in ('item', 'equal'));

alter table agreements drop constraint if exists agreements_late_fee_bps_check;
alter table agreements add constraint agreements_late_fee_bps_check
  check (late_fee_bps between 0 and 10000);

alter table agreements drop constraint if exists agreements_late_fee_cap_bps_check;
alter table agreements add constraint agreements_late_fee_cap_bps_check
  check (late_fee_cap_bps is null or late_fee_cap_bps between 0 and 10000);

-- One row per member per agreement: the vote is agreement-wide, so it applies
-- to every bill that agreement ever produces. A member who changes their mind
-- overwrites their row.
create table if not exists agreement_votes (
  agreement_id uuid not null references agreements (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  split_mode text not null check (split_mode in ('item', 'equal')),
  created_at timestamptz not null default now(),
  primary key (agreement_id, member_id)
);

-- Snapshot of the fee actually charged on this share when the fronter asked
-- for the money. Kept beside `fee_minor` so a later terms change cannot
-- rewrite what the payer was quoted.
alter table shares add column if not exists late_fee_minor bigint not null default 0;
