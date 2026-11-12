/**
 * Member-facing payment actions. Approving happens in the system browser;
 * this captures the order server-side and settles the share immediately, so the
 * UI does not have to wait for the webhook to arrive.
 *
 * PayPal.Me requests have no order to capture: PayPal never tells us the payer
 * paid, so the payer confirms it and we record the settlement ourselves.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requireShareMember } from '../lib/access.js';
import { p2pRef } from '../lib/bills.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, isOrderMissing, isPayPalConfigured, readOrder } from '../lib/paypal.js';
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
      let order: Awaited<ReturnType<typeof readOrder>> | null = null;
      try {
        order = await readOrder(ctx.paypalOrderId);
      } catch (readCause) {
        // PayPal dropped the order (expired checkout) — that is a dead checkout
        // too. A read that fails for any other reason says nothing about the
        // order, so keep the original capture error.
        if (!isOrderMissing(readCause)) throw cause;
      }
      if (!order || (order.status !== 'APPROVED' && order.status !== 'COMPLETED')) {
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

  /**
   * The payer says they sent the money through the fronter's PayPal.Me link.
   * Nothing else can know: a PayPal.Me transfer has no order to read back, so
   * this confirmation is the only signal that the share is settled.
   */
  app.post<ShareParams>('/shares/:id/paid', async (request) => {
    const shareId = pathUuid(request.params.id);
    const ctx = await requireShareMember(request, shareId);

    if (ctx.status === 'paid' || ctx.status === 'settled') {
      return {
        shareId,
        status: ctx.status,
        alreadyPaid: true,
        pointsAwarded: 0,
        rank: null,
        billSettled: false,
        settledRate: null,
      };
    }

    if (ctx.paymentMode !== 'paypal_me') {
      throw ApiError.conflict(
        'payment_not_paypal_me',
        'Only a PayPal.Me request can be confirmed by hand — finish the PayPal checkout instead',
      );
    }

    if (ctx.status !== 'requested') {
      throw ApiError.conflict(
        'payment_not_requested',
        'This share has no PayPal.Me request yet',
      );
    }

    const result = await settleShare({
      shareId,
      orderId: null,
      captureId: p2pRef(shareId),
      payload: {
        source: 'paypal_me',
        confirmedBy: ctx.member.displayName,
        confirmedAt: new Date().toISOString(),
      },
      actor: ctx.member.displayName,
    });

    return {
      shareId,
      status: 'paid' as const,
      alreadyPaid: result.alreadyPaid,
      captureId: null,
      pointsAwarded: result.pointsAwarded,
      rank: result.rank,
      billSettled: result.billSettled,
      settledRate: result.settledRate,
    };
  });
};
