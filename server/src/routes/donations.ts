/**
 * The Globie Fund (DEV_PLAN §2.21). A donation belongs to a person, not a
 * group, so every route here uses `requireUser` and never touches access.ts.
 *
 * Two rails: a PayPal order paid into the fund account, and a redemption of
 * Globie points at 1000 points = US$1.
 */

import type { FastifyPluginAsync } from 'fastify';

import {
  failDonation,
  listDonations,
  listSpecies,
  mapDonation,
  pointsBalanceForUser,
  readDonation,
  redeemPoints,
  startDonation,
  tryAdopt,
} from '../lib/donation.js';
import { ApiError } from '../lib/http-error.js';
import { captureOrder, readOrder } from '../lib/paypal.js';
import { settleDonation } from '../lib/donation.js';
import { asRecord, optionalString, pathUuid, requiredMinor, requiredString } from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';
import { config } from '../lib/config.js';

type DonationParams = { Params: { id: string } };

async function ownedDonation(userId: string, id: string) {
  const row = await readDonation(id);
  if (!row) throw ApiError.notFound('Donation not found');
  if (row.user_id !== userId) throw ApiError.forbidden('This donation is not yours');
  return row;
}

export const donationRoutes: FastifyPluginAsync = async (app) => {
  /** The sanctuary catalogue, trimmed for the picker. */
  app.get('/donations/species', async () => {
    const species = await listSpecies();
    return {
      species,
      currency: config.globieFundCurrency,
      pointsPerUsd: config.pointsPerUsd,
      minMinor: config.donationMinMinor,
      maxMinor: config.donationMaxMinor,
    };
  });

  /** The member's giving history, totals and spendable Globie. */
  app.get('/donations', async (request) => {
    const auth = requireUser(request);
    const [history, pointsBalance] = await Promise.all([
      listDonations(auth.userId),
      pointsBalanceForUser(auth.userId),
    ]);
    return {
      donations: history.donations.map(mapDonation),
      totalMinor: history.totalMinor,
      treesAdopted: history.treesAdopted,
      currency: history.currency,
      pointsBalance,
      pointsPerUsd: config.pointsPerUsd,
    };
  });

  /** Open a donation on either rail. */
  app.post('/donations', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const method = requiredString(body, 'method', { min: 4, max: 10 });
    if (method !== 'paypal' && method !== 'points') {
      throw ApiError.badRequest('invalid_method', 'method must be paypal or points');
    }

    const speciesId = requiredString(body, 'speciesId', { min: 1, max: 100 });
    const speciesName = optionalString(body, 'speciesName', 160);
    const quantityRaw = requiredMinor(body, 'quantity');
    if (quantityRaw < 1 || quantityRaw > 1000) {
      throw ApiError.badRequest('invalid_quantity', 'quantity must be between 1 and 1000');
    }

    if (method === 'paypal') {
      const amountMinor = requiredMinor(body, 'amountMinor');
      const donation = await startDonation({
        userId: auth.userId,
        speciesId,
        speciesName,
        quantity: quantityRaw,
        amountMinor,
      });
      return { donation: mapDonation(donation), approveUrl: donation.approveUrl };
    }

    const points = requiredMinor(body, 'points');
    const donation = await redeemPoints({
      userId: auth.userId,
      speciesId,
      speciesName,
      quantity: quantityRaw,
      points,
    });
    return { donation: mapDonation(donation), approveUrl: null };
  });

  /**
   * Resume a PayPal donation after the browser closes. Safe to retry: PayPal
   * answers `ORDER_ALREADY_CAPTURED` and we read the existing capture.
   */
  app.post<DonationParams>('/donations/:id/capture', async (request) => {
    const auth = requireUser(request);
    const donationId = pathUuid(request.params.id);
    const row = await ownedDonation(auth.userId, donationId);

    if (row.status === 'paid') {
      return { donation: mapDonation(row), alreadyPaid: true };
    }
    if (row.method !== 'paypal' || !row.paypal_order_id) {
      throw ApiError.conflict('payment_not_requested', 'This donation has no PayPal order');
    }

    let capture;
    try {
      capture = await captureOrder(row.paypal_order_id);
    } catch (cause) {
      // A checkout PayPal refused at its own page never returns to us. The
      // payer is here right after the browser closed, so an unapproved order
      // now is a dead checkout, not a slow one.
      const order = await readOrder(row.paypal_order_id).catch(() => null);
      if (order && order.status !== 'APPROVED' && order.status !== 'COMPLETED') {
        await failDonation(donationId);
        throw ApiError.conflict(
          'donation_checkout_incomplete',
          'PayPal did not complete this donation, so nothing was charged',
        );
      }
      throw cause;
    }

    const settled = await settleDonation(donationId, { captureId: capture.captureId });
    return { donation: mapDonation(settled), alreadyPaid: false };
  });

  /** Write a pending adoption again after the sanctuary was unreachable. */
  app.post<DonationParams>('/donations/:id/retry-adoption', async (request) => {
    const auth = requireUser(request);
    const donationId = pathUuid(request.params.id);
    const row = await ownedDonation(auth.userId, donationId);

    if (row.status !== 'paid') {
      throw ApiError.conflict('donation_not_paid', 'Only a paid donation can adopt a tree');
    }
    const adopted = await tryAdopt(row);
    return { donation: mapDonation(adopted) };
  });
};
