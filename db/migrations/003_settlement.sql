-- Globie Keeper — settlement plumbing for PayPal webhooks.
-- A webhook carries an order id, so the share must be findable by it, and the
-- approval link is persisted so a member can resume checkout from "My shares".

alter table shares
  add column if not exists paypal_approve_url text;

create index if not exists shares_paypal_order_idx
  on shares (paypal_order_id) where paypal_order_id is not null;

-- One payment row per PayPal order. NULL refs stay distinct, so the constraint
-- only guards rows the webhook or request-payments actually wrote.
create unique index if not exists payments_provider_ref_unique
  on payments (provider, provider_ref);
