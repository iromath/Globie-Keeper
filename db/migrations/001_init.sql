-- Globie Keeper — initial schema
-- Money is stored as BIGINT minor units. No floating point anywhere.

create extension if not exists pgcrypto;

do $$
begin
  if not exists (select 1 from pg_available_extensions where name = 'timescaledb') then
    raise notice 'timescaledb is not available; hypertables will be skipped (plain Postgres fallback)';
  else
    create extension if not exists timescaledb;
  end if;
end
$$;

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  display_name text not null,
  paypal_payer_id text,
  created_at timestamptz not null default now()
);

create unique index if not exists users_email_unique on users (lower(email));

create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index if not exists sessions_user_idx on sessions (user_id);

-- ---------------------------------------------------------------------------
-- Groups and agreements
-- ---------------------------------------------------------------------------

create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  default_currency char(3) not null default 'THB',
  owner_id uuid not null references users (id),
  invite_token text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'fronter', 'member')),
  paypal_email text,
  status text not null default 'active' check (status in ('invited', 'active', 'removed')),
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);

create index if not exists members_group_idx on members (group_id);

create table if not exists agreements (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups (id) on delete cascade,
  currency char(3) not null,
  estimated_total bigint not null default 0,
  deadline timestamptz,
  terms_snapshot jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('draft', 'pending', 'accepted', 'cancelled', 'settled')),
  created_by uuid not null references members (id),
  created_at timestamptz not null default now()
);

create index if not exists agreements_group_idx on agreements (group_id, created_at desc);

create table if not exists agreement_acceptances (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  accepted_at timestamptz not null default now(),
  consent_version text not null default 'v1',
  ip_hash text,
  unique (agreement_id, member_id)
);

-- ---------------------------------------------------------------------------
-- Bills
-- ---------------------------------------------------------------------------

create table if not exists bills (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements (id) on delete cascade,
  merchant text,
  currency char(3) not null,
  subtotal bigint not null default 0,
  tax bigint not null default 0,
  service_charge bigint not null default 0,
  tip bigint not null default 0,
  discount bigint not null default 0,
  total bigint not null default 0,
  status text not null default 'UPLOADED'
    check (status in ('UPLOADED', 'PARSING', 'PARSED', 'ALLOCATED', 'CONFIRMED',
                      'FINALIZED', 'COLLECTING', 'SETTLED', 'CANCELLED')),
  version int not null default 1,
  created_at timestamptz not null default now()
);

create index if not exists bills_agreement_idx on bills (agreement_id, created_at desc);

create table if not exists bill_media (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  kind text not null check (kind in ('photo', 'video')),
  storage_key text not null,
  mime_type text,
  duration_s numeric(8, 2),
  frames_extracted int not null default 0,
  status text not null default 'stored'
    check (status in ('stored', 'extracting', 'extracted', 'failed')),
  created_at timestamptz not null default now()
);

create index if not exists bill_media_bill_idx on bill_media (bill_id);

create table if not exists bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  name text not null,
  qty numeric(10, 2) not null default 1,
  unit_price bigint not null default 0,
  line_total bigint not null default 0,
  confidence numeric(4, 3) not null default 1,
  source_frame int,
  created_at timestamptz not null default now()
);

create index if not exists bill_items_bill_idx on bill_items (bill_id);

create table if not exists allocations (
  id uuid primary key default gen_random_uuid(),
  bill_item_id uuid not null references bill_items (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  qty numeric(10, 2) not null default 1,
  amount bigint not null default 0,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'disputed')),
  created_at timestamptz not null default now(),
  unique (bill_item_id, member_id)
);

create index if not exists allocations_member_idx on allocations (member_id);

