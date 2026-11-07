-- Globie Keeper — fronting pays a flat 5 Globie (DEV_PLAN §2.12).
--
-- The award engine only ever paid for repaying someone else, so the person who
-- actually handed the merchant the money ended every outing with a Hero seat
-- and no points. New bills award this at finalize; this backfills the
-- agreements that were finalized before the rule existed.
--
-- `points_awards` keeps the unique (agreement_id, member_id, reason) guard, so
-- re-running this on a database that already has the awards inserts nothing.

with awarded as (
  insert into points_awards (agreement_id, member_id, reason, delta)
  select a.id, a.fronted_by, 'fronted', 5
    from agreements a
   where a.fronted_by is not null
     and exists (
       select 1
         from bills b
        where b.agreement_id = a.id
          and b.status in ('FINALIZED', 'COLLECTING', 'SETTLED')
     )
  on conflict (agreement_id, member_id, reason) do nothing
  returning agreement_id, member_id, delta
)
insert into points_events (group_id, member_id, delta, reason, agreement_id, share_id)
select a.group_id, aw.member_id, aw.delta, 'fronted', aw.agreement_id, null
  from awarded aw
  join agreements a on a.id = aw.agreement_id;
