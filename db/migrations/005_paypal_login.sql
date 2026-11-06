-- Globie Keeper — "Log in with PayPal" identity (DEV_PLAN §2.17).
-- Signing in proves ownership of an email address; it never moves money, so
-- none of this touches the Orders or webhook tables.

alter table users
  add column if not exists paypal_email text,
  add column if not exists paypal_verified boolean not null default false,
  add column if not exists paypal_linked_at timestamptz;

-- One PayPal account owns at most one Globie account. Partial so the many rows
-- that will never sign in with PayPal stay out of the index.
create unique index if not exists users_paypal_payer_id_unique
  on users (paypal_payer_id) where paypal_payer_id is not null;

-- Authorization requests in flight. Only the hash is stored, so a leaked table
-- cannot be replayed against PayPal. `return_to` remembers which surface asked
-- so the callback knows whether to answer with the web page or the deep link.
create table if not exists paypal_login_states (
  state_hash text primary key,
  return_to text not null default 'web' check (return_to in ('web', 'native')),
  created_at timestamptz not null default now()
);

create index if not exists paypal_login_states_created_idx
  on paypal_login_states (created_at);

-- The browser comes back with a 60-second code instead of a session token, so
-- tokens never land in browser history, Referer headers or access logs.
create table if not exists auth_handoffs (
  code_hash text primary key,
  user_id uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists auth_handoffs_expires_idx on auth_handoffs (expires_at);
