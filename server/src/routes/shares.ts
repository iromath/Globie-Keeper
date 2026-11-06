/**
 * Member-facing payment actions. Approving happens in the system browser;
 * this captures the order server-side and settles the share immediately, so the
 * UI does not have to wait for the webhook to arrive.
 */

import type { FastifyPluginAsync } from 'fastify';

import { requireShareMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, isPayPalConfigured } from '../lib/paypal.js';
import { settleShare } from '../lib/settlement.js';
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

    const capture = await captureOrder(ctx.paypalOrderId);
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
