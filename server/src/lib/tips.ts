/**
 * "Give a tip": a member voluntarily adds money for the fronter on top of their
 * own share (DEV_PLAN §2.18). Tips live in their own table rather than in
 * `shares` (unique per bill/member) or `payments` (share_id is NOT NULL), so
 * the reimbursement rollup and the webhook amount guard keep their meaning.
 * The tip order names the fronter as payee, so it settles straight to them.
 *
 * Deliberately absent here: `payments` rows and `rollUpBill`. A tip is not part
 * of what settles the bill, so it must never make an unpaid bill look paid.
 */


import { randomUUID } from 'node:crypto';

import { query, withTransaction, type Db } from '../db/pool.js';
import { feeCoverAllowed, feeScheduleFor, grossUpMinor } from './fees.js';
import { extractSettledRate, type SettledRate } from './fx.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { createOrder, isPayPalConfigured, readOrder } from './paypal.js';
import { awardGlobie } from './settlement.js';

/** Tipping is a nice gesture, not a race — a flat reward, one per member. */
const TIP_GLOBIE = 2;
const TIP_REASON = 'tip';

export type TipRow = {
  id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  bill_currency: string;
  bill_status: string;
  from_member_id: string;
  from_member_name: string;
  to_member_id: string;
  to_member_name: string;
  amount: number;
  currency: string;
  message: string | null;
  status: string;
  paypal_order_id: string | null;
  paypal_approve_url: string | null;
  paid_at: Date | null;
  created_at: Date;
  /** Optional fee coverage snapshot (DEV_PLAN §2.20); the net stays `amount`. */
  fee_minor: number;
  gross_minor: number | null;
};

