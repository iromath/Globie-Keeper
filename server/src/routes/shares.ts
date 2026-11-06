/**
 * Member-facing payment actions. Approving happens in the system browser;
 * this captures the order server-side and settles the share immediately, so the
 * UI does not have to wait for the webhook to arrive.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requireShareMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, isPayPalConfigured, readOrder } from '../lib/paypal.js';
import { failShare, settleShare } from '../lib/settlement.js';
import { pathUuid } from '../lib/validate.js';

type ShareParams = { Params: { id: string } };

export const shareRoutes: FastifyPluginAsync = async (app) => {
  app.post<ShareParams>('/shares/:id/capture', async (request) => {
    const shareId = pathUuid(request.params.id);
    const ctx = await requireShareMember(request, shareId);

    if (ctx.status === 'paid' || ctx.status === 'settled') {
      return {
        shareId,
        status: ctx.status,
        alreadyPaid: true,
        captureId: null,
        pointsAwarded: 0,
        rank: null,
        billSettled: false,
        settledRate: null,
      };
    }

    if (!ctx.paypalOrderId) {
      throw ApiError.conflict(
        'payment_not_requested',
        'This share has no PayPal order yet',
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
      // the share would sit on "Payment requested" until the TTL expires. The
      // payer is here, right after the browser closed, so an order that is still
      // unapproved now is a dead checkout, not a slow one.
      const order = await readOrder(ctx.paypalOrderId).catch(() => null);
      if (order && order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
        await failShare({
          shareId,
          actor: ctx.member.displayName,
          reason: 'did not go through — the PayPal checkout was not completed',
        });
        throw ApiError.conflict(
          'share_checkout_incomplete',
          'PayPal did not complete this payment, so nothing was charged — ask the fronter to request it again',
        );
      }
      throw cause;
    }

    const result = await settleShare({
      shareId,
      orderId: ctx.paypalOrderId,
      captureId: capture.captureId,
      payload: capture.raw,
      actor: ctx.member.displayName,
    });

    return {
      shareId,
      status: 'paid' as const,
      alreadyPaid: result.alreadyPaid,
      captureId: capture.captureId,
      pointsAwarded: result.pointsAwarded,
      rank: result.rank,
      billSettled: result.billSettled,
      settledRate: result.settledRate,
    };
  });
};