create table if not exists item_confirmations (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references allocations (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  status text not null check (status in ('confirmed', 'disputed')),
  confirmed_amount bigint,
  note text,
  created_at timestamptz not null default now()
);

create table if not exists disputes (
  id uuid primary key default gen_random_uuid(),
  allocation_id uuid not null references allocations (id) on delete cascade,
  opened_by uuid not null references members (id),
  reason text not null,
  status text not null default 'open' check (status in ('open', 'resolved', 'withdrawn')),
  resolution text,
  resolved_by uuid references members (id),
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Money movement
-- ---------------------------------------------------------------------------

create table if not exists shares (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references bills (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  amount bigint not null,
  currency char(3) not null,
  status text not null default 'proposed'
    check (status in ('proposed', 'confirmed', 'requested', 'paid', 'settled',
                      'disputed', 'failed', 'refunded')),
  paypal_order_id text,
  paypal_capture_id text,
  due_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique (bill_id, member_id)
);

create index if not exists shares_member_idx on shares (member_id, status);

create table if not exists payments (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references shares (id) on delete cascade,
  provider text not null default 'paypal',
  provider_ref text,
  amount bigint not null,
  currency char(3) not null,
  status text not null default 'pending',
  raw_payload jsonb,
  created_at timestamptz not null default now()
);

create index if not exists payments_share_idx on payments (share_id);

create table if not exists payouts (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements (id) on delete cascade,
  member_id uuid not null references members (id),
  provider_ref text,
  amount bigint not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists reminders (
  id uuid primary key default gen_random_uuid(),
  share_id uuid not null references shares (id) on delete cascade,
  scheduled_for timestamptz not null,
  sent_at timestamptz,
  channel text not null check (channel in ('push', 'email', 'whatsapp', 'in_app')),
  template text not null,
  message text,
  idempotency_key text not null unique,
  status text not null default 'scheduled'
    check (status in ('scheduled', 'sent', 'failed', 'cancelled'))
);

create index if not exists reminders_due_idx on reminders (scheduled_for) where status = 'scheduled';

create table if not exists notification_outbox (
  id uuid primary key default gen_random_uuid(),
  channel text not null,
  recipient text not null,
  template text not null,
  payload jsonb not null default '{}'::jsonb,
  idempotency_key text not null unique,
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  status text not null default 'queued'
    check (status in ('queued', 'sending', 'sent', 'failed', 'dropped')),
  created_at timestamptz not null default now()
);

create index if not exists notification_outbox_due_idx
  on notification_outbox (next_attempt_at) where status = 'queued';

-- Uniqueness that TimescaleDB cannot express on a hypertable (a unique index on
-- a hypertable must include the partitioning column) lives in plain tables.

create table if not exists points_awards (
  id uuid primary key default gen_random_uuid(),
  agreement_id uuid not null references agreements (id) on delete cascade,
  member_id uuid not null references members (id) on delete cascade,
  reason text not null,
  delta int not null,
  created_at timestamptz not null default now(),
  unique (agreement_id, member_id, reason)
);

create table if not exists webhook_receipts (
  provider text not null,
  provider_event_id text not null,
  received_at timestamptz not null default now(),
  primary key (provider, provider_event_id)
);

-- ---------------------------------------------------------------------------
-- Append-only event history (hypertables)
-- ---------------------------------------------------------------------------

create table if not exists ledger_events (
  time timestamptz not null default now(),
  event_id uuid not null default gen_random_uuid(),
  group_id uuid,
  agreement_id uuid,
  share_id uuid,
  member_id uuid,
  event_type text not null,
  amount_minor bigint not null default 0,
  currency char(3),
  metadata jsonb not null default '{}'::jsonb,
  primary key (time, event_id)
);

create table if not exists points_events (
  time timestamptz not null default now(),
  event_id uuid not null default gen_random_uuid(),
  group_id uuid not null,
  member_id uuid not null,
  delta int not null,
  reason text not null,
  agreement_id uuid,
  share_id uuid,
  primary key (time, event_id)
);

create table if not exists notification_events (
  time timestamptz not null default now(),
  event_id uuid not null default gen_random_uuid(),
  channel text not null,
  template text not null,
  member_id uuid,
  status text not null,
  provider_ref text,
  primary key (time, event_id)
);

create table if not exists agent_events (
  time timestamptz not null default now(),
  event_id uuid not null default gen_random_uuid(),
  group_id uuid,
  actor text not null,
  tool text not null,
  input jsonb not null default '{}'::jsonb,
  output jsonb not null default '{}'::jsonb,
  latency_ms int,
  primary key (time, event_id)
);

create table if not exists webhook_events (
  time timestamptz not null default now(),
  event_id uuid not null default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  verified boolean not null default false,
  primary key (time, event_id)
);

-- Convert the append-only tables into hypertables when TimescaleDB is present.
do $$
declare
  target text;
begin
  if exists (select 1 from pg_extension where extname = 'timescaledb') then
    foreach target in array array['ledger_events', 'points_events', 'notification_events',
                                   'agent_events', 'webhook_events']
    loop
      if not exists (
        select 1 from timescaledb_information.hypertables where hypertable_name = target
      ) then
        perform create_hypertable(target, 'time', chunk_time_interval => interval '1 day');
        begin
          execute format('alter table %I set (timescaledb.compress)', target);
          perform add_compression_policy(target, interval '7 days');
        exception when others then
          raise notice 'compression policy skipped for %: %', target, sqlerrm;
        end;
        begin
          perform add_retention_policy(target, interval '90 days');
        exception when others then
          raise notice 'retention policy skipped for %: %', target, sqlerrm;
        end;
      end if;
    end loop;
  end if;
end
$$;

-- Rolling leaderboard input: how fast each member repays, bucketed per day.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'timescaledb') then
    if not exists (
      select 1 from timescaledb_information.continuous_aggregates
      where view_name = 'member_repayment_1d'
    ) then
      execute $cagg$
        create materialized view member_repayment_1d
        with (timescaledb.continuous) as
        select
          time_bucket('1 day', time) as bucket,
          member_id,
          count(*) as shares_paid,
          avg((metadata ->> 'hours_to_pay')::numeric) as avg_hours
        from ledger_events
        where event_type = 'share.paid' and member_id is not null
        group by bucket, member_id
        with no data
      $cagg$;
      begin
        perform add_continuous_aggregate_policy('member_repayment_1d',
          start_offset => interval '90 days',
          end_offset => interval '1 hour',
          schedule_interval => interval '1 hour');
      exception when others then
        raise notice 'continuous aggregate policy skipped: %', sqlerrm;
      end;
    end if;
  end if;
end
$$;

create index if not exists ledger_events_group_time_idx on ledger_events (group_id, time desc);
create index if not exists points_events_group_time_idx on points_events (group_id, time desc);
