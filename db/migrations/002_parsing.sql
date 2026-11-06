-- Globie Keeper — receipt parsing metadata and agreement fronter.
-- Money stays bigint minor units; these columns only hold parse bookkeeping.

alter table agreements
  add column if not exists fronted_by uuid references members (id);

alter table bills
  add column if not exists warnings jsonb not null default '[]'::jsonb;
alter table bills
  add column if not exists frames_extracted int not null default 0;
alter table bills
  add column if not exists parsed_at timestamptz;
alter table bills
  add column if not exists raw_extraction jsonb;

create index if not exists bills_status_idx on bills (status);
create index if not exists shares_bill_idx on shares (bill_id);
