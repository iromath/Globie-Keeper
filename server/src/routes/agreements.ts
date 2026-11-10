import type { FastifyPluginAsync } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import { requireAgreementMember, requireMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { recordEvent } from '../lib/ledger.js';
import { mapAgreement, type AgreementRow } from '../lib/serialize.js';
import {
    asRecord,
    currencyCode,
    optionalAgreementSplitMode,
    optionalBps,
    optionalDate,
    optionalUuid,
    pathUuid,
    requiredMinor,
    requiredUuid,
} from '../lib/validate.js';

type AgreementParams = { Params: { id: string } };

type AgreementCounts = { accepted: number; total: number };

/**
 * One agreement row plus the agreement-wide vote tally and the caller's own
 * vote. `memberId` is optional so an internal caller without a member can still
 * read the terms; the UI always passes it.
 */
async function loadAgreement(agreementId: string, memberId?: string): Promise<AgreementRow> {
  const { rows } = await query<AgreementRow>(
    `select a.id, a.group_id, a.currency, a.estimated_total, a.deadline,
            a.status, a.created_by, a.fronted_by,
            a.split_mode, a.late_fee_bps, a.late_fee_cap_bps,
            (select count(*) from agreement_acceptances aa
              where aa.agreement_id = a.id) as accepted_count,
            (select count(*) from members m
              where m.group_id = a.group_id and m.status <> 'removed') as member_count,
            (select count(*) from agreement_votes v
              where v.agreement_id = a.id and v.split_mode = 'item') as votes_item,
            (select count(*) from agreement_votes v
              where v.agreement_id = a.id and v.split_mode = 'equal') as votes_equal,
            (select v.split_mode from agreement_votes v
              where v.agreement_id = a.id and v.member_id = $2) as my_vote
       from agreements a
      where a.id = $1`,
    [agreementId, memberId ?? null],
  );
  const agreement = rows[0];
  if (!agreement) throw ApiError.notFound('Agreement not found');
  return agreement;
}

export const agreementRoutes: FastifyPluginAsync = async (app) => {
  /** Open the one-tap agreement that everyone will accept. */
  app.post('/agreements', async (request) => {
    const body = asRecord(request.body);
    const groupId = requiredUuid(body, 'groupId');
    const estimatedTotalMinor = requiredMinor(body, 'estimatedTotalMinor');
    const deadline = optionalDate(body, 'deadline');

    const member = await requireMember(request, groupId);

    // Creating the agreement is bookkeeping; fronting the bill is a fact about
    // who paid the merchant. They are not the same person by default — whoever
    // opens the form must say who the merchant was paid by, or we never learn it.
    const frontedByMemberId = optionalUuid(body, 'frontedByMemberId') ?? member.id;
    const { rows: fronterRows } = await query<{ id: string; display_name: string }>(
      `select m.id, u.display_name
         from members m join users u on u.id = m.user_id
        where m.id = $1 and m.group_id = $2 and m.status <> 'removed'`,
      [frontedByMemberId, groupId],
    );
    const fronter = fronterRows[0];
    if (!fronter) {
      throw ApiError.badRequest(
        'invalid_fronted_by_member',
        'frontedByMemberId must be an active member of this group',
      );
    }

    // Late fee: a monthly rate in basis points, charged on an overdue share until
    // it is paid, capped as a share of that share. Either both halves describe a
    // real fee or neither does — a cap without a rate is a half-signed term.
    const lateFeeBps = optionalBps(body, 'lateFeeBps') ?? 0;
    const lateFeeCapBps = optionalBps(body, 'lateFeeCapBps');
    if (lateFeeBps === 0 && lateFeeCapBps !== null) {
      throw ApiError.badRequest(
        'late_fee_incomplete',
        'Give the monthly fee a rate, or choose no late fee.',
      );
    }
    // The vote starts wherever the fronter set it, so the first bill has a sane
    // default before anyone has voted.
    const splitMode = optionalAgreementSplitMode(body) ?? 'item';

    const { rows: groupRows } = await query<{ default_currency: string; name: string }>(
      `select default_currency, name from groups where id = $1`,
      [groupId],
    );
    const group = groupRows[0];
    if (!group) throw ApiError.notFound('Group not found');

    const { rows: activeRows } = await query<{ id: string }>(
      `select id from agreements
        where group_id = $1 and status in ('pending', 'accepted')
        limit 1`,
      [groupId],
    );
    if (activeRows[0]) {
      throw ApiError.conflict(
        'agreement_active',
        'This group already has an active agreement',
      );
    }

    const currency =
      body.currency === undefined
        ? group.default_currency.trim()
        : currencyCode(body.currency);

    return withTransaction(async (tx) => {
      const { rows } = await tx.query<AgreementRow>(
        `insert into agreements
           (group_id, currency, estimated_total, deadline, terms_snapshot, status,
            created_by, fronted_by, split_mode, late_fee_bps, late_fee_cap_bps)
         values ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, $8, $9, $10)
         returning id, group_id, currency, estimated_total, deadline, status,
                   created_by, fronted_by, split_mode, late_fee_bps, late_fee_cap_bps`,
        [
          groupId,
          currency,
          estimatedTotalMinor,
          deadline,
          JSON.stringify({
            groupName: group.name,
            estimatedTotalMinor,
            currency,
            deadline: deadline ? deadline.toISOString() : null,
            splitMode,
            lateFeeBps,
            lateFeeCapBps,
            note: 'Each member accepts before the receipt is captured.',
          }),
          member.id,
          frontedByMemberId,
          splitMode,
          lateFeeBps,
          lateFeeCapBps,
        ],
      );
      const agreement = rows[0];
      if (!agreement) {
        throw new ApiError(500, 'agreement_insert_failed', 'Could not open the agreement');
      }

      // The fronter's pick is their vote, so the tally starts at one instead of
      // zero and the group can see where the agreement already leans.
      await tx.query(
        `insert into agreement_votes (agreement_id, member_id, split_mode)
         values ($1, $2, $3)`,
        [agreement.id, member.id, splitMode],
      );

      await recordEvent(tx, {
        groupId,
        agreementId: agreement.id,
        memberId: member.id,
        eventType: 'system.agreement.created',
        amountMinor: estimatedTotalMinor,
        currency,
        actor: member.displayName,
        summary:
          frontedByMemberId === member.id
            ? `${member.displayName} opened the agreement and fronts the bill — everyone taps once to accept`
            : `${member.displayName} opened the agreement — ${fronter.display_name} fronts the bill`,
      });

      const { rows: countRows } = await tx.query<{ total: number }>(
        `select count(*)::int as total from members
          where group_id = $1 and status <> 'removed'`,
        [groupId],
      );

      return {
        agreement: mapAgreement({
          ...agreement,
          accepted_count: 0,
          member_count: countRows[0]?.total ?? 0,
          votes_item: splitMode === 'item' ? 1 : 0,
          votes_equal: splitMode === 'equal' ? 1 : 0,
          my_vote: splitMode,
        }),
      };
    });
  });

  /** Idempotent consent. The group flips to `accepted` once everyone has tapped. */
  app.post<AgreementParams>('/agreements/:id/accept', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    await withTransaction(async (tx) => {
      const inserted = await tx.query(
        `insert into agreement_acceptances (agreement_id, member_id)
         values ($1, $2)
         on conflict (agreement_id, member_id) do nothing`,
        [agreementId, ctx.member.id],
      );

      const { rows } = await tx.query<{ accepted: number; total: number }>(
        `select
           (select count(*)::int from agreement_acceptances
             where agreement_id = $1) as accepted,
           (select count(*)::int from members
             where group_id = $2 and status <> 'removed') as total`,
        [agreementId, ctx.groupId],
      );
      const counts: AgreementCounts = {
        accepted: rows[0]?.accepted ?? 0,
        total: rows[0]?.total ?? 0,
      };

      if (counts.total > 0 && counts.accepted >= counts.total) {
        await tx.query(
          `update agreements set status = 'accepted'
            where id = $1 and status = 'pending'`,
          [agreementId],
        );
      }

      if (inserted.rowCount && inserted.rowCount > 0) {
        await recordEvent(tx, {
          groupId: ctx.groupId,
          agreementId,
          memberId: ctx.member.id,
          eventType: 'agreement.accepted',
          currency: ctx.currency,
          actor: ctx.member.displayName,
          summary: `${ctx.member.displayName} agreed to the reimbursement terms`,
        });
      }
    });

    return { agreement: mapAgreement(await loadAgreement(agreementId, ctx.member.id)) };
  });

  /**
   * One vote per member on how to divide: by line item, or evenly. The vote is
   * agreement-wide, so it is the default for every bill this agreement makes.
   * A tie leaves `item` in place — nobody has to break it, and the fronter can
   * still override a single bill.
   */
  app.post<AgreementParams>('/agreements/:id/vote', async (request) => {
    const agreementId = pathUuid(request.params.id);
    const ctx = await requireAgreementMember(request, agreementId);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const body = asRecord(request.body);
    const splitMode = optionalAgreementSplitMode(body);
    if (!splitMode) {
      throw ApiError.badRequest(
        'split_mode_required',
        'splitMode must be item or equal',
      );
    }

    const outcome = await withTransaction(async (tx) => {
      await tx.query(
        `insert into agreement_votes (agreement_id, member_id, split_mode)
         values ($1, $2, $3)
         on conflict (agreement_id, member_id)
         do update set split_mode = excluded.split_mode, created_at = now()`,
        [agreementId, ctx.member.id, splitMode],
      );

      const { rows } = await tx.query<{ item: number; equal: number }>(
        `select
           count(*) filter (where split_mode = 'item')::int as item,
           count(*) filter (where split_mode = 'equal')::int as equal
         from agreement_votes where agreement_id = $1`,
        [agreementId],
      );
      const item = rows[0]?.item ?? 0;
      const equal = rows[0]?.equal ?? 0;
      const winner = equal > item ? 'equal' : 'item';

      await tx.query(`update agreements set split_mode = $2 where id = $1`, [
        agreementId,
        winner,
      ]);

      // The vote is agreement-wide, so a bill that has not been divided yet
      // follows it. A bill already allocating keeps the split its members saw.
      await tx.query(
        `update bills set split_mode = $2
          where agreement_id = $1 and status in ('UPLOADED', 'PARSING', 'PARSED')`,
        [agreementId, winner],
      );

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId,
        memberId: ctx.member.id,
        eventType: 'agreement.voted',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} voted to divide ${
          splitMode === 'equal' ? 'evenly' : 'by line item'
        } — ${equal} even, ${item} by item`,
      });

      return winner;
    });

    return {
      outcome,
      agreement: mapAgreement(await loadAgreement(agreementId, ctx.member.id)),
    };
  });
};
