/**
 * Bill reads and the two side effects both the REST routes and the agent tools
 * share: kicking off receipt extraction and creating one PayPal order for a
 * share. Keeping them here means the agent cannot drift from the routes.
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';

import type { FastifyBaseLogger } from 'fastify';

import { query, withTransaction, type Db } from '../db/pool.js';
import { config } from './config.js';
import { feeCoverAllowed, feeScheduleFor, grossUpMinor } from './fees.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { allocate } from './money.js';
import { createOrder, isPayPalConfigured, paypalMeUrl } from './paypal.js';
import { cleanupWorkDir, extractReceipt, type MediaInput } from './receipt.js';
import type {
    AllocationRow,
    BillItemRow,
    BillRow,
    BillSplitEntryRow,
    ShareRow,
} from './serialize.js';
import { awardFrontedGlobie } from './settlement.js';
import type { PaymentMode } from './validate.js';

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
): Promise<{
  bill: BillRow;
  items: BillItemRow[];
  splitEntries: BillSplitEntryRow[];
}> {
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
  const splitEntries = await query<BillSplitEntryRow>(
    `select bill_id, member_id, amount, weight
       from bill_split_entries
      where bill_id = $1
      order by created_at asc`,
    [billId],
  );
  return { bill, items: items.rows, splitEntries: splitEntries.rows };
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
            s.paypal_order_id, s.paypal_approve_url, s.payment_mode, s.created_at,
            s.fee_minor, s.gross_minor, s.late_fee_minor
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
            s.paypal_order_id, s.paypal_approve_url, s.payment_mode, s.created_at,
            s.fee_minor, s.gross_minor, s.late_fee_minor
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

export type FinalizeInput = {
  billId: string;
  /** Member whose tap triggered the lock; credited in the timeline. */
  actorMemberId: string;
  actorName: string;
  /** Carries tax/tip/unassigned lines when the agreement names no fronter. */
  fallbackFronterId: string;
};

export type FinalizeOutcome =
  | { ok: true; shareCount: number; totalMinor: number }
  | {
      ok: false;
      reason:
        | 'bill_closed'
        | 'no_allocations'
        | 'confirmations_pending'
        | 'totals_mismatch'
        | 'nothing_to_collect';
      message: string;
    };

/**
 * Weights for the non-receipt split modes. `equal` derives them from the active
 * member list, `custom` uses the amounts the fronter typed and `percent` the
 * percentages they assigned; all three then run through the same
 * largest-remainder `allocate` so the shares still add up to the bill total.
 */
async function splitTotals(
  db: Db,
  input: { billId: string; groupId: string; mode: string; total: number },
): Promise<
  | { ok: true; totals: Map<string, number> }
  | {
      ok: false;
      reason: 'no_allocations' | 'totals_mismatch';
      message: string;
    }
> {
  if (input.mode === 'equal') {
    const { rows: members } = await db.query<{ id: string }>(
      `select id from members where group_id = $1 and status <> 'removed'`,
      [input.groupId],
    );
    if (members.length === 0) {
      return {
        ok: false,
        reason: 'no_allocations',
        message: 'This group has no members yet',
      };
    }
    const parts = allocate(
      input.total,
      members.map(() => 1),
    );
    return {
      ok: true,
      totals: new Map(
        members.map((member, index) => [member.id, parts[index] ?? 0]),
      ),
    };
  }

  if (input.mode === 'custom') {
    const { rows } = await db.query<{
      member_id: string;
      amount: number | null;
    }>(`select member_id, amount from bill_split_entries where bill_id = $1`, [
      input.billId,
    ]);
    if (rows.length === 0) {
      return {
        ok: false,
        reason: 'no_allocations',
        message: 'Add each member’s amount first',
      };
    }
    const totals = new Map(rows.map((row) => [row.member_id, row.amount ?? 0]));
    const sum = [...totals.values()].reduce((acc, value) => acc + value, 0);
    if (sum !== input.total) {
      return {
        ok: false,
        reason: 'totals_mismatch',
        message: 'The custom amounts do not add up to the bill total',
      };
    }
    return { ok: true, totals };
  }

  const { rows } = await db.query<{
    member_id: string;
    weight: number | string | null;
  }>(`select member_id, weight from bill_split_entries where bill_id = $1`, [
    input.billId,
  ]);
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'no_allocations',
      message: 'Add each member’s percentage first',
    };
  }
  const weights = rows.map((row) => Number(row.weight ?? 0));
  const weightSum = weights.reduce((acc, value) => acc + value, 0);
  if (Math.abs(weightSum - 100) > 0.01) {
    return {
      ok: false,
      reason: 'totals_mismatch',
      message: 'The percentages must add up to 100',
    };
  }
  const parts = allocate(input.total, weights);
  return {
    ok: true,
    totals: new Map(rows.map((row, index) => [row.member_id, parts[index] ?? 0])),
  };
}

