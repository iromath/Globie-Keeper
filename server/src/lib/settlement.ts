/**
 * One place where money becomes a settled fact: shares, payments, ledger,
 * Globie points and the bill/agreement rollup. Both the PayPal webhook and the
 * `POST /shares/:id/capture` fallback call in here, so a replayed event and a
 * retried capture cannot double-award anything.
 */

import type { Db } from '../db/pool.js';
import { withTransaction } from '../db/pool.js';
import { extractSettledRate, type SettledRate } from './fx.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { isPayPalConfigured, readOrder } from './paypal.js';

/** First reimburser in an agreement earns the most (DEV_PLAN §2.12). */
const GLOBIE_BY_RANK = [10, 5, 3];
const GLOBIE_DAILY_CAP = 50;
const GLOBIE_REASON = 'globie';

export type SettlementShare = {
  id: string;
  bill_id: string;
  bill_total: number;
  bill_status: string;
  agreement_id: string;
  group_id: string;
  member_id: string;
  member_name: string;
  amount: number;
  currency: string;
  status: string;
  created_at: Date;
  paid_at: Date | null;
};

export type SettleInput = {
  shareId: string;
  orderId: string | null;
  captureId: string | null;
  /** Provider response stored on `payments.raw_payload`. */
  payload: unknown;
  actor: string;
};

export type SettleResult = {
  shareId: string;
  alreadyPaid: boolean;
  pointsAwarded: number;
  rank: number | null;
  billSettled: boolean;
  /** PayPal's own rate, when the payer's currency differed from the bill's. */
  settledRate: SettledRate | null;
};

