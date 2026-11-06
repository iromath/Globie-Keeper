-- Globie Keeper — outbox claim recovery (DEV_PLAN §2.13).
--
-- `deliverDue()` marks a row 'sending' before it talks to the provider. If the
-- worker dies mid-send the row used to sit in that state forever; the claim
-- timestamp lets the next sweep reclaim it after a visibility timeout.

alter table notification_outbox
  add column if not exists claimed_at timestamptz;

create index if not exists notification_outbox_claim_idx
  on notification_outbox (claimed_at) where status = 'sending';
