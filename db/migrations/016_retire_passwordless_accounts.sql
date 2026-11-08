-- 016 · Retire the accounts that never had a password
--
-- 015 makes a password the only email credential, but every row created before
-- it has none. Letting the first visitor who knows an address set that password
-- would keep the original hole open for every existing account, so instead the
-- row is retired:
--
--   * `password_hash` becomes a value `verifyPassword` can never match, which
--     also disables the one-time claim path in POST /auth/session;
--   * the address is rewritten to `retired+<id>@invalid`, so it can no longer be
--     used to sign in and the real address is free for a fresh sign-up. The new
--     account starts empty — groups still point at the retired row, so this is a
--     reset, not a rename;
--   * PayPal-linked rows are left alone: PayPal is already the credential.
--
-- Every session predates credential checks, so they are all revoked too.
update users
   set email = 'retired+' || id || '@invalid',
       password_hash = 'retired',
       password_updated_at = now()
 where password_hash is null
   and paypal_payer_id is null;

delete from sessions;
