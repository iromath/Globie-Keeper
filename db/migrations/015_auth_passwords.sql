-- ---------------------------------------------------------------------------
-- 015 · Email sign-in needs a password
--
-- Until now `POST /api/auth/session` was passwordless: any address typed into
-- the form minted a session for that account. A password hash closes that hole.
--
-- `password_hash` is nullable on purpose. Rows created before this migration
-- (and PayPal-only rows) have no password; the sign-in route handles both:
--
--   PayPal-linked row, no password   -> `use_paypal_login`
--   legacy row, no password          -> claims a password once, then verifies
--
-- The format is `scrypt$N$r$p$salt$hash` (see server/src/lib/password.ts), so
-- the work factor can be raised later without a schema change.
-- ---------------------------------------------------------------------------

alter table users add column if not exists password_hash text;
alter table users add column if not exists password_updated_at timestamptz;
