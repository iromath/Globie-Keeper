-- Globie Keeper — members reimburse the fronter directly (DEV_PLAN §2.9).
--
-- The fronter settles the merchant bill however they like (cash, card,
-- PromptPay — anything outside PayPal). Members then reimburse them through a
-- PayPal order that names the fronter as `purchase_units[].payee`, so the
-- capture settles into the fronter's own account. The platform never holds the
-- money, which retires the payout batch that used to send it back from ours.

-- PayPal can address a payee by merchant id as well as by email. Only the email
-- is used today; the column exists so switching is a data change, not a rewrite.
alter table members add column if not exists paypal_merchant_id text;

-- `payouts` only tracked batches sent from the platform account.
alter table tips drop column if exists payout_id;
drop table if exists payouts;
