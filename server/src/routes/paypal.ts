/**
 * PayPal webhook receiver (DEV_PLAN §2.9). PayPal is the source of truth for
 * whether money moved, so this endpoint verifies the signature, dedupes on the
 * event id, audits every delivery and hands the money work to lib/settlement.ts.
 */

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';

import { query } from '../db/pool.js';
import { config, isProduction } from '../lib/config.js';
import { failDonation, reverseDonation, settleDonation } from '../lib/donation.js';
import { ApiError } from '../lib/http-error.js';
import {
    toMinorAmount,
    verifyWebhookSignature,
    type WebhookHeaders,
} from '../lib/paypal.js';
import { failShare, reverseShare, settleShare } from '../lib/settlement.js';
import { failTip, reverseTip, settleTip } from '../lib/tips.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Raw bytes, kept so PayPal signatures can be verified and audited. */
    rawBody?: Buffer;
  }
}

type PaymentResource = {
  id?: string;
  status?: string;
  amount?: { currency_code?: string; value?: string };
  supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
};

type PayPalEvent = {
  id?: string;
  event_type?: string;
  resource_type?: string;
  resource?: PaymentResource;
};

type ShareLookup = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  /** What the payer was asked for when fee coverage was on (DEV_PLAN §2.20). */
  gross_minor: number | null;
};

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function transmissionHeaders(request: FastifyRequest): WebhookHeaders {
  return {
    transmissionId: headerValue(request, 'paypal-transmission-id'),
    transmissionTime: headerValue(request, 'paypal-transmission-time'),
    transmissionSig: headerValue(request, 'paypal-transmission-sig'),
    certUrl: headerValue(request, 'paypal-cert-url'),
    authAlgo: headerValue(request, 'paypal-auth-algo'),
  };
}

/** Find the share either by its order id or by the capture id of a refund. */
async function findShare(candidates: string[]): Promise<ShareLookup | null> {
  const ids = candidates.filter((value) => value.length > 0);
  if (ids.length === 0) return null;

  const { rows } = await query<ShareLookup>(
    `select id, amount, currency, status, gross_minor
       from shares
      where paypal_order_id = any($1::text[])
         or paypal_capture_id = any($1::text[])
      order by paid_at desc nulls last
      limit 1`,
    [ids],
  );

  return rows[0] ?? null;
}

type TipLookup = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  gross_minor: number | null;
};

/** A tip is its own row, so it is looked up separately from the share. */
async function findTip(candidates: string[]): Promise<TipLookup | null> {
  const ids = candidates.filter((value) => value.length > 0);
  if (ids.length === 0) return null;

  const { rows } = await query<TipLookup>(
    `select id, amount, currency, status, gross_minor
       from tips
      where paypal_order_id = any($1::text[])
         or paypal_capture_id = any($1::text[])
      order by paid_at desc nulls last
      limit 1`,
    [ids],
  );

  return rows[0] ?? null;
}

type DonationLookup = {
  id: string;
  amount: number;
  currency: string;
  status: string;
  gross_minor: number | null;
};

/** A gift to the Globie Fund is its own row too (DEV_PLAN §2.21). */
async function findDonation(candidates: string[]): Promise<DonationLookup | null> {
  const ids = candidates.filter((value) => value.length > 0);
  if (ids.length === 0) return null;

  const { rows } = await query<DonationLookup>(
    `select id, amount_minor as amount, currency, status, gross_minor
       from donations
      where paypal_order_id = any($1::text[])
         or paypal_capture_id = any($1::text[])
      order by paid_at desc nulls last
      limit 1`,
    [ids],
  );

  return rows[0] ?? null;
}

