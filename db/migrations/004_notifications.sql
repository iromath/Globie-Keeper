-- Globie Keeper — notification delivery (DEV_PLAN §2.13).
-- A reminder needs to know where to reach a member and when that member is awake.

alter table users
  add column if not exists push_token text,
  add column if not exists timezone text not null default 'UTC',
  add column if not exists whatsapp_number text;

-- Expo tokens die when an app is uninstalled; the worker nulls them out so a
-- dead token never blocks delivery.
create index if not exists users_push_token_idx
  on users (push_token) where push_token is not null;

-- Per-member, per-channel consent. A missing row means opted in, so the table
-- only grows when somebody actually opts out.
create table if not exists notification_preferences (
  member_id uuid not null references members (id) on delete cascade,
  channel text not null check (channel in ('in_app', 'push', 'email', 'whatsapp')),
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  primary key (member_id, channel)
);

-- Outbox rows are now addressed to a member and a group, and remember the last
-- provider error so exponential backoff has something to report.
alter table notification_outbox
  add column if not exists member_id uuid references members (id) on delete set null,
  add column if not exists group_id uuid references groups (id) on delete set null,
  add column if not exists last_error text;

create index if not exists notification_outbox_member_idx
  on notification_outbox (member_id);
