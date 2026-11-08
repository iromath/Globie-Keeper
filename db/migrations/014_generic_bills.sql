-- ---------------------------------------------------------------------------
-- 014 · Bills are no longer restaurant receipts
--
-- A bill is any shared cost: a meal, groceries, rent, a utility invoice, a
-- trip, a gift or a subscription. `title` names it, `kind` classifies it, and
-- `split_mode` says how the total becomes shares.
--
--   item     one allocation per bill_item (the original receipt flow)
--   equal    the total is split evenly across the group's active members
--   custom   the fronter types each member's amount in minor units
--   percent  the fronter gives each member a percentage weight
--
-- `bill_split_entries` carries the weights for `custom` and `percent`. `equal`
-- needs no rows: it derives the weights from the member list at lock time.
-- ---------------------------------------------------------------------------

alter table bills add column if not exists title text;
alter table bills add column if not exists kind text not null default 'other';
alter table bills add column if not exists split_mode text not null default 'item';

alter table bills drop constraint if exists bills_kind_check;
alter table bills add constraint bills_kind_check
  check (kind in ('meal', 'groceries', 'rent', 'utilities', 'travel',
                  'gift', 'subscription', 'other'));

alter table bills drop constraint if exists bills_split_mode_check;
alter table bills add constraint bills_split_mode_check
  check (split_mode in ('item', 'equal', 'custom', 'percent'));

create table if not exists bill_split_entries (
  bill_id uuid not null references bills (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  -- `custom`: the member's share in minor units.
  amount bigint,
  -- `percent`: the member's weight, 0..100.
  weight numeric(8, 4),
  created_at timestamptz not null default now(),
  primary key (bill_id, member_id)
);

create index if not exists bill_split_entries_bill_idx
  on bill_split_entries (bill_id);
