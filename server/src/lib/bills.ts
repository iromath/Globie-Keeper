/**
 * Bill reads and the two side effects both the REST routes and the agent tools
 * share: kicking off receipt extraction and creating one PayPal order for a
 * share. Keeping them here means the agent cannot drift from the routes.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { createOrder, isPayPalConfigured } from './paypal.js';
import { cleanupWorkDir, extractReceipt, type MediaInput } from './receipt.js';
import type {
    AllocationRow,
    BillItemRow,
    BillRow,
    ShareRow,
} from './serialize.js';

/** Nothing may change a bill once it has been finalized. */
export const LOCKED = new Set([
  'FINALIZED',
  'COLLECTING',
  'SETTLED',
  'CANCELLED',
]);

type MediaRow = {
  id: string;
  kind: string;
  storage_key: string;
  mime_type: string | null;
};

export function mediaPath(storageKey: string): string {
  return path.resolve(config.mediaDir, storageKey);
}

export async function loadBill(
  billId: string,
): Promise<{ bill: BillRow; items: BillItemRow[] }> {
  const { rows } = await query<BillRow>(`select b.* from bills b where b.id = $1`, [
    billId,
  ]);
  const bill = rows[0];
  if (!bill) throw ApiError.notFound('Bill not found');

  const items = await query<BillItemRow>(
    `select id, name, qty, unit_price, line_total, confidence
       from bill_items
      where bill_id = $1
      order by created_at asc`,
    [billId],
  );
  return { bill, items: items.rows };
}

export async function loadAllocations(billId: string): Promise<AllocationRow[]> {
  const { rows } = await query<AllocationRow>(
    `select al.id, al.bill_item_id, al.member_id,
            u.display_name as member_name, bi.name as item_name,
            al.qty, al.amount, al.status
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
       join members m on m.id = al.member_id
       join users u on u.id = m.user_id
      where bi.bill_id = $1
      order by bi.created_at asc, al.created_at asc`,
    [billId],
  );
  return rows;
}

export async function loadShares(billId: string): Promise<ShareRow[]> {
  const { rows } = await query<ShareRow>(
    `select s.id, s.bill_id, a.id as agreement_id, a.group_id, g.name as group_name,
            s.member_id, u.display_name as member_name,
            s.amount, s.currency, s.status, s.due_at, s.paid_at,
            s.paypal_order_id, s.paypal_approve_url, s.created_at
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join groups g on g.id = a.group_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
      where s.bill_id = $1
      order by s.created_at asc`,
    [billId],
  );
  return rows;
}

