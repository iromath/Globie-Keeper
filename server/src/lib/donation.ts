/**
 * The Globie Fund (DEV_PLAN §2.21): donate to adopt a tree, with PayPal or with
 * Globie points (1000 points = US$1).
 *
 * A donation is deliberately group-free. The PayPal rail is an Orders v2
 * checkout whose payee is the fund account, so the money never lands with the
 * donor or the platform. The points rail debits `points_awards` and settles
 * immediately — no PayPal round trip.
 *
 * Adoption on the sanctuary MCP always runs *after* the gift is committed. A
 * refusal there must never unwind a payment; it leaves `mcp_status='pending'`
 * for the retry route.
 */

import { query, withTransaction, type Db } from '../db/pool.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';
import { adoptSpecies, deviceIdForUser, searchForestKnowledge } from './mcp.js';
import { createOrder, currencyExponent, isPayPalConfigured, type Payee } from './paypal.js';

export const DONATION_REASON = 'donation';

/** One point is one tenth of a cent at 1000 points per US$1. */
const POINTS_PER_CENT = config.pointsPerUsd / 100;

export type DonationMethod = 'paypal' | 'points';

export type DonationRow = {
  id: string;
  user_id: string;
  method: DonationMethod;
  amount_minor: number;
  currency: string;
  points_spent: number;
  species_id: string;
  species_name: string | null;
  quantity: number;
  status: 'proposed' | 'requested' | 'paid' | 'refunded' | 'failed';
  paypal_order_id: string | null;
  paypal_capture_id: string | null;
  paypal_approve_url: string | null;
  gross_minor: number | null;
  mcp_status: 'none' | 'pending' | 'adopted' | 'failed';
  mcp_deed_no: string | null;
  mcp_error: string | null;
  paid_at: Date | null;
  created_at: Date;
};

export type DonationSpecies = {
  id: string;
  name: string;
  latin: string | null;
  status: 'critical' | 'urgent' | null;
  blurb: string;
};

export function mapDonation(row: DonationRow) {
  return {
    id: row.id,
    method: row.method,
    amountMinor: row.amount_minor,
    currency: row.currency.trim(),
    pointsSpent: row.points_spent,
    speciesId: row.species_id,
    speciesName: row.species_name,
    quantity: row.quantity,
    status: row.status,
    paypalOrderId: row.paypal_order_id,
    approveUrl: row.paypal_approve_url,
    grossMinor: row.gross_minor,
    mcpStatus: row.mcp_status,
    deedNo: row.mcp_deed_no,
    paidAt: row.paid_at ? row.paid_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
  };
}

const DONATION_COLUMNS = `id, user_id, method, amount_minor, currency, points_spent,
  species_id, species_name, quantity, status, paypal_order_id, paypal_capture_id,
  paypal_approve_url, gross_minor, mcp_status, mcp_deed_no, mcp_error, paid_at, created_at`;