async function loadTip(db: Db, tipId: string, lock = false): Promise<TipRow> {
  const { rows } = await db.query<TipRow>(
    `select t.id, t.bill_id, t.agreement_id, a.group_id,
            b.currency as bill_currency, b.status as bill_status,
            t.from_member_id, fu.display_name as from_member_name,
            t.to_member_id, tu.display_name as to_member_name,
            t.amount, t.currency, t.message, t.status,
            t.paypal_order_id, t.paypal_approve_url, t.paid_at, t.created_at,
            t.fee_minor, t.gross_minor
       from tips t
       join bills b on b.id = t.bill_id
       join agreements a on a.id = t.agreement_id
       join members fm on fm.id = t.from_member_id
       join users fu on fu.id = fm.user_id
       join members tm on tm.id = t.to_member_id
       join users tu on tu.id = tm.user_id
      where t.id = $1
      ${lock ? 'for update of t' : ''}`,
    [tipId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Tip not found');
  return row;
}

export async function listTips(billId: string): Promise<TipRow[]> {
  const { rows } = await query<TipRow>(
    `select t.id, t.bill_id, t.agreement_id, a.group_id,
            b.currency as bill_currency, b.status as bill_status,
            t.from_member_id, fu.display_name as from_member_name,
            t.to_member_id, tu.display_name as to_member_name,
            t.amount, t.currency, t.message, t.status,
            t.paypal_order_id, t.paypal_approve_url, t.paid_at, t.created_at,
            t.fee_minor, t.gross_minor
       from tips t
       join bills b on b.id = t.bill_id
       join agreements a on a.id = t.agreement_id
       join members fm on fm.id = t.from_member_id
       join users fu on fu.id = fm.user_id
       join members tm on tm.id = t.to_member_id
       join users tu on tu.id = tm.user_id
      where t.bill_id = $1
      order by t.created_at asc`,
    [billId],
  );
  return rows;
}

/**
 * Who fronted the agreement and what to call them. `fronted_by` is set when the
 * agreement is created; falling back to `created_by` keeps older rows tippable.
 *
 * `payoutReady` says whether money can actually reach them: without a PayPal
 * email (or merchant id) every tip attempt is refused, so the UI needs to know
 * that before it offers an amount.
 */
export async function loadFronter(agreementId: string): Promise<{
  id: string | null;
  name: string;
  payoutReady: boolean;
}> {
  const { rows } = await query<{
    fronted_by: string | null;
    fronted_name: string;
    paypal_email: string | null;
    paypal_merchant_id: string | null;
    user_paypal_email: string | null;
  }>(
    `select a.fronted_by,
            coalesce(fu.display_name, cu.display_name) as fronted_name,
            fm.paypal_email,
            fm.paypal_merchant_id,
            fu.paypal_email as user_paypal_email
       from agreements a
       left join members fm on fm.id = a.fronted_by
       left join users fu on fu.id = fm.user_id
       join members cm on cm.id = a.created_by
       join users cu on cu.id = cm.user_id
      where a.id = $1`,
    [agreementId],
  );

  const row = rows[0];
  return {
    id: row?.fronted_by ?? null,
    name: row?.fronted_name ?? 'the fronter',
    // Same fallback as `requestTip`: accounts that linked PayPal before the
    // address moved onto the membership only have it on `users`.
    payoutReady: Boolean(
      row?.paypal_email?.trim() ||
        row?.paypal_merchant_id?.trim() ||
        row?.user_paypal_email?.trim(),
    ),
  };
}

export type RequestTipInput = {
  billId: string;
  agreementId: string;
  groupId: string;
  currency: string;
  merchant: string | null;
  fromMember: { id: string; displayName: string };
  toMemberId: string;
  toMemberName: string;
  amountMinor: number;
  message: string | null;
};

export type RequestTipResult = {
  tipId: string;
  status: string;
  paypalOrderId: string;
  approveUrl: string;
  amountMinor: number;
  /** Optional fee coverage (DEV_PLAN §2.20): what the payer is asked extra. */
  feeMinor: number;
  grossMinor: number;
  currency: string;
  alreadyRequested: boolean;
};

/**
 * Create (or reuse) this member's tip for the bill and open a PayPal order for
 * it. Re-requesting an unpaid tip reuses the row; the order is only cached when
 * the amount is unchanged, because a different amount needs a different order.
 */
export async function requestTip(
  input: RequestTipInput,
): Promise<RequestTipResult> {
  if (!isPayPalConfigured()) {
    throw ApiError.conflict(
      'paypal_not_configured',
      'PayPal sandbox credentials are not configured on this server',
    );
  }

  // The tip settles into the fronter's own account, so it needs their address
  // before any tip row or order exists.
  const { rows: payeeRows } = await query<{
    paypal_email: string | null;
    paypal_merchant_id: string | null;
    cover_paypal_fee: boolean;
    user_paypal_email: string | null;
    payer_paypal_email: string | null;
  }>(
    `select m.paypal_email, m.paypal_merchant_id, m.cover_paypal_fee,
            (select u.paypal_email
               from users u
              where u.id = m.user_id) as user_paypal_email,
            (select u.paypal_email
               from members pm
               join users u on u.id = pm.user_id
              where pm.id = $2) as payer_paypal_email
       from members m
      where m.id = $1`,
    [input.toMemberId, input.fromMember.id],
  );
  // Older accounts only carry the linked address on `users`; without the
  // fallback a fronter who never re-saved settings can never be tipped.
  const payeeEmail =
    payeeRows[0]?.paypal_email?.trim() || payeeRows[0]?.user_paypal_email?.trim() || null;
  const payeeMerchantId = payeeRows[0]?.paypal_merchant_id?.trim() || null;
  const payerEmail = payeeRows[0]?.payer_paypal_email?.trim().toLowerCase() ?? null;

  /**
   * Optional fee coverage (DEV_PLAN §2.20). The fronter opted in, so the payer
   * is asked for the gross and the tip nets `amountMinor`. Refused in live mode
   * unless explicitly allowed — passing the fee on is a surcharge.
   */
  const coverFee = Boolean(payeeRows[0]?.cover_paypal_fee) && feeCoverAllowed();
  const fee = coverFee
    ? grossUpMinor(input.amountMinor, feeScheduleFor(input.currency)) -
      input.amountMinor
    : 0;
  const gross = input.amountMinor + fee;

  if (!payeeEmail && !payeeMerchantId) {
    throw ApiError.conflict(
      'fronter_paypal_missing',
      `${input.toMemberName} must add their PayPal email before you can tip them`,
    );
  }

  // PayPal refuses a transfer from an account to itself, and a tip to
  // yourself is not a tip.
  if (payerEmail && payeeEmail && payerEmail === payeeEmail.toLowerCase()) {
    throw ApiError.conflict(
      'self_payment',
      'You cannot tip yourself — that money is already yours',
    );
  }

  const { rows: existingRows } = await query<{
    id: string;
    status: string;
    amount: number;
    fee_minor: number;
    gross_minor: number | null;
    paypal_order_id: string | null;
    paypal_approve_url: string | null;
  }>(
    `select id, status, amount, fee_minor, gross_minor,
            paypal_order_id, paypal_approve_url
       from tips where bill_id = $1 and from_member_id = $2`,
    [input.billId, input.fromMember.id],
  );

  const existing = existingRows[0];
  let tipId: string;
  // A reused row means the previous order is dead. PayPal replays the original
  // response for a reused PayPal-Request-Id — including an order the payer
  // already refused — so a retry needs a key of its own.
  let reuseOfDeadOrder = false;

  if (existing) {
    if (existing.status === 'paid') {
      throw ApiError.conflict(
        'tip_already_paid',
        'You already tipped the fronter on this bill',
      );
    }

    if (
      existing.status === 'requested' &&
      existing.paypal_approve_url &&
      existing.amount === input.amountMinor
    ) {
      return {
        tipId: existing.id,
        status: existing.status,
        paypalOrderId: existing.paypal_order_id ?? '',
        approveUrl: existing.paypal_approve_url,
        amountMinor: existing.amount,
        feeMinor: existing.fee_minor,
        grossMinor: existing.gross_minor ?? existing.amount,
        currency: input.currency,
        alreadyRequested: true,
      };
    }

    if (existing.status === 'requested' && existing.amount !== input.amountMinor) {
      throw ApiError.conflict(
        'tip_in_progress',
        'A tip checkout is already open for a different amount — finish or cancel it first',
      );
    }

    // proposed / failed / refunded: reuse the row, the old order is dead.
    await query(
      `update tips
          set amount = $2, currency = $3, message = $4, status = 'proposed',
              paypal_order_id = null, paypal_capture_id = null,
              paypal_approve_url = null, paid_at = null,
              fee_minor = 0, gross_minor = null
        where id = $1`,
      [existing.id, input.amountMinor, input.currency, input.message],
    );
    tipId = existing.id;
    reuseOfDeadOrder = true;
  } else {
    const { rows: insertedRows } = await query<{ id: string }>(
      `insert into tips
         (bill_id, agreement_id, from_member_id, to_member_id, amount, currency,
          message, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'proposed')
       on conflict (bill_id, from_member_id) do nothing
       returning id`,
      [
        input.billId,
        input.agreementId,
        input.fromMember.id,
        input.toMemberId,
        input.amountMinor,
        input.currency,
        input.message,
      ],
    );

    const created = insertedRows[0];
    if (!created) {
      // A concurrent request won the insert; let it answer this one.
      throw ApiError.conflict(
        'tip_in_progress',
        'A tip for this bill is already being set up — try again',
      );
    }
    tipId = created.id;
  }

  const order = await createOrder({
    target: { kind: 'tip', id: tipId },
    amountMinor: gross,
    currency: input.currency,
    description: `Globie Keeper — tip for ${input.toMemberName}${
      input.merchant ? ` · ${input.merchant}` : ''
    }`,
    payee: { email: payeeEmail, merchantId: payeeMerchantId },
    requestId: reuseOfDeadOrder
      ? `globie-tip-${tipId}-${randomUUID()}`
      : undefined,
  });

  await withTransaction(async (tx) => {
    await tx.query(
      `update tips
          set status = 'requested',
              paypal_order_id = $2,
              paypal_approve_url = $3,
              fee_minor = $4,
              gross_minor = $5
        where id = $1 and status in ('proposed', 'failed', 'refunded')`,
      [tipId, order.id, order.approveUrl, fee, gross],
    );

    await recordEvent(tx, {
      groupId: input.groupId,
      agreementId: input.agreementId,
      memberId: input.fromMember.id,
      eventType: 'tip.requested',
      amountMinor: input.amountMinor,
      currency: input.currency,
      actor: input.fromMember.displayName,
      summary: `${input.fromMember.displayName} is tipping ${input.toMemberName}`,
      metadata: { tip_id: tipId, to_member_id: input.toMemberId },
    });
  });

  return {
    tipId,
    status: 'requested',
    paypalOrderId: order.id,
    approveUrl: order.approveUrl,
    amountMinor: input.amountMinor,
    feeMinor: fee,
    grossMinor: gross,
    currency: input.currency,
    alreadyRequested: false,
  };
}

export type SettleTipInput = {
  tipId: string;
  orderId: string | null;
  captureId: string | null;
  payload: unknown;
  actor: string;
};

export type SettleTipResult = {
  tipId: string;
  alreadyPaid: boolean;
  pointsAwarded: number;
  /** PayPal's own rate, when the payer's currency differed from the bill's. */
  settledRate: SettledRate | null;
  /** Fee snapshot (DEV_PLAN §2.20); `gross` is what PayPal actually asked for. */
  feeMinor: number;
  grossMinor: number;
};

/**
 * Mark a tip paid. Same advisory lock as `settleShare` so a replayed webhook and
 * a retried capture cannot award Globie twice.
 */
export async function settleTip(input: SettleTipInput): Promise<SettleTipResult> {
  return withTransaction(async (tx) => {
    const preview = await loadTip(tx, input.tipId);
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      preview.agreement_id,
    ]);

    const tip = await loadTip(tx, input.tipId, true);

    if (tip.status === 'paid') {
      if (input.captureId) {
        await tx.query(
          `update tips
              set paypal_capture_id = coalesce(paypal_capture_id, $2)
            where id = $1`,
          [tip.id, input.captureId],
        );
      }
      return {
        tipId: tip.id,
        alreadyPaid: true,
        pointsAwarded: 0,
        settledRate: null,
        feeMinor: tip.fee_minor ?? 0,
        grossMinor: tip.gross_minor ?? tip.amount,
      };
    }

    const currency = tip.currency.trim();
    const settledRate = extractSettledRate(input.payload);

    await tx.query(
      `update tips
          set status = 'paid',
              paid_at = now(),
              paypal_order_id = coalesce(paypal_order_id, $2),
              paypal_capture_id = coalesce($3, paypal_capture_id)
        where id = $1`,
      [tip.id, input.orderId, input.captureId],
    );

    const globie = await awardGlobie(tx, {
      agreementId: tip.agreement_id,
      groupId: tip.group_id,
      memberId: tip.from_member_id,
      shareId: null,
      reason: TIP_REASON,
      amount: TIP_GLOBIE,
    });

    await recordEvent(tx, {
      groupId: tip.group_id,
      agreementId: tip.agreement_id,
      memberId: tip.from_member_id,
      eventType: 'tip.paid',
      amountMinor: tip.amount,
      currency,
      actor: tip.from_member_name,
      summary:
        globie.delta > 0
          ? `${tip.from_member_name} tipped ${tip.to_member_name} — +${globie.delta} Globie`
          : `${tip.from_member_name} tipped ${tip.to_member_name}`,
      metadata: {
        tip_id: tip.id,
        to_member_id: tip.to_member_id,
        message: tip.message,
        globie: globie.delta,
        ...(settledRate ? { fx_rate: settledRate } : {}),
      },
    });

    return {
      tipId: tip.id,
      alreadyPaid: false,
      pointsAwarded: globie.delta,
      settledRate,
      feeMinor: tip.fee_minor ?? 0,
      grossMinor: tip.gross_minor ?? tip.amount,
    };
  });
}

