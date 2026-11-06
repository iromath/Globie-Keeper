-- Globie Keeper — "Give a tip" for the fronter (DEV_PLAN §2.18).
-- A tip cannot live in `shares`: that table is unique per (bill_id, member_id)
-- and it is the reimbursement being tracked for settlement. It cannot live in
-- `payments` either, because `payments.share_id` is NOT NULL. So a tip is its
-- own money row that the PayPal webhook can resolve; it settles straight into
-- the recipient's account, exactly like a share.

create table if not exists tips (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  agreement_id uuid not null references agreements (id) on delete cascade,
  -- Who gave the tip and who receives it; both are members of the same group.
  from_member_id uuid not null references members (id) on delete cascade,
  to_member_id uuid not null references members (id),
  amount bigint not null check (amount > 0),
  currency char(3) not null,
  message text,
  status text not null default 'proposed'
    check (status in ('proposed', 'requested', 'paid', 'refunded', 'failed')),
  paypal_order_id text,
  paypal_capture_id text,
  paypal_approve_url text,
  -- Batch that carried this tip to the fronter; NULL until it is paid out.
  payout_id uuid references payouts (id),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  -- One tip per member per bill: the UI offers a single tip, and a retry
  -- reuses the row instead of stacking a second charge.
  unique (bill_id, from_member_id)
);

create index if not exists tips_bill_idx on tips (bill_id, created_at desc);
create index if not exists tips_to_member_idx on tips (to_member_id, status);

-- The webhook resolves a tip by the order it created or the capture it was
-- refunded from, so both references need to be unique when present.
create unique index if not exists tips_order_idx
  on tips (paypal_order_id) where paypal_order_id is not null;

create unique index if not exists tips_capture_idx
  on tips (paypal_capture_id) where paypal_capture_id is not null;
