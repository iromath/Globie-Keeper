/**
 * "Give a tip" (DEV_PLAN §2.18). Anyone in the group may tip the person who
 * fronted the bill; the tip is captured server-side like a share, but it never
 * touches the bill's settlement state.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { requireBillMember, requireTipMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, isPayPalConfigured, readOrder } from '../lib/paypal.js';
import { mapTip } from '../lib/serialize.js';
import {
    failTip,
    listTips,
    loadFronter,
    reconcileTip,
    requestTip,
    settleTip
} from '../lib/tips.js';
import {
    asRecord,
    optionalString,
    pathUuid,
    requiredMinor,
} from '../lib/validate.js';

/** The fronter has already paid, so a tip is only meaningful from here on. */
const TIPPABLE = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);

type BillParams = { Params: { id: string } };
type TipParams = { Params: { id: string } };

export const tipRoutes: FastifyPluginAsync = async (app) => {
  app.get<BillParams>('/bills/:id/tips', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const fronter = await loadFronter(ctx.agreementId);

    // Only the caller's own pending tip costs a PayPal round-trip; a declined
    // checkout is closed here so the card can offer a retry (see reconcileTip).
    const { rows: mineRows } = await query<{
      id: string;
      status: string;
      paypal_order_id: string | null;
      created_at: Date;
    }>(
      `select id, status, paypal_order_id, created_at
         from tips where bill_id = $1 and from_member_id = $2`,
      [billId, ctx.member.id],
    );
    const mine = mineRows[0];
    const payment = mine ? await reconcileTip(mine) : null;

    const tips = (await listTips(billId)).map(mapTip);
    const myTip = tips.find((tip) => tip.fromMemberId === ctx.member.id) ?? null;

    return {
      billId,
      currency: ctx.currency,
      frontedBy: fronter.id,
      frontedByName: fronter.name,
      canTip: TIPPABLE.has(ctx.status) && fronter.id !== ctx.member.id,
      totalMinor: tips
        .filter((tip) => tip.status === 'paid')
        .reduce((sum, tip) => sum + tip.amountMinor, 0),
      myTip: myTip
        ? {
            ...myTip,
            canFinish: (payment?.canFinish ?? false) && myTip.status === 'requested',
          }
        : null,
      tips,
    };
  });

  app.post<BillParams>('/bills/:id/tips', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const body = asRecord(request.body);

    if (!TIPPABLE.has(ctx.status)) {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Tips open once the bill is finalized and the fronter has paid',
      );
    }

    const fronter = await loadFronter(ctx.agreementId);

    if (!fronter.id) {
      throw ApiError.conflict(
        'fronter_missing',
        'This bill has no fronter to tip',
      );
    }

    if (fronter.id === ctx.member.id) {
      throw ApiError.conflict(
        'cannot_tip_self',
        'You fronted this bill — you cannot tip yourself',
      );
    }

    const amountMinor = requiredMinor(body, 'amountMinor');
    if (amountMinor <= 0) {
      throw ApiError.badRequest('invalid_amountMinor', 'A tip must be above zero');
    }

    const { rows: billRows } = await query<{ merchant: string | null }>(
      `select merchant from bills where id = $1`,
      [billId],
    );

    return requestTip({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      currency: ctx.currency,
      merchant: billRows[0]?.merchant ?? null,
      fromMember: { id: ctx.member.id, displayName: ctx.member.displayName },
      toMemberId: fronter.id,
      toMemberName: fronter.name,
      amountMinor,
      message: optionalString(body, 'message', 200),
    });
  });

  app.post<TipParams>('/tips/:id/capture', async (request) => {
    const tipId = pathUuid(request.params.id);
    const ctx = await requireTipMember(request, tipId);

    if (ctx.status === 'paid') {
      return {
        tipId,
        status: 'paid' as const,
        alreadyPaid: true,
        captureId: null,
        pointsAwarded: 0,
        settledRate: null,
      };
    }

    if (!ctx.paypalOrderId) {
      throw ApiError.conflict(
        'payment_not_requested',
        'This tip has no PayPal order yet',
      );
    }

    if (!isPayPalConfigured()) {
      throw ApiError.conflict(
        'paypal_not_configured',
        'PayPal sandbox credentials are not configured on this server',
      );
    }

    let capture: Awaited<ReturnType<typeof captureOrder>>;
    try {
      capture = await captureOrder(ctx.paypalOrderId);
    } catch (cause) {
      // A checkout PayPal refuses at its own page never comes back to us: it
      // shows a generic error instead of the return URL, so no webhook fires and
      // the row would sit on "waiting for approval" until the TTL expires. The
      // payer is here, right after the browser closed, so an order that is still
      // unapproved now is a dead checkout, not a slow one.
      const order = await readOrder(ctx.paypalOrderId).catch(() => null);
      if (order && order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
        await failTip({
          tipId,
          actor: ctx.member.displayName,
          reason: 'did not go through — the PayPal checkout was not completed',
        });
        throw ApiError.conflict(
          'tip_checkout_incomplete',
          'PayPal did not complete this payment, so nothing was charged — you can try again',
        );
      }
      throw cause;
    }

    const result = await settleTip({
      tipId,
      orderId: ctx.paypalOrderId,
      captureId: capture.captureId,
      payload: capture.raw,
      actor: ctx.member.displayName,
    });

    return {
      tipId,
      status: 'paid' as const,
      alreadyPaid: result.alreadyPaid,
      captureId: capture.captureId,
      pointsAwarded: result.pointsAwarded,
      settledRate: result.settledRate,
    };
  });
};