/** PayPal declined the capture: the member may re-request the tip. */
export async function failTip(input: {
  tipId: string;
  actor: string;
  /** Why it died, when it was not a captured-then-denied payment. */
  reason?: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const tip = await loadTip(tx, input.tipId, true);
    if (['paid', 'refunded'].includes(tip.status)) return;

    await tx.query(
      `update tips set status = 'failed'
        where id = $1 and status in ('proposed', 'requested', 'failed')`,
      [tip.id],
    );

    await recordEvent(tx, {
      groupId: tip.group_id,
      agreementId: tip.agreement_id,
      memberId: tip.from_member_id,
      eventType: 'tip.failed',
      amountMinor: tip.amount,
      currency: tip.currency.trim(),
      actor: input.actor,
      summary: input.reason
        ? `${tip.from_member_name}'s tip for ${tip.to_member_name} ${input.reason}`
        : `PayPal declined ${tip.from_member_name}'s tip for ${tip.to_member_name}`,
      metadata: { tip_id: tip.id },
    });
  });
}

/**
 * How long an unapproved PayPal checkout may sit before it counts as dead. The
 * browser is the only place a checkout can be approved, so a row that is still
 * unapproved this long after it was opened was abandoned or refused; waiting
 * longer just leaves the card saying "waiting for approval".
 */
