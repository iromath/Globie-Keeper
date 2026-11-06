/**
 * "Give a tip" (DEV_PLAN §2.18). Anyone in the group may tip the person who
 * fronted the bill; the tip is captured server-side like a share, but it never
 * touches the bill's settlement state.
 */

import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { requireBillMember, requireTipMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, isPayPalConfigured } from '../lib/paypal.js';
import { mapTip } from '../lib/serialize.js';
import { listTips, requestTip, settleTip } from '../lib/tips.js';
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

/**
 * Who fronted the agreement and what to call them. `fronted_by` is set when the
 * agreement is created; falling back to `created_by` keeps older rows tippable.
 */
async function loadFronter(
  agreementId: string,
): Promise<{ id: string | null; name: string }> {
  const { rows } = await query<{ fronted_by: string | null; fronted_name: string }>(
    `select a.fronted_by,
            coalesce(fu.display_name, cu.display_name) as fronted_name
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
  };
}

export const tipRoutes: FastifyPluginAsync = async (app) => {
  app.get<BillParams>('/bills/:id/tips', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    const fronter = await loadFronter(ctx.agreementId);
    const tips = (await listTips(billId)).map(mapTip);

    return {
      billId,
      currency: ctx.currency,
      frontedBy: fronter.id,
      frontedByName: fronter.name,
      canTip: TIPPABLE.has(ctx.status) && fronter.id !== ctx.member.id,
      totalMinor: tips
        .filter((tip) => tip.status === 'paid')
        .reduce((sum, tip) => sum + tip.amountMinor, 0),
      myTip: tips.find((tip) => tip.fromMemberId === ctx.member.id) ?? null,
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

    const capture = await captureOrder(ctx.paypalOrderId);
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