export const paypalRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Always answer 2xx for deliveries we understand (including duplicates and
   * events we do not act on), otherwise PayPal keeps retrying for days.
   */
  app.post('/paypal/webhook', async (request, reply) => {
    const event = (request.body ?? {}) as PayPalEvent;
    const eventId = typeof event.id === 'string' ? event.id : '';
    const eventType = typeof event.event_type === 'string' ? event.event_type : '';

    if (!eventId || !eventType) {
      throw ApiError.badRequest(
        'invalid_webhook',
        'The webhook has no id or event type',
      );
    }

    if (config.paypalWebhookId) {
      const verified = await verifyWebhookSignature({
        headers: transmissionHeaders(request),
        event,
      });

      if (!verified) {
        request.log.warn({ eventId, eventType }, 'paypal webhook signature rejected');
        throw ApiError.badRequest(
          'invalid_signature',
          'The webhook signature could not be verified',
        );
      }
    } else if (isProduction) {
      throw new ApiError(
        503,
        'paypal_webhook_unconfigured',
        'PAYPAL_WEBHOOK_ID is not configured on this server',
      );
    } else {
      // Sandbox replay without a registered webhook id: accept, but the audit
      // row stays `verified = false` so it is obvious what happened.
      request.log.warn({ eventId, eventType }, 'paypal webhook accepted unverified (dev)');
    }

    const seen = await query<{ provider_event_id: string }>(
      `select provider_event_id from webhook_receipts
        where provider = 'paypal' and provider_event_id = $1`,
      [eventId],
    );

    if (seen.rows.length > 0) {
      return { ok: true, duplicate: true };
    }

    await query(
      `insert into webhook_events
         (provider, provider_event_id, event_type, payload, verified)
       values ('paypal', $1, $2, $3::jsonb, $4)`,
      [eventId, eventType, JSON.stringify(event), Boolean(config.paypalWebhookId)],
    );

    const resource = event.resource ?? {};
    const captureId =
      eventType.startsWith('PAYMENT.CAPTURE.') && resource.id ? resource.id : null;
    const orderId =
      resource.supplementary_data?.related_ids?.order_id ??
      (eventType.startsWith('CHECKOUT.ORDER.') ? resource.id ?? null : null);

    const candidates = [orderId ?? '', captureId ?? '', resource.id ?? ''];

    // PayPal echoes the amount; recompute it in minor units instead of trusting
    // the number as sent. A mismatch is a real problem, so do not move money.
    // A grossed-up order (DEV_PLAN §2.20) is checked against what the payer was
    // actually asked for, otherwise a correctly paid share looks short.
    const amountMatches = (row: {
      amount: number;
      currency: string;
      gross_minor: number | null;
    }): boolean => {
      const currency = row.currency.trim();
      const eventCurrency = resource.amount?.currency_code?.trim();
      const eventAmount = toMinorAmount(resource.amount?.value, currency);
      const expected = row.gross_minor ?? row.amount;

      return !(
        (eventCurrency && eventCurrency !== currency) ||
        (eventAmount !== null && eventAmount !== expected)
      );
    };

    const share = await findShare(candidates);

    if (share) {
      if (!amountMatches(share)) {
        request.log.error(
          { eventId, eventType, shareId: share.id, resource: resource.amount },
          'paypal webhook amount does not match the share',
        );
        await markReceived(eventId);
        return { ok: true, ignored: 'amount_mismatch' };
      }

      switch (eventType) {
        case 'PAYMENT.CAPTURE.COMPLETED': {
          const result = await settleShare({
            shareId: share.id,
            orderId,
            captureId,
            payload: event,
            actor: 'PayPal',
          });
          await markReceived(eventId);
          return { ok: true, settled: result };
        }

        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          await failShare({ shareId: share.id, actor: 'PayPal' });
          await markReceived(eventId);
          return { ok: true, failed: share.id };
        }

        case 'PAYMENT.CAPTURE.REFUNDED':
        case 'PAYMENT.CAPTURE.REVERSED': {
          await reverseShare({ shareId: share.id, actor: 'PayPal' });
          await markReceived(eventId);
          return { ok: true, refunded: share.id };
        }

        default: {
          // Approval, authorization and order events need no state change here.
          await markReceived(eventId);
          return { ok: true, ignored: eventType };
        }
      }
    }

    // No share matched, so this may be a tip: same contract, different table.
    const tip = await findTip(candidates);

    if (tip) {
      if (!amountMatches(tip)) {
        request.log.error(
          { eventId, eventType, tipId: tip.id, resource: resource.amount },
          'paypal webhook amount does not match the tip',
        );
        await markReceived(eventId);
        return { ok: true, ignored: 'amount_mismatch' };
      }

      switch (eventType) {
        case 'PAYMENT.CAPTURE.COMPLETED': {
          const result = await settleTip({
            tipId: tip.id,
            orderId,
            captureId,
            payload: event,
            actor: 'PayPal',
          });
          await markReceived(eventId);
          return { ok: true, tip: result };
        }

        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          await failTip({ tipId: tip.id, actor: 'PayPal' });
          await markReceived(eventId);
          return { ok: true, failed: tip.id };
        }

        case 'PAYMENT.CAPTURE.REFUNDED':
        case 'PAYMENT.CAPTURE.REVERSED': {
          await reverseTip({ tipId: tip.id, actor: 'PayPal' });
          await markReceived(eventId);
          return { ok: true, refunded: tip.id };
        }

        default: {
          await markReceived(eventId);
          return { ok: true, ignored: eventType };
        }
      }
    }

    // Still nothing, so this may be a gift to the Globie Fund.
    const donation = await findDonation(candidates);

    if (donation) {
      if (!amountMatches(donation)) {
        request.log.error(
          { eventId, eventType, donationId: donation.id, resource: resource.amount },
          'paypal webhook amount does not match the donation',
        );
        await markReceived(eventId);
        return { ok: true, ignored: 'amount_mismatch' };
      }

      switch (eventType) {
        case 'PAYMENT.CAPTURE.COMPLETED': {
          const result = await settleDonation(donation.id, { captureId });
          await markReceived(eventId);
          return { ok: true, donation: { id: result.id, mcpStatus: result.mcp_status } };
        }

        case 'PAYMENT.CAPTURE.DENIED':
        case 'PAYMENT.CAPTURE.DECLINED': {
          await failDonation(donation.id);
          await markReceived(eventId);
          return { ok: true, failed: donation.id };
        }

        case 'PAYMENT.CAPTURE.REFUNDED':
        case 'PAYMENT.CAPTURE.REVERSED': {
          await reverseDonation(donation.id);
          await markReceived(eventId);
          return { ok: true, refunded: donation.id };
        }

        default: {
          await markReceived(eventId);
          return { ok: true, ignored: eventType };
        }
      }
    }

    request.log.warn(
      { eventId, eventType },
      'paypal webhook matched no share, tip or donation',
    );
    await markReceived(eventId);
    return { ok: true, ignored: 'share_not_found' };
  });
};

async function markReceived(eventId: string): Promise<void> {
  await query(
    `insert into webhook_receipts (provider, provider_event_id)
     values ('paypal', $1)
     on conflict (provider, provider_event_id) do nothing`,
    [eventId],
  );
}
