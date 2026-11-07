-- Globie Keeper — fronting must out-earn every repayment (DEV_PLAN §2.12).
--
-- Fronting paid a flat 5, which tied the second repayer and lost to the first:
-- the person who handed the merchant the money finished the outing behind the
-- people who simply paid them back. It now pays 15, above the 10/5/3/1 ladder.
--
-- `points_awards` is the running balance and `points_events` is the append-only
-- history, so an existing award has to move in both places: raise the award,
-- then append only the difference as a new event.

with stale as (
  select agreement_id, member_id, delta
    from points_awards
   where reason = 'fronted'
     and delta < 15
),
raised as (
  update points_awards pa
     set delta = 15
    from stale s
   where pa.agreement_id = s.agreement_id
     and pa.member_id = s.member_id
     and pa.reason = 'fronted'
  returning pa.agreement_id, pa.member_id, pa.delta - s.delta as top_up
)
insert into points_events (group_id, member_id, delta, reason, agreement_id, share_id)
select a.group_id, r.member_id, r.top_up, 'fronted', r.agreement_id, null
  from raised r
  join agreements a on a.id = r.agreement_id;