/**
 * Turn confirmed lines into one share per member. Runs inside the caller's
 * transaction so the last confirmation and the shares it creates commit
 * together — a member who confirmed every line must never be left staring at
 * an empty Shares screen. Tax, tip, service and unassigned lines land on the
 * fronter, so the shares always add up to the bill total.
 */
export async function finalizeBill(
  db: Db,
  input: FinalizeInput,
): Promise<FinalizeOutcome> {
  const { rows: billRows } = await db.query<{
    total: number;
    currency: string;
    status: string;
    agreement_id: string;
    group_id: string;
    fronted_by: string | null;
    deadline: Date | null;
    split_mode: string;
  }>(
    `select b.total, b.currency, b.status, b.agreement_id, b.split_mode,
            a.group_id, a.fronted_by, a.deadline
       from bills b
       join agreements a on a.id = b.agreement_id
      where b.id = $1`,
    [input.billId],
  );
  const bill = billRows[0];
  if (!bill) throw ApiError.notFound('Bill not found');
  if (LOCKED.has(bill.status)) {
    return { ok: false, reason: 'bill_closed', message: 'This bill is closed' };
  }

  // The fronter already handed the merchant the money for their own share, so
  // that share is spent, not owed. Asking them to reimburse themselves would
  // need a self-addressed PayPal order and would keep the bill open forever.
  const fronterId = bill.fronted_by ?? input.fallbackFronterId;
  const mode = bill.split_mode ?? 'item';

  let totals: Map<string, number>;

  if (mode === 'item') {
    const { rows: allocations } = await db.query<{
      member_id: string;
      amount: number;
      status: string;
    }>(
      `select al.member_id, al.amount, al.status
         from allocations al
         join bill_items bi on bi.id = al.bill_item_id
        where bi.bill_id = $1`,
      [input.billId],
    );

    if (allocations.length === 0) {
      return {
        ok: false,
        reason: 'no_allocations',
        message: 'Assign the items before finalizing',
      };
    }

    const pending = allocations.filter((row) => row.status === 'proposed').length;
    if (pending > 0) {
      return {
        ok: false,
        reason: 'confirmations_pending',
        message: `${pending} line(s) still need a member's confirmation`,
      };
    }

    totals = new Map<string, number>();
    for (const row of allocations) {
      totals.set(row.member_id, (totals.get(row.member_id) ?? 0) + row.amount);
    }

    const covered = [...totals.values()].reduce((sum, value) => sum + value, 0);
    const gap = bill.total - covered;
    if (gap < 0) {
      return {
        ok: false,
        reason: 'totals_mismatch',
        message: 'Allocated amounts exceed the bill total',
      };
    }

    // Rounding, tax, tip and unassigned lines are carried by the fronter.
    if (gap > 0) totals.set(fronterId, (totals.get(fronterId) ?? 0) + gap);
  } else {
    const split = await splitTotals(db, {
      billId: input.billId,
      groupId: bill.group_id,
      mode,
      total: bill.total,
    });
    if (!split.ok) return split;
    totals = split.totals;
  }

  const rows = [...totals.entries()].filter(([, amount]) => amount > 0);
  if (rows.length === 0) {
    return {
      ok: false,
      reason: 'nothing_to_collect',
      message: 'There is nothing to collect',
    };
  }

  const sum = rows.reduce((acc, [, amount]) => acc + amount, 0);
  if (sum !== bill.total) {
    return {
      ok: false,
      reason: 'totals_mismatch',
      message: 'The split does not add up to the bill total',
    };
  }

  const currency = bill.currency.trim();
  const dueAt = bill.deadline ?? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.query(`delete from shares where bill_id = $1 and status = 'proposed'`, [
    input.billId,
  ]);

  for (const [memberId, amount] of rows) {
    await db.query(
      `insert into shares (bill_id, member_id, amount, currency, status, due_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        input.billId,
        memberId,
        amount,
        currency,
        memberId === fronterId ? 'settled' : 'proposed',
        dueAt,
      ],
    );
  }

  await db.query(
    `update bills set status = 'FINALIZED', version = version + 1 where id = $1`,
    [input.billId],
  );

  // Fronting is the act the product is built around, so it pays Globie too.
  // Idempotent per agreement: only the first finalize lands an award.
  const fronted = await awardFrontedGlobie(db, {
    agreementId: bill.agreement_id,
    groupId: bill.group_id,
    memberId: fronterId,
  });

  await recordEvent(db, {
    groupId: bill.group_id,
    agreementId: bill.agreement_id,
    memberId: input.actorMemberId,
    eventType: 'bill.finalized',
    amountMinor: bill.total,
    currency,
    actor: input.actorName,
    summary:
      fronted.delta > 0
        ? `${input.actorName} locked the split — ${rows.length} shares ready, +${fronted.delta} Globie for fronting`
        : `${input.actorName} locked the split — ${rows.length} shares ready`,
  });

  return { ok: true, shareCount: rows.length, totalMinor: bill.total };
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
        `The receipt prints ${draft.currency}; this bill is kept in ${input.currency}. The amounts were not converted — check them.`,
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
}): Promise<{ status: string; mediaId: string | null }> {
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
    // A bill can be typed in by hand. Once it has lines there is nothing to
    // extract, so parsing is a no-op instead of an error.
    const { rows: existing } = await query<{ status: string }>(
      `select status from bills where id = $1`,
      [input.billId],
    );
    const status = existing[0]?.status ?? 'UPLOADED';
    if (status === 'UPLOADED' || status === 'PARSING') {
      throw ApiError.conflict(
        'media_missing',
        'Add a photo, a video, or the lines by hand',
      );
    }
    return { status, mediaId: null };
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
 * PayPal.Me requests carry no order id, so the payment row gets a synthetic,
 * stable reference: the share can only be paid once, which makes it a key.
 */
export function p2pRef(shareId: string): string {
  return `p2p:${shareId}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What an overdue share owes on top of itself, in minor units.
 *
 * `lateFeeBps` is a monthly rate (300 = 3% a month), prorated by the day from
 * the share's due date, then capped as a share of the share when the agreement
 * set a cap. Zero rate or no due date means nobody can be charged extra.
 */
export function lateFeeFor(input: {
  amountMinor: number;
  lateFeeBps: number;
  lateFeeCapBps: number | null;
  dueAt: Date | null;
  now?: Date;
}): number {
  const { amountMinor, lateFeeBps, lateFeeCapBps, dueAt } = input;
  if (lateFeeBps <= 0 || !dueAt || amountMinor <= 0) return 0;
  const now = input.now ?? new Date();
  const overdueDays = (now.getTime() - dueAt.getTime()) / DAY_MS;
  if (overdueDays <= 0) return 0;

  // A 30-day month, prorated, rounded up so a member is never undercharged by
  // a fraction of a satang.
  const raw = Math.ceil((amountMinor * lateFeeBps * overdueDays) / (10_000 * 30));
  const cap =
    lateFeeCapBps === null ? raw : Math.floor((amountMinor * lateFeeCapBps) / 10_000);
  return Math.max(0, Math.min(raw, cap));
}

/**
 * Ask one member for one share, using whichever mode the fronter picked.
 *
 * `payee_direct` creates a PayPal order naming the fronter as payee, so the
 * capture settles into their own account and the platform never holds the
 * money. `paypal_me` only builds a PayPal.Me link: PayPal exposes no API for
 * that money request, so the payer confirms it and the server records it.
 * Shared by `POST /bills/:id/request-payments` and the agent tool.
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
  paypalOrderId: string | null;
  approveUrl: string | null;
  paymentMode: PaymentMode;
  amount: number;
  feeMinor: number;
  lateFeeMinor: number;
  grossMinor: number;
  currency: string;
}> {
  const { share } = input;

  const { rows: payeeRows } = await query<{
    paypal_email: string | null;
    paypal_merchant_id: string | null;
    paypal_mode: string;
    paypal_me_handle: string | null;
    cover_paypal_fee: boolean;
    payee_user_paypal_email: string | null;
    payer_paypal_email: string | null;
    late_fee_bps: number;
    late_fee_cap_bps: number | null;
  }>(
    `select m.paypal_email, m.paypal_merchant_id, m.paypal_mode, m.paypal_me_handle,
            m.cover_paypal_fee, a.late_fee_bps, a.late_fee_cap_bps,
            (select u.paypal_email
               from users u
              where u.id = m.user_id) as payee_user_paypal_email,
            (select u.paypal_email
               from members pm
               join users u on u.id = pm.user_id
              where pm.id = $2) as payer_paypal_email
       from agreements a
       join members m on m.id = a.fronted_by
      where a.id = $1`,
    [input.agreementId, share.member_id],
  );
  const payeeMode: PaymentMode =
    payeeRows[0]?.paypal_mode === 'paypal_me' ? 'paypal_me' : 'payee_direct';
  /**
   * The membership row is the canonical home for this, but older accounts only
   * ever stored the address on `users` (it is what settings used to write). Fall
   * back to it so a fronter who never re-saved gets a working request instead of
   * `fronter_paypal_missing`.
   */
  const payeeEmail =
    payeeRows[0]?.paypal_email?.trim() ||
    payeeRows[0]?.payee_user_paypal_email?.trim() ||
    null;
  const payeeMerchantId = payeeRows[0]?.paypal_merchant_id?.trim() || null;
  const payeeHandle = payeeRows[0]?.paypal_me_handle?.trim().replace(/^@/, '') ?? null;
  const payerEmail = payeeRows[0]?.payer_paypal_email?.trim().toLowerCase() ?? null;

  /**
   * Late fee (agreement terms): charged on top of an overdue share, prorated by
   * the day and capped as a share of it. Once quoted on a request it becomes a
   * snapshot — a later change to the terms cannot rewrite what this member was
   * already asked to pay.
   */
  const lateFee =
    (share.late_fee_minor ?? 0) > 0
      ? (share.late_fee_minor ?? 0)
      : lateFeeFor({
          amountMinor: share.amount,
          lateFeeBps: Number(payeeRows[0]?.late_fee_bps ?? 0),
          lateFeeCapBps:
            payeeRows[0]?.late_fee_cap_bps === null ||
            payeeRows[0]?.late_fee_cap_bps === undefined
              ? null
              : Number(payeeRows[0].late_fee_cap_bps),
          dueAt: share.due_at,
        });
  const owed = share.amount + lateFee;

  /**
   * Optional fee coverage (DEV_PLAN §2.20). The payer is asked for `gross` so
   * the fronter nets the share. Off unless the fronter opted in, and never in
   * live mode without PAYPAL_FEE_COVER_LIVE_ALLOWED: passing the fee on is a
   * surcharge under both the US and Thai user agreements.
   */
  const coverFee = Boolean(payeeRows[0]?.cover_paypal_fee) && feeCoverAllowed();
  const fee = coverFee
    ? grossUpMinor(owed, feeScheduleFor(input.currency)) - owed
    : 0;
  const gross = owed + fee;

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict(
      'share_already_paid',
      'This share has already been paid',
    );
  }

  if (share.status === 'requested' && share.paypal_approve_url) {
    // An open checkout keeps the amount it was created with.
    return {
      shareId: share.id,
      paypalOrderId: share.paypal_order_id ?? null,
      approveUrl: share.paypal_approve_url,
      paymentMode: (share.payment_mode as PaymentMode | null) ?? payeeMode,
      amount: share.amount,
      feeMinor: share.fee_minor ?? 0,
      lateFeeMinor: share.late_fee_minor ?? 0,
      grossMinor: share.gross_minor ?? share.amount,
      currency: input.currency,
    };
  }

  if (payeeMode === 'paypal_me') {
    if (!payeeHandle) {
      throw ApiError.conflict(
        'fronter_paypal_missing',
        'Add your PayPal.Me handle in Settings before members can reimburse you',
      );
    }

    const link = paypalMeUrl(payeeHandle, gross, input.currency);
    const providerRef = p2pRef(share.id);

    await withTransaction(async (tx) => {
      await tx.query(
        `update shares
            set status = 'requested',
                paypal_order_id = null,
                paypal_approve_url = $2,
                payment_mode = 'paypal_me',
                fee_minor = $3,
                gross_minor = $4,
                late_fee_minor = $5
          where id = $1 and status in ('proposed', 'failed', 'requested')`,
        [share.id, link, fee, gross, lateFee],
      );
      await tx.query(
        `insert into payments
           (share_id, provider, provider_ref, amount, currency, status, fee_minor, raw_payload)
         values ($1, 'paypal', $2, $3, $4, 'pending', $5, $6::jsonb)
         on conflict (provider, provider_ref) do update
           set share_id = excluded.share_id,
               amount = excluded.amount,
               currency = excluded.currency,
               status = 'pending',
               fee_minor = excluded.fee_minor,
               raw_payload = excluded.raw_payload`,
        [
          share.id,
          providerRef,
          owed,
          input.currency,
          fee,
          JSON.stringify({ paypalMeUrl: link, handle: payeeHandle, lateFeeMinor: lateFee }),
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
        summary: `PayPal.Me request sent to ${share.member_name}`,
      });
    });

    return {
      shareId: share.id,
      paypalOrderId: null,
      approveUrl: link,
      paymentMode: 'paypal_me',
      amount: share.amount,
      feeMinor: fee,
      lateFeeMinor: lateFee,
      grossMinor: gross,
      currency: input.currency,
    };
  }

  if (!isPayPalConfigured()) {
    throw ApiError.conflict(
      'paypal_not_configured',
      'PayPal sandbox credentials are not configured on this server',
    );
  }

  if (!payeeEmail && !payeeMerchantId) {
    throw ApiError.conflict(
      'fronter_paypal_missing',
      'Add your PayPal email in Settings before members can reimburse you',
    );
  }

  // The capture would move money from a member to themselves, which PayPal
  // refuses — and the member already covered this bill anyway.
  if (payerEmail && payeeEmail && payerEmail === payeeEmail.toLowerCase()) {
    throw ApiError.conflict(
      'self_payment',
      'You fronted this bill, so there is nothing to reimburse yourself for',
    );
  }

  const order = await createOrder({
    target: { kind: 'share', id: share.id },
    amountMinor: gross,
    currency: input.currency,
    description: `Globie Keeper — ${share.member_name} · ${input.merchant ?? 'group bill'}`,
    payee: { email: payeeEmail, merchantId: payeeMerchantId },
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
              paypal_approve_url = $3,
              payment_mode = 'payee_direct',
              fee_minor = $4,
              gross_minor = $5,
              late_fee_minor = $6
        where id = $1 and status in ('proposed', 'failed', 'requested')`,
      [share.id, order.id, order.approveUrl, fee, gross, lateFee],
    );
    await tx.query(
      `insert into payments
         (share_id, provider, provider_ref, amount, currency, status, fee_minor, raw_payload)
       values ($1, 'paypal', $2, $3, $4, 'pending', $5, $6::jsonb)
       on conflict (provider, provider_ref) do update
         set share_id = excluded.share_id,
             amount = excluded.amount,
             currency = excluded.currency,
             status = 'pending',
             fee_minor = excluded.fee_minor,
             raw_payload = excluded.raw_payload`,
      [
        share.id,
        order.id,
        owed,
        input.currency,
        fee,
        JSON.stringify({ orderId: order.id, lateFeeMinor: lateFee }),
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
    paymentMode: 'payee_direct',
    amount: share.amount,
    feeMinor: fee,
    lateFeeMinor: lateFee,
    grossMinor: gross,
    currency: input.currency,
  };
}

/**
 * Replace a checkout PayPal dropped — expired, voided, or refused at its own
 * page — instead of leaving the share with a balance and no way to pay it.
 * `reconcileShare` marks the row `failed`; this mints the order behind its
 * replacement and returns the link the member can press.
 *
 * Returns null when no order can be made (PayPal not configured, the fronter has
 * no address, the payer is the payee): the caller then leaves the row `failed`,
 * exactly as it behaved before, rather than failing the request that rendered
 * the list.
 */
export async function reissueDeadCheckout(input: {
  share: ShareRow;
  actor: { memberId: string; displayName: string };
}): Promise<{
  status: 'requested';
  approveUrl: string;
  paymentMode: PaymentMode;
  feeMinor: number;
  lateFeeMinor: number;
  grossMinor: number;
} | null> {
  const { rows } = await query<{
    merchant: string | null;
    currency: string;
    agreement_id: string;
    group_id: string;
  }>(
    `select b.merchant, b.currency, b.agreement_id, a.group_id
       from bills b
       join agreements a on a.id = b.agreement_id
      where b.id = $1`,
    [input.share.bill_id],
  );
  const bill = rows[0];
  if (!bill) return null;

  try {
    const result = await requestPaymentForShare({
      // The row the caller holds was read before the death was recorded, so it
      // may still carry the dead link; hand over the state the database holds
      // now so the live-checkout shortcut cannot hand that link back.
      share: { ...input.share, status: 'failed', paypal_approve_url: null },
      merchant: bill.merchant,
      currency: bill.currency.trim(),
      groupId: bill.group_id,
      agreementId: bill.agreement_id,
      actor: input.actor,
    });
    if (!result.approveUrl) return null;
    // Hand back the amounts the new order was created with: a share that is
    // overdue now may carry a late fee it did not have when it last failed.
    return {
      status: 'requested',
      approveUrl: result.approveUrl,
      paymentMode: result.paymentMode,
      feeMinor: result.feeMinor,
      lateFeeMinor: result.lateFeeMinor,
      grossMinor: result.grossMinor,
    };
  } catch (cause) {
    if (cause instanceof ApiError) return null;
    throw cause;
  }
}