export async function loadShareById(shareId: string): Promise<ShareRow> {
  const { rows } = await query<ShareRow>(
    `select s.id, s.bill_id, a.id as agreement_id, a.group_id, g.name as group_name,
            s.member_id, u.display_name as member_name,
            s.amount, s.currency, s.status, s.due_at, s.paid_at,
            s.paypal_order_id, s.paypal_approve_url, s.created_at
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join groups g on g.id = a.group_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
      where s.id = $1`,
    [shareId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Share not found');
  return row;
}

/**
 * Detached receipt extraction. The route answers `PARSING` immediately and the
 * client polls `GET /bills/:id` every 1.5 s until the status leaves PARSING.
 */
export async function runExtraction(input: {
  billId: string;
  mediaId: string;
  agreementId: string;
  groupId: string;
  memberId: string;
  actor: string;
  currency: string;
  media: MediaInput;
  log: FastifyBaseLogger;
}): Promise<void> {
  const workDir = path.resolve(config.mediaDir, '.work', input.billId);

  try {
    const result = await extractReceipt([input.media], workDir, input.currency);
    const warnings = [
      ...new Set([...(result.draft?.warnings ?? []), ...result.warnings]),
    ];
    const draft = result.draft;

    if (!draft) {
      await query(
        `update bills
            set status = 'UPLOADED', warnings = $2::jsonb, frames_extracted = $3,
                raw_extraction = null, parsed_at = now()
          where id = $1`,
        [input.billId, JSON.stringify(warnings), result.framesExtracted],
      );
      await query(`update bill_media set status = 'failed' where id = $1`, [
        input.mediaId,
      ]);
      return;
    }

    if (draft.currency !== input.currency) {
      warnings.push(
        `Receipt is printed in ${draft.currency}; this bill is kept in ${input.currency}.`,
      );
    }

    await withTransaction(async (tx) => {
      // Re-parsing replaces the item list; allocations cascade with it.
      await tx.query(`delete from bill_items where bill_id = $1`, [input.billId]);

      for (const item of draft.items) {
        await tx.query(
          `insert into bill_items (bill_id, name, qty, unit_price, line_total, confidence)
           values ($1, $2, $3, $4, $5, $6)`,
          [
            input.billId,
            item.name.slice(0, 160),
            item.qty,
            item.unitPriceMinor,
            item.lineTotalMinor,
            item.confidence,
          ],
        );
      }

      await tx.query(
        `update bills
            set merchant = $2, subtotal = $3, tax = $4, service_charge = $5, tip = $6,
                discount = $7, total = $8, status = 'PARSED', warnings = $9::jsonb,
                frames_extracted = $10, raw_extraction = $11::jsonb, parsed_at = now()
          where id = $1`,
        [
          input.billId,
          draft.merchant,
          draft.subtotalMinor,
          draft.taxMinor,
          draft.serviceChargeMinor,
          draft.tipMinor,
          draft.discountMinor,
          draft.totalMinor,
          JSON.stringify(warnings),
          result.framesExtracted,
          JSON.stringify(draft),
        ],
      );

      await tx.query(
        `update bill_media set status = 'extracted', frames_extracted = $2 where id = $1`,
        [input.mediaId, result.framesExtracted],
      );

      await recordEvent(tx, {
        groupId: input.groupId,
        agreementId: input.agreementId,
        memberId: input.memberId,
        eventType: 'bill.parsed',
        amountMinor: draft.totalMinor,
        currency: input.currency,
        actor: input.actor,
        summary: `${input.actor} captured the receipt — ${draft.items.length} lines read`,
        metadata: { frames: result.framesExtracted },
      });
    });
  } catch (error) {
    input.log.error({ err: error, billId: input.billId }, 'receipt extraction failed');
    await query(
      `update bills
          set status = 'UPLOADED', warnings = $2::jsonb, parsed_at = now()
        where id = $1`,
      [
        input.billId,
        JSON.stringify(['Receipt AI could not read this upload — try again.']),
      ],
    ).catch(() => undefined);
    await query(`update bill_media set status = 'failed' where id = $1`, [
      input.mediaId,
    ]).catch(() => undefined);
  } finally {
    await cleanupWorkDir(workDir);
  }
}

/**
 * Flag the bill as PARSING and start extraction. The REST route returns
 * immediately; the agent tool passes `wait: true` because its contract is
 * `parse_receipt_media -> { items[], totals, ... }`.
 */
export async function startBillParse(input: {
  billId: string;
  agreementId: string;
  groupId: string;
  memberId: string;
  actor: string;
  currency: string;
  log: FastifyBaseLogger;
  wait?: boolean;
}): Promise<{ status: 'PARSING'; mediaId: string }> {
  const { rows } = await query<MediaRow>(
    `select id, kind, storage_key, mime_type
       from bill_media
      where bill_id = $1
      order by created_at desc
      limit 1`,
    [input.billId],
  );
  const media = rows[0];
  if (!media) {
    throw ApiError.conflict('media_missing', 'Upload a receipt photo or video first');
  }

  await query(
    `update bills
        set status = 'PARSING', warnings = '[]'::jsonb, frames_extracted = 0
      where id = $1`,
    [input.billId],
  );

  const extraction = runExtraction({
    billId: input.billId,
    mediaId: media.id,
    agreementId: input.agreementId,
    groupId: input.groupId,
    memberId: input.memberId,
    actor: input.actor,
    currency: input.currency,
    media: {
      kind: media.kind === 'video' ? 'video' : 'photo',
      path: mediaPath(media.storage_key),
      mimeType: media.mime_type,
    },
    log: input.log,
  });

  if (input.wait) await extraction;
  else void extraction;

  return { status: 'PARSING', mediaId: media.id };
}

/**
 * Create one PayPal order for one share and persist the approval link.
 * Shared by `POST /bills/:id/request-payments` and the agent tool.
 *
 * The order names the fronter as payee, so the capture settles into their own
 * PayPal account and the platform never holds the money. A fronter without a
 * linked account blocks collection instead of quietly collecting into ours.
 */
export async function requestPaymentForShare(input: {
  share: ShareRow;
  merchant: string | null;
  currency: string;
  groupId: string;
  agreementId: string;
  actor: { memberId: string; displayName: string };
}): Promise<{
  shareId: string;
  paypalOrderId: string;
  approveUrl: string;
  amount: number;
  currency: string;
}> {
  const { share } = input;

  if (!isPayPalConfigured()) {
    throw ApiError.conflict(
      'paypal_not_configured',
      'PayPal sandbox credentials are not configured on this server',
    );
  }

  const { rows: payeeRows } = await query<{ paypal_email: string | null }>(
    `select m.paypal_email
       from agreements a
       join members m on m.id = a.fronted_by
      where a.id = $1`,
    [input.agreementId],
  );
  const payeeEmail = payeeRows[0]?.paypal_email?.trim();

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict(
      'share_already_paid',
      'This share has already been paid',
    );
  }

  if (share.status === 'requested' && share.paypal_approve_url) {
    return {
      shareId: share.id,
      paypalOrderId: share.paypal_order_id ?? '',
      approveUrl: share.paypal_approve_url,
      amount: share.amount,
      currency: input.currency,
    };
  }

  if (!payeeEmail) {
    throw ApiError.conflict(
      'fronter_paypal_missing',
      'The person who fronted this bill must add their PayPal email before members can reimburse them',
    );
  }

  const order = await createOrder({
    target: { kind: 'share', id: share.id },
    amountMinor: share.amount,
    currency: input.currency,
    description: `Globie Keeper — ${share.member_name} · ${input.merchant ?? 'group bill'}`,
    payee: { email: payeeEmail },
    // PayPal replays the original response for a reused request id — including
    // an order the payer already refused — so a re-request after a dead
    // checkout needs a key of its own.
    requestId: share.paypal_order_id
      ? `globie-share-${share.id}-${randomUUID()}`
      : undefined,
  });

  await withTransaction(async (tx) => {
    await tx.query(
      `update shares
          set status = 'requested',
              paypal_order_id = $2,
              paypal_approve_url = $3
        where id = $1 and status in ('proposed', 'failed', 'requested')`,
      [share.id, order.id, order.approveUrl],
    );
    await tx.query(
      `insert into payments
         (share_id, provider, provider_ref, amount, currency, status, raw_payload)
       values ($1, 'paypal', $2, $3, $4, 'pending', $5::jsonb)
       on conflict (provider, provider_ref) do update
         set share_id = excluded.share_id,
             amount = excluded.amount,
             currency = excluded.currency,
             status = 'pending',
             raw_payload = excluded.raw_payload`,
      [
        share.id,
        order.id,
        share.amount,
        input.currency,
        JSON.stringify({ orderId: order.id }),
      ],
    );
    await recordEvent(tx, {
      groupId: input.groupId,
      agreementId: input.agreementId,
      shareId: share.id,
      memberId: share.member_id,
      eventType: 'payment.requested',
      amountMinor: share.amount,
      currency: input.currency,
      actor: input.actor.displayName,
      summary: `PayPal request sent to ${share.member_name}`,
    });
  });

  return {
    shareId: share.id,
    paypalOrderId: order.id,
    approveUrl: order.approveUrl,
    amount: share.amount,
    currency: input.currency,
  };
}