async function loadDonation(db: Db, id: string, lock = false): Promise<DonationRow> {
  const { rows } = await db.query<DonationRow>(
    `select ${DONATION_COLUMNS} from donations where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Donation not found');
  return row;
}

/** The fund account. Config only: a request body can never redirect the money. */
function fundPayee(): Payee {
  const payee: Payee = {
    email: config.globieFundPaypalEmail || null,
    merchantId: config.globieFundPaypalMerchantId || null,
  };
  if (!payee.email && !payee.merchantId) {
    throw new ApiError(
      503,
      'fund_not_configured',
      'The Globie Fund is not accepting PayPal donations yet',
    );
  }
  return payee;
}

function assertAmount(amountMinor: number): void {
  if (amountMinor < config.donationMinMinor) {
    throw ApiError.badRequest('amount_too_small', 'That is below the fund minimum');
  }
  if (amountMinor > config.donationMaxMinor) {
    throw ApiError.badRequest('amount_too_large', 'That is above the per-donation ceiling');
  }
}

/** Clean the markdown the sanctuary returns into one readable paragraph. */
function blurbFrom(content: string): string {
  const plain = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+.+$/gm, ' ')
    .replace(/[*_`>#-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (plain.length <= 220) return plain;
  return `${plain.slice(0, 217).trimEnd()}…`;
}

function speciesFromHit(hit: { entityId?: string; title?: string; content?: string }) {
  const id = hit.entityId?.trim();
  if (!id) return null;
  const content = hit.content ?? '';
  const latin = /\*([A-Z][a-z]+ [a-z-]+)\*/.exec(content)?.[1] ?? null;
  const status = /CRITICAL NEED/i.test(content)
    ? ('critical' as const)
    : /URGENT/i.test(content)
      ? ('urgent' as const)
      : null;
  return {
    id,
    name: (hit.title ?? id).replace(/\s+—.*$/, '').trim(),
    latin,
    status,
    blurb: blurbFrom(content),
  } satisfies DonationSpecies;
}

let speciesCache: { at: number; rows: DonationSpecies[] } | null = null;
const SPECIES_TTL_MS = 5 * 60_000;

/**
 * `recommend_species` is empty until the catalogue is embedded, so the picker
 * is driven by `search_forest_knowledge` and its `species` hits.
 */
export async function listSpecies(): Promise<DonationSpecies[]> {
  if (speciesCache && Date.now() - speciesCache.at < SPECIES_TTL_MS) {
    return speciesCache.rows;
  }
  const hits = await searchForestKnowledge(deviceIdForUser('catalogue'), 'native trees to adopt');
  const seen = new Set<string>();
  const rows: DonationSpecies[] = [];
  for (const hit of hits) {
    if (hit.entityType && hit.entityType !== 'species') continue;
    const species = speciesFromHit(hit);
    if (!species || seen.has(species.id)) continue;
    seen.add(species.id);
    rows.push(species);
  }
  speciesCache = { at: Date.now(), rows };
  return rows;
}

/** The member row a points redemption debits. Points live on memberships. */
async function memberForPoints(userId: string): Promise<string | null> {
  const { rows } = await query<{ id: string }>(
    `select id from members where user_id = $1 order by joined_at asc limit 1`,
    [userId],
  );
  return rows[0]?.id ?? null;
}

export async function pointsBalanceForUser(userId: string): Promise<number> {
  const { rows } = await query<{ balance: number }>(
    `select coalesce(sum(pa.delta), 0)::bigint as balance
       from points_awards pa
       join members m on m.id = pa.member_id
      where m.user_id = $1`,
    [userId],
  );
  return rows[0]?.balance ?? 0;
}

/**
 * Start the PayPal rail: a `proposed` row first so a crash mid-order still
 * leaves an auditable record, then the order, then `requested`.
 */
export async function startDonation(input: {
  userId: string;
  speciesId: string;
  speciesName: string | null;
  quantity: number;
  amountMinor: number;
}): Promise<DonationRow & { approveUrl: string }> {
  if (!isPayPalConfigured()) {
    throw new ApiError(503, 'paypal_not_configured', 'PayPal is not configured on this server');
  }
  assertAmount(input.amountMinor);
  const payee = fundPayee();
  const currency = config.globieFundCurrency;

  const { rows } = await query<DonationRow>(
    `insert into donations
       (user_id, method, amount_minor, currency, species_id, species_name, quantity)
     values ($1, 'paypal', $2, $3, $4, $5, $6)
     returning ${DONATION_COLUMNS}`,
    [
      input.userId,
      input.amountMinor,
      currency,
      input.speciesId,
      input.speciesName,
      input.quantity,
    ],
  );
  const created = rows[0]!;

  try {
    const order = await createOrder({
      target: { kind: 'donation', id: created.id },
      amountMinor: input.amountMinor,
      currency,
      description: `Globie Fund — adopt ${input.quantity} × ${input.speciesName ?? input.speciesId}`,
      payee,
    });

    const updated = await withTransaction(async (tx) => {
      const { rows: updatedRows } = await tx.query<DonationRow>(
        `update donations
            set status = 'requested',
                paypal_order_id = $2,
                paypal_approve_url = $3,
                gross_minor = amount_minor
          where id = $1
          returning ${DONATION_COLUMNS}`,
        [created.id, order.id, order.approveUrl],
      );
      return updatedRows[0]!;
    });

    return { ...updated, approveUrl: order.approveUrl };
  } catch (error) {
    await query(`delete from donations where id = $1 and status = 'proposed'`, [created.id]).catch(
      () => undefined,
    );
    throw error;
  }
}

/**
 * Redeem Globie points at 1000 = US$1. The peg only lands on whole cents for
 * multiples of ten points, so anything else is refused rather than rounded.
 */
export async function redeemPoints(input: {
  userId: string;
  speciesId: string;
  speciesName: string | null;
  quantity: number;
  points: number;
}): Promise<DonationRow> {
  if (!Number.isInteger(input.points) || input.points <= 0) {
    throw ApiError.badRequest('invalid_points', 'Choose a whole number of Globie points');
  }
  if (input.points % POINTS_PER_CENT !== 0) {
    throw ApiError.badRequest(
      'points_not_convertible',
      `Globie converts in steps of ${POINTS_PER_CENT} points`,
    );
  }
  if (config.globieFundCurrency !== 'USD') {
    throw ApiError.conflict(
      'points_rail_unavailable',
      'The points rail is pegged to US dollars and is unavailable for this fund currency',
    );
  }

  const amountMinor = Math.round(
    (input.points / config.pointsPerUsd) * 10 ** currencyExponent(config.globieFundCurrency),
  );
  assertAmount(amountMinor);

  const memberId = await memberForPoints(input.userId);
  if (!memberId) {
    throw ApiError.badRequest('insufficient_points', 'You do not have enough Globie yet');
  }

  const donation = await withTransaction(async (tx) => {
    // Serialise redemptions for one person so two taps cannot both pass the
    // balance check.
    await tx.query(`select pg_advisory_xact_lock(hashtext($1))`, [`points:${input.userId}`]);

    const { rows: balanceRows } = await tx.query<{ balance: number }>(
      `select coalesce(sum(pa.delta), 0)::bigint as balance
         from points_awards pa
         join members m on m.id = pa.member_id
        where m.user_id = $1`,
      [input.userId],
    );
    const balance = balanceRows[0]?.balance ?? 0;
    if (balance < input.points) {
      throw ApiError.badRequest(
        'insufficient_points',
        `You have ${balance} Globie, ${input.points} needed`,
      );
    }

    const { rows } = await tx.query<DonationRow>(
      `insert into donations
         (user_id, method, amount_minor, currency, points_spent,
          species_id, species_name, quantity, status, gross_minor, paid_at, mcp_status)
       values ($1, 'points', $2, 'USD', $3, $4, $5, $6, 'paid', $2, now(), 'pending')
       returning ${DONATION_COLUMNS}`,
      [
        input.userId,
        amountMinor,
        input.points,
        input.speciesId,
        input.speciesName,
        input.quantity,
      ],
    );

    // A redemption is a negative award with no agreement: the column became
    // nullable in 017 precisely for this. `/me/points` sums `delta`, so the
    // balance falls without any extra bookkeeping.
    await tx.query(
      `insert into points_awards (agreement_id, member_id, reason, delta)
       values (null, $1, $2, $3)`,
      [memberId, DONATION_REASON, -input.points],
    );

    return rows[0]!;
  });

  await tryAdopt(donation);
  return (await readDonation(donation.id)) ?? donation;
}

/**
 * Write the adoption to the sanctuary. Never throws: a gift that is already
 * paid for stays valid when the MCP is down, and the retry route settles it.
 */
export async function tryAdopt(row: DonationRow): Promise<DonationRow> {
  try {
    const { deed } = await adoptSpecies(deviceIdForUser(row.user_id), {
      speciesId: row.species_id,
      quantity: row.quantity,
      // The donation id is the idempotency key: a retry cannot plant twice.
      reference: row.id,
    });
    const { rows } = await query<DonationRow>(
      `update donations
          set mcp_status = 'adopted', mcp_deed_no = $2, mcp_error = null
        where id = $1
        returning ${DONATION_COLUMNS}`,
      [row.id, deed?.deedNo ?? null],
    );
    return rows[0] ?? row;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Adoption failed';
    const { rows } = await query<DonationRow>(
      `update donations
          set mcp_status = 'failed', mcp_error = $2
        where id = $1
        returning ${DONATION_COLUMNS}`,
      [row.id, message.slice(0, 500)],
    );
    return rows[0] ?? row;
  }
}

/**
 * Mark a PayPal donation paid from the capture, then adopt. Idempotent: the
 * webhook and the return screen can both call it.
 */
export async function settleDonation(
  donationId: string,
  capture: { captureId: string | null },
): Promise<DonationRow> {
  const row = await withTransaction(async (tx) => {
    const current = await loadDonation(tx, donationId, true);
    if (current.status === 'paid') return current;

    const { rows } = await tx.query<DonationRow>(
      `update donations
          set status = 'paid',
              paid_at = now(),
              paypal_capture_id = coalesce(paypal_capture_id, $2),
              mcp_status = case when mcp_status = 'none' then 'pending' else mcp_status end
        where id = $1
        returning ${DONATION_COLUMNS}`,
      [donationId, capture.captureId],
    );
    return rows[0]!;
  });

  if (row.mcp_status === 'pending' || row.mcp_status === 'failed') {
    return tryAdopt(row);
  }
  return row;
}

export async function failDonation(donationId: string): Promise<void> {
  await query(
    `update donations set status = 'failed' where id = $1 and status in ('proposed', 'requested')`,
    [donationId],
  );
}

/**
 * A refund reverses both rails. PayPal money is returned by PayPal itself; the
 * points rail has to give the points back, so the award row is removed and the
 * donation is flagged, mirroring `reverseTip`.
 */
export async function reverseDonation(donationId: string): Promise<void> {
  await withTransaction(async (tx) => {
    const row = await loadDonation(tx, donationId, true);
    if (row.status === 'refunded') return;

    if (row.method === 'points' && row.points_spent > 0) {
      const memberId = await memberForPoints(row.user_id);
      if (memberId) {
        const { rows: restored } = await tx.query<{ delta: number }>(
          `delete from points_awards
            where agreement_id is null and member_id = $1 and reason = $2 and delta = $3
            returning delta`,
          [memberId, DONATION_REASON, -row.points_spent],
        );
        // A missing row means the debit was already reversed; never double-credit.
        if ((restored[0]?.delta ?? 0) === 0) {
          throw ApiError.conflict('already_reversed', 'This redemption was already reversed');
        }
      }
    }

    await tx.query(`update donations set status = 'refunded' where id = $1`, [donationId]);
  });
}

export async function listDonations(userId: string): Promise<{
  donations: DonationRow[];
  totalMinor: number;
  treesAdopted: number;
  currency: string;
}> {
  const { rows } = await query<DonationRow>(
    `select ${DONATION_COLUMNS}
       from donations
      where user_id = $1
      order by created_at desc
      limit 50`,
    [userId],
  );
  const paid = rows.filter((row) => row.status === 'paid');
  return {
    donations: rows,
    totalMinor: paid.reduce((sum, row) => sum + row.amount_minor, 0),
    treesAdopted: paid.reduce((sum, row) => sum + row.quantity, 0),
    currency: config.globieFundCurrency,
  };
}

export { loadDonation };

export async function readDonation(id: string): Promise<DonationRow | null> {
  const { rows } = await query<DonationRow>(
    `select ${DONATION_COLUMNS} from donations where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}
