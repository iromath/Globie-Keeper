-- Globie Keeper — FX display currency (DEV_PLAN §2.19).
-- A member can choose the currency they read amounts in. This is a preference
-- only: every share and tip keeps its canonical group currency, because the
-- PayPal capture and the settlement guard compare the stored amount.

alter table users add column if not exists display_currency char(3);

-- Last known good indicative rates, so a failed upstream fetch degrades to a
-- stale snapshot instead of a broken screen. Populated on server boot/first use.
create table if not exists fx_rates (
  base char(3) not null,
  quote char(3) not null,
  rate numeric(20, 10) not null check (rate > 0),
  as_of timestamptz not null,
  source text not null,
  primary key (base, quote)
);
