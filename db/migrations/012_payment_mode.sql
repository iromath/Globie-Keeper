-- Two ways for a fronter to be reimbursed, chosen per member:
--   payee_direct — Orders v2 names the fronter as payee and the payer captures
--                  a checkout. Needs a PayPal Business account.
--   paypal_me    — a PayPal.Me link asks for the exact share. Works with a
--                  Personal account, but PayPal never tells us the payment
--                  happened, so the payer confirms it in the app.
alter table members
  add column if not exists paypal_mode text not null default 'payee_direct';

alter table members
  add column if not exists paypal_me_handle text;

-- Snapshot on the share, so every screen can show how it was requested even
-- after the fronter switches modes.
alter table shares
  add column if not exists payment_mode text;

do $$
begin
  alter table members
    add constraint members_paypal_mode_check
    check (paypal_mode in ('payee_direct', 'paypal_me'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table shares
    add constraint shares_payment_mode_check
    check (payment_mode is null or payment_mode in ('payee_direct', 'paypal_me'));
exception when duplicate_object then null;
end $$;