const CHECKOUT_TTL_MS = 5 * 60 * 1000;

/**
 * A checkout PayPal refuses at its own page never comes back to us: PayPal
 * shows a generic error instead of the return (or cancel) URL, so no capture
 * runs and no webhook fires. The row would sit in `requested` forever and the
 * card would keep saying "waiting for approval". Re-read the order when the
 * tipping member loads the bill, close the dead checkouts and report whether
 * PayPal holds an approval we can still capture.
 */
export async function reconcileTip(tip: {
  id: string;
  status: string;
  paypal_order_id: string | null;
  created_at: Date;
}): Promise<{ status: string; canFinish: boolean }> {
  if (
    tip.status !== 'requested' ||
    !tip.paypal_order_id ||
    !isPayPalConfigured()
  ) {
    return { status: tip.status, canFinish: false };
  }

  const order = await readOrder(tip.paypal_order_id).catch(() => null);
  if (!order) return { status: tip.status, canFinish: false };

  if (order.status === 'APPROVED' || order.status === 'COMPLETED') {
    return { status: tip.status, canFinish: true };
  }

  const stale = Date.now() - new Date(tip.created_at).getTime() > CHECKOUT_TTL_MS;
  if (order.status === 'VOIDED' || stale) {
    await failTip({
      tipId: tip.id,
      actor: 'PayPal',
      reason: 'did not go through — the PayPal checkout was not completed',
    });
    return { status: 'failed', canFinish: false };
  }

  return { status: tip.status, canFinish: false };
}