async function loadShare(
  db: Db,
  shareId: string,
  lock = false,
): Promise<SettlementShare> {
  const { rows } = await db.query<SettlementShare>(
    `select s.id, s.bill_id, b.total as bill_total, b.status as bill_status,
            b.agreement_id, a.group_id,
            s.member_id, u.display_name as member_name,
            s.amount, s.currency, s.status, s.created_at, s.paid_at
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
      where s.id = $1
      ${lock ? 'for update of s' : ''}`,
    [shareId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Share not found');
  return row;
}

/** Mark the bill settled once nothing is outstanding; then check the agreement. */
async function rollUpBill(
  tx: Db,
  share: SettlementShare,
): Promise<{ billSettled: boolean }> {
  const { rows: openRows } = await tx.query<{ open: number }>(
    `select count(*)::int as open
       from shares
      where bill_id = $1 and status not in ('paid', 'settled', 'refunded')`,
    [share.bill_id],
  );

  if ((openRows[0]?.open ?? 0) > 0) return { billSettled: false };

  const { rows: billRows } = await tx.query<{ id: string }>(
    `update bills set status = 'SETTLED'
      where id = $1 and status in ('FINALIZED', 'COLLECTING')
      returning id`,
    [share.bill_id],
  );

  if (billRows.length > 0) {
    await recordEvent(tx, {
      groupId: share.group_id,
      agreementId: share.agreement_id,
      shareId: share.id,
      memberId: share.member_id,
      eventType: 'bill.settled',
      amountMinor: share.bill_total,
      currency: share.currency.trim(),
      actor: 'Globie Keeper',
      summary: 'Everyone paid — the bill is settled',
    });
  }

  const { rows: agreementRows } = await tx.query<{ open: number }>(
    `select count(*)::int as open from bills
      where agreement_id = $1 and status not in ('SETTLED', 'CANCELLED')`,
    [share.agreement_id],
  );

  if ((agreementRows[0]?.open ?? 1) === 0) {
    const { rows: settledRows } = await tx.query<{ id: string }>(
      `update agreements set status = 'settled'
        where id = $1 and status not in ('cancelled', 'settled')
        returning id`,
      [share.agreement_id],
    );
    if (settledRows.length > 0) {
      await recordEvent(tx, {
        groupId: share.group_id,
        agreementId: share.agreement_id,
        eventType: 'agreement.settled',
        actor: 'Globie Keeper',
        summary: 'Every bill in this agreement is settled',
      });
    }
  }

  return { billSettled: true };
}

/**
 * Fronting cash is the act the whole product is built around, so it pays Globie
 * as well as the Hero seat. Flat and once per agreement: the reward is for the
 * outing, not the receipt count, and it is well below a first-place repayment.
 */
const FRONT_GLOBIE = 5;
const FRONT_GLOBIE_REASON = 'fronted';

export type GlobieAwardInput = {
  agreementId: string;
  groupId: string;
  memberId: string;
  /** Share that triggered the award; excluded from the repayment rank. */
  shareId: string | null;
  /** Defaults to `globie`; one award per (agreement, member, reason). */
  reason?: string;
  /**
   * Flat award instead of the 10/5/3 rank. Tips use this: they reward a
   * gesture, not a position in the repayment race.
   */
  amount?: number;
};

export type GlobieAward = {
  delta: number;
  rank: number;
  /** Member's total Globie after this award. */
  balance: number;
};

/**
 * Rank-based Globie (10/5/3/1) with the 50/day cap and one award per
 * (agreement, member, reason). Runs inside the caller's transaction so the
 * ranking and the share it rewards commit together.
 */
export async function awardGlobie(
  tx: Db,
  input: GlobieAwardInput,
): Promise<GlobieAward> {
  const reason = input.reason?.trim() || GLOBIE_REASON;

  const { rows: rankRows } = await tx.query<{ paid_before: number }>(
    `select count(*)::int as paid_before
       from shares s
       join bills b on b.id = s.bill_id
      where b.agreement_id = $1
        and s.paid_at is not null
        and ($2::uuid is null or s.id <> $2::uuid)`,
    [input.agreementId, input.shareId],
  );
  const rank = (rankRows[0]?.paid_before ?? 0) + 1;

  const base =
    input.amount ??
    (rank <= GLOBIE_BY_RANK.length ? GLOBIE_BY_RANK[rank - 1]! : 1);

  const { rows: capRows } = await tx.query<{ total: number }>(
    `select coalesce(sum(delta), 0)::int as total
       from points_awards
      where member_id = $1 and created_at >= date_trunc('day', now())`,
    [input.memberId],
  );
  const room = Math.max(0, GLOBIE_DAILY_CAP - (capRows[0]?.total ?? 0));
  const award = Math.min(base, room);

  let delta = 0;
  if (award > 0) {
    // unique (agreement_id, member_id, reason) keeps it to one award per member.
    const { rows: awardRows } = await tx.query<{ delta: number }>(
      `insert into points_awards (agreement_id, member_id, reason, delta)
       values ($1, $2, $3, $4)
       on conflict (agreement_id, member_id, reason) do nothing
       returning delta`,
      [input.agreementId, input.memberId, reason, award],
    );

    if (awardRows.length > 0) {
      delta = award;
      await tx.query(
        `insert into points_events (group_id, member_id, delta, reason, agreement_id, share_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [input.groupId, input.memberId, delta, reason, input.agreementId, input.shareId],
      );
    }
  }

  const { rows: balanceRows } = await tx.query<{ balance: number }>(
    `select coalesce(sum(delta), 0)::bigint as balance
       from points_awards
      where member_id = $1`,
    [input.memberId],
  );

  return { delta, rank, balance: balanceRows[0]?.balance ?? 0 };
}

/**
 * Award the flat fronting reward the first time a bill is finalized. Keyed on
 * (agreement, member, 'fronted'), so finalizing a second bill in the same
 * agreement is a no-op.
 */
export async function awardFrontedGlobie(
  tx: Db,
  input: { agreementId: string; groupId: string; memberId: string },
): Promise<GlobieAward> {
  return awardGlobie(tx, {
    ...input,
    shareId: null,
    reason: FRONT_GLOBIE_REASON,
    amount: FRONT_GLOBIE,
  });
}

/**
 * Record that a share was actually paid: flip the share, upsert the payment,
 * append `share.paid` with `hours_to_pay` (the continuous aggregate reads it),
 * award Globie and roll the bill up.
 */
export async function settleShare(input: SettleInput): Promise<SettleResult> {
  return withTransaction(async (tx) => {
    const preview = await loadShare(tx, input.shareId);

    // Serialize settlements inside one agreement so the 10/5/3 ranks are stable.
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      preview.agreement_id,
    ]);

    const share = await loadShare(tx, input.shareId, true);
    const currency = share.currency.trim();

    if (share.status === 'paid' || share.status === 'settled') {
      if (input.captureId) {
        await tx.query(
          `update shares
              set paypal_capture_id = coalesce(paypal_capture_id, $2)
            where id = $1`,
          [share.id, input.captureId],
        );
      }
      return {
        shareId: share.id,
        alreadyPaid: true,
        pointsAwarded: 0,
        rank: null,
        billSettled: share.bill_status === 'SETTLED',
        settledRate: null,
      };
    }

    const settledRate = extractSettledRate(input.payload);

    const paidAt = new Date();
    const hoursToPay =
      Math.round(
        ((paidAt.getTime() - new Date(share.created_at).getTime()) / 3_600_000) * 100,
      ) / 100;

    await tx.query(
      `update shares
          set status = 'paid',
              paid_at = $2,
              paypal_order_id = coalesce(paypal_order_id, $3),
              paypal_capture_id = coalesce($4, paypal_capture_id)
        where id = $1`,
      [share.id, paidAt, input.orderId, input.captureId],
    );

    const providerRef = input.orderId ?? input.captureId;
    if (providerRef) {
      await tx.query(
        `insert into payments
           (share_id, provider, provider_ref, amount, currency, status, raw_payload)
         values ($1, 'paypal', $2, $3, $4, 'completed', $5::jsonb)
         on conflict (provider, provider_ref) do update
           set status = 'completed', raw_payload = excluded.raw_payload`,
        [share.id, providerRef, share.amount, currency, JSON.stringify(input.payload ?? {})],
      );
    }

    const globie = await awardGlobie(tx, {
      agreementId: share.agreement_id,
      groupId: share.group_id,
      memberId: share.member_id,
      shareId: share.id,
    });
    const granted = globie.delta;
    const rank = globie.rank;

    await recordEvent(tx, {
      groupId: share.group_id,
      agreementId: share.agreement_id,
      shareId: share.id,
      memberId: share.member_id,
      eventType: 'share.paid',
      amountMinor: share.amount,
      currency,
      actor: share.member_name,
      summary:
        granted > 0
          ? `${share.member_name} reimbursed their share — +${granted} Globie`
          : `${share.member_name} reimbursed their share`,
      metadata: {
        hours_to_pay: hoursToPay,
        rank,
        globie: granted,
        ...(settledRate ? { fx_rate: settledRate } : {}),
      },
    });

    const rollup = await rollUpBill(tx, share);

    return {
      shareId: share.id,
      alreadyPaid: false,
      pointsAwarded: granted,
      rank,
      billSettled: rollup.billSettled,
      settledRate,
    };
  });
}

/** PayPal declined the capture: the share stays collectable. */
export async function failShare(input: {
  shareId: string;
  actor: string;
  reason?: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const share = await loadShare(tx, input.shareId, true);
    if (['paid', 'settled', 'refunded'].includes(share.status)) return;

    // The approval link died with the order; leaving it behind would keep a
    // "Pay" button that reopens a checkout PayPal already refused.
    await tx.query(
      `update shares set status = 'failed', paypal_approve_url = null where id = $1`,
      [share.id],
    );
    await tx.query(
      `update payments set status = 'failed' where share_id = $1 and status = 'pending'`,
      [share.id],
    );

    await recordEvent(tx, {
      groupId: share.group_id,
      agreementId: share.agreement_id,
      shareId: share.id,
      memberId: share.member_id,
      eventType: 'payment.failed',
      amountMinor: share.amount,
      currency: share.currency.trim(),
      actor: input.actor,
      summary:
        input.reason ??
        `PayPal declined the payment from ${share.member_name} — the share can be re-requested`,
    });
  });
}

/**
 * How long an unapproved PayPal checkout may sit before it counts as dead. The
 * browser is the only place a checkout can be approved, so a share that is
 * still unapproved this long after its order was opened was abandoned or
 * refused; waiting longer just leaves the row saying "Payment requested".
 * The clock is the order's own `create_time`, not the share's — a share is
 * written at finalize, long before the fronter requests payment.
 */
const CHECKOUT_TTL_MS = 5 * 60 * 1000;

/**
 * A checkout PayPal refuses at its own page never comes back to us: PayPal
 * shows a generic error instead of the return (or cancel) URL, so no capture
 * runs and no webhook fires. The share would sit in `requested` forever and
 * every screen would keep saying "Payment requested". Re-read the order when
 * the owing member loads their shares, close the dead checkouts and report
 * whether PayPal holds an approval we can still capture.
 */
export async function reconcileShare(share: {
  id: string;
  status: string;
  paypal_order_id?: string | null;
}): Promise<{ status: string; canFinish: boolean }> {
  if (
    share.status !== 'requested' ||
    !share.paypal_order_id ||
    !isPayPalConfigured()
  ) {
    return { status: share.status, canFinish: false };
  }

  const order = await readOrder(share.paypal_order_id).catch(() => null);
  if (!order) return { status: share.status, canFinish: false };

  if (order.status === 'APPROVED' || order.status === 'COMPLETED') {
    return { status: share.status, canFinish: true };
  }

  const stale =
    order.createTime !== null &&
    Date.now() - new Date(order.createTime).getTime() > CHECKOUT_TTL_MS;
  if (order.status === 'VOIDED' || stale) {
    await failShare({
      shareId: share.id,
      actor: 'PayPal',
      reason: 'The PayPal checkout was not completed — the fronter can request it again',
    });
    return { status: 'failed', canFinish: false };
  }

  return { status: share.status, canFinish: false };
}

/** A refund reverses the reimbursement and the Globie it earned. */
export async function reverseShare(input: {
  shareId: string;
  actor: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const preview = await loadShare(tx, input.shareId);
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      preview.agreement_id,
    ]);

    const share = await loadShare(tx, input.shareId, true);
    if (share.status !== 'paid' && share.status !== 'settled') return;

    await tx.query(`update shares set status = 'refunded' where id = $1`, [share.id]);
    await tx.query(
      `update payments set status = 'refunded'
        where share_id = $1 and status in ('completed', 'pending')`,
      [share.id],
    );

    const { rows: reversedRows } = await tx.query<{ delta: number }>(
      `delete from points_awards
        where agreement_id = $1 and member_id = $2 and reason = $3
        returning delta`,
      [share.agreement_id, share.member_id, GLOBIE_REASON],
    );
    const reversed = reversedRows[0]?.delta ?? 0;
    if (reversed > 0) {
      await tx.query(
        `insert into points_events (group_id, member_id, delta, reason, agreement_id, share_id)
         values ($1, $2, $3, 'globie.refund', $4, $5)`,
        [share.group_id, share.member_id, -reversed, share.agreement_id, share.id],
      );
    }

    await tx.query(
      `update bills set status = 'COLLECTING' where id = $1 and status = 'SETTLED'`,
      [share.bill_id],
    );
    await tx.query(
      `update agreements set status = 'accepted' where id = $1 and status = 'settled'`,
      [share.agreement_id],
    );

    await recordEvent(tx, {
      groupId: share.group_id,
      agreementId: share.agreement_id,
      shareId: share.id,
      memberId: share.member_id,
      eventType: 'share.refunded',
      amountMinor: share.amount,
      currency: share.currency.trim(),
      actor: input.actor,
      summary: `${share.member_name}'s payment was refunded${
        reversed > 0 ? ` — ${reversed} Globie reversed` : ''
      }`,
      metadata: { globie: -reversed },
    });
  });
}