/**
 * A refund marks the tip dead — PayPal moves the money back from the fronter's
 * account — and reverses the Globie it earned.
 */
export async function reverseTip(input: {
  tipId: string;
  actor: string;
}): Promise<void> {
  await withTransaction(async (tx) => {
    const preview = await loadTip(tx, input.tipId);
    await tx.query('select pg_advisory_xact_lock(hashtext($1))', [
      preview.agreement_id,
    ]);

    const tip = await loadTip(tx, input.tipId, true);
    if (tip.status !== 'paid') return;

    await tx.query(`update tips set status = 'refunded' where id = $1`, [tip.id]);

    const { rows: reversedRows } = await tx.query<{ delta: number }>(
      `delete from points_awards
        where agreement_id = $1 and member_id = $2 and reason = $3
        returning delta`,
      [tip.agreement_id, tip.from_member_id, TIP_REASON],
    );
    const reversed = reversedRows[0]?.delta ?? 0;

    if (reversed > 0) {
      await tx.query(
        `insert into points_events (group_id, member_id, delta, reason, agreement_id, share_id)
         values ($1, $2, $3, 'tip.refund', $4, null)`,
        [tip.group_id, tip.from_member_id, -reversed, tip.agreement_id],
      );
    }

    await recordEvent(tx, {
      groupId: tip.group_id,
      agreementId: tip.agreement_id,
      memberId: tip.from_member_id,
      eventType: 'tip.refunded',
      amountMinor: tip.amount,
      currency: tip.currency.trim(),
      actor: input.actor,
      summary: `${tip.from_member_name}'s tip for ${tip.to_member_name} was refunded${
        reversed > 0 ? ` — ${reversed} Globie reversed` : ''
      }`,
      metadata: { tip_id: tip.id, globie: -reversed },
    });
  });
}
