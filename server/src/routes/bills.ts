import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import {
    requireAgreementMember,
    requireBillMember,
    requireFronter,
} from '../lib/access.js';
import {
    LOCKED,
    finalizeBill,
    loadAllocations,
    loadBill,
    loadShares,
    mediaPath,
    requestPaymentForShare,
    startBillParse,
} from '../lib/bills.js';
import { ApiError } from '../lib/http-error.js';
import { recordEvent } from '../lib/ledger.js';
import { allocate } from '../lib/money.js';
import { isPayPalConfigured } from '../lib/paypal.js';
import {
    mapAllocation,
    mapBill,
    mapShare,
    type AllocationRow,
    type BillRow,
} from '../lib/serialize.js';
import { reconcileShare } from '../lib/settlement.js';
import type { PaymentMode } from '../lib/validate.js';
import { asRecord, currencyCode, pathUuid, requiredUuid } from '../lib/validate.js';

type BillParams = { Params: { id: string } };
type AllocationParams = { Params: { id: string } };

/** Bills in these states can still be re-split. */
const EDITABLE = "('UPLOADED', 'PARSING', 'PARSED', 'ALLOCATED', 'CONFIRMED')";

const MEDIA_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
};

const FILE_EXTENSIONS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.webp',
  '.heic',
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
]);

type BillItemTotalRow = { id: string; line_total: number };

type AllocationConfirmRow = {
  id: string;
  bill_item_id: string;
  member_id: string;
  amount: number;
  status: string;
  bill_id: string;
  group_id: string;
  currency: string;
  bill_status: string;
};

function extensionFor(mimeType: string, filename: string, kind: 'photo' | 'video'): string {
  const fromMime = MEDIA_EXTENSIONS[mimeType];
  if (fromMime) return fromMime;

  const fromName = path.extname(filename).toLowerCase();
  if (FILE_EXTENSIONS.has(fromName)) return fromName;

  return kind === 'video' ? '.mp4' : '.jpg';
}

async function loadAllocation(allocationId: string): Promise<AllocationRow> {
  const { rows } = await query<AllocationRow>(
    `select al.id, al.bill_item_id, al.member_id,
            u.display_name as member_name, bi.name as item_name,
            al.qty, al.amount, al.status
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
       join members m on m.id = al.member_id
       join users u on u.id = m.user_id
      where al.id = $1`,
    [allocationId],
  );
  const row = rows[0];
  if (!row) throw ApiError.notFound('Allocation not found');
  return row;
}

export const billRoutes: FastifyPluginAsync = async (app) => {
  /** Start a bill for an agreement. The receipt arrives in the next call. */
  app.post('/bills', async (request) => {
    const body = asRecord(request.body);
    const agreementId = requiredUuid(body, 'agreementId');
    const ctx = await requireAgreementMember(request, agreementId);

    requireFronter(ctx);

    if (ctx.status === 'cancelled' || ctx.status === 'settled') {
      throw ApiError.conflict('agreement_closed', 'This agreement is closed');
    }

    const currency =
      body.currency === undefined ? ctx.currency : currencyCode(body.currency);

    const { rows } = await query<BillRow>(
      `insert into bills (agreement_id, currency, status)
       values ($1, $2, 'UPLOADED')
       returning id, agreement_id, merchant, currency, subtotal, tax, service_charge,
                 tip, discount, total, status, warnings, frames_extracted`,
      [agreementId, currency],
    );
    const bill = rows[0];
    if (!bill) throw new ApiError(500, 'bill_insert_failed', 'Could not open the bill');

    await recordEvent(
      { query },
      {
        groupId: ctx.groupId,
        agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.created',
        currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} is capturing the receipt`,
      },
    );

    return { bill: mapBill(bill, []) };
  });

  /** Store a receipt photo or video on disk. `kind` may arrive before or after the file. */
  app.post<BillParams>('/bills/:id/media', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);
    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    let kind: 'photo' | 'video' | null = null;
    let bytes: Buffer | null = null;
    let mimeType: string | null = null;
    let filename = '';

    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (part.fieldname === 'kind') {
          const value = String(part.value).trim().toLowerCase();
          if (value === 'photo' || value === 'video') kind = value;
        }
        continue;
      }

      if (part.fieldname !== 'file') {
        await part.toBuffer();
        continue;
      }

      bytes = await part.toBuffer();
      mimeType = part.mimetype ? part.mimetype.toLowerCase() : null;
      filename = part.filename ?? '';
    }

    if (!bytes || bytes.length === 0) {
      throw ApiError.badRequest('missing_file', 'Attach the receipt as `file`');
    }

    if (!kind) {
      if (mimeType?.startsWith('video/')) kind = 'video';
      else if (mimeType?.startsWith('image/')) kind = 'photo';
      else throw ApiError.badRequest('invalid_kind', 'kind must be `photo` or `video`');
    }

    if (mimeType && mimeType !== 'application/octet-stream') {
      if (kind === 'photo' && !mimeType.startsWith('image/')) {
        throw ApiError.badRequest('invalid_file_type', 'A photo receipt must be an image');
      }
      if (kind === 'video' && !mimeType.startsWith('video/')) {
        throw ApiError.badRequest('invalid_file_type', 'A video receipt must be a video');
      }
    }

    const mediaId = randomUUID();
    const storageKey = `${billId}/${mediaId}${extensionFor(mimeType ?? '', filename, kind)}`;
    const target = mediaPath(storageKey);

    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);

    await query(
      `insert into bill_media (id, bill_id, kind, storage_key, mime_type, status)
       values ($1, $2, $3, $4, $5, 'stored')`,
      [mediaId, billId, kind, storageKey, mimeType],
    );

    return { mediaId, status: 'stored' };
  });

  /** Kick off extraction; the response returns before the vision call finishes. */
  app.post<BillParams>('/bills/:id/parse', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }
    if (ctx.status === 'PARSING') return { status: 'PARSING' };

    return startBillParse({
      billId,
      agreementId: ctx.agreementId,
      groupId: ctx.groupId,
      memberId: ctx.member.id,
      actor: ctx.member.displayName,
      currency: ctx.currency,
      log: request.log,
    });
  });

  app.get<BillParams>('/bills/:id', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);

    // Bills confirmed before the split locked itself, and any bill whose
    // implicit lock failed, would sit at CONFIRMED with no shares forever.
    // Heal them on read: the lock is idempotent and serialised on the bill row,
    // so this only ever runs once per stuck bill.
    await withTransaction(async (tx) => {
      const { rows } = await tx.query<{ status: string }>(
        `select status from bills where id = $1 for update`,
        [billId],
      );
      const status = rows[0]?.status;
      if (status !== 'CONFIRMED' && status !== 'ALLOCATED') return;

      const { rows: pendingRows } = await tx.query<{ pending: number }>(
        `select count(*)::int as pending
           from allocations al
           join bill_items bi on bi.id = al.bill_item_id
          where bi.bill_id = $1 and al.status = 'proposed'`,
        [billId],
      );
      if ((pendingRows[0]?.pending ?? 0) > 0) return;

      const outcome = await finalizeBill(tx, {
        billId,
        actorMemberId: ctx.member.id,
        actorName: ctx.member.displayName,
        fallbackFronterId: ctx.member.id,
      });
      if (!outcome.ok) {
        request.log.warn({ billId, reason: outcome.reason }, 'lazy lock skipped');
      }
    });

    const [bill, allocations, shares] = await Promise.all([
      loadBill(billId),
      loadAllocations(billId),
      loadShares(billId),
    ]);

    // A checkout PayPal refused never returns to us, so a `requested` share can
    // be dead. Re-read only the caller's own order before rendering it.
    const mine = shares.find((share) => share.member_id === ctx.member.id);
    const reconciled = mine ? await reconcileShare(mine) : null;

    return {
      bill: mapBill(bill.bill, bill.items),
      allocations: allocations.map(mapAllocation),
      shares: shares.map((share) =>
        share === mine && reconciled
          ? mapShare({ ...share, status: reconciled.status }, reconciled.canFinish)
          : mapShare(share),
      ),
    };
  });

  /** Replace the whole split. Amounts are largest-remainder per line item. */
  app.patch<BillParams>('/bills/:id/allocations', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (LOCKED.has(ctx.status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    const body = asRecord(request.body);
    const raw = body.allocations;
    if (!Array.isArray(raw)) {
      throw ApiError.badRequest('invalid_allocations', 'allocations must be an array');
    }
    if (raw.length > 500) {
      throw ApiError.badRequest('invalid_allocations', 'Too many allocations in one request');
    }

    const entries = raw.map((entry) => {
      const record = asRecord(entry);
      const billItemId = requiredUuid(record, 'billItemId');
      const memberId = requiredUuid(record, 'memberId');
      const qtyValue = record.qty;
      const qty =
        typeof qtyValue === 'number' && Number.isFinite(qtyValue) && qtyValue > 0
          ? Math.min(Math.round(qtyValue * 100) / 100, 99)
          : 1;
      return { billItemId, memberId, qty };
    });

    const { rows: itemRows } = await query<BillItemTotalRow>(
      `select id, line_total from bill_items where bill_id = $1`,
      [billId],
    );
    if (itemRows.length === 0) {
      throw ApiError.conflict('bill_empty', 'This bill has no items yet');
    }
    const lineTotals = new Map(itemRows.map((row) => [row.id, row.line_total]));

    const { rows: memberRows } = await query<{ id: string }>(
      `select id from members where group_id = $1 and status <> 'removed'`,
      [ctx.groupId],
    );
    const memberIds = new Set(memberRows.map((row) => row.id));

    const grouped = new Map<
      string,
      { billItemId: string; memberId: string; qty: number }[]
    >();
    for (const entry of entries) {
      if (!lineTotals.has(entry.billItemId)) {
        throw ApiError.badRequest(
          'invalid_billItemId',
          'An item does not belong to this bill',
        );
      }
      if (!memberIds.has(entry.memberId)) {
        throw ApiError.badRequest(
          'invalid_memberId',
          'A member does not belong to this group',
        );
      }

      const list = grouped.get(entry.billItemId) ?? [];
      if (list.some((item) => item.memberId === entry.memberId)) continue;
      list.push(entry);
      grouped.set(entry.billItemId, list);
    }

    await withTransaction(async (tx) => {
      await tx.query(
        `delete from allocations
          where bill_item_id in (select id from bill_items where bill_id = $1)`,
        [billId],
      );

      for (const [billItemId, list] of grouped) {
        const lineTotal = lineTotals.get(billItemId) ?? 0;
        const parts = allocate(
          lineTotal,
          list.map((item) => item.qty),
        );

        for (let index = 0; index < list.length; index += 1) {
          const entry = list[index];
          if (!entry) continue;
          await tx.query(
            `insert into allocations (bill_item_id, member_id, qty, amount, status)
             values ($1, $2, $3, $4, 'proposed')`,
            [billItemId, entry.memberId, entry.qty, parts[index] ?? 0],
          );
        }
      }

      await tx.query(
        `update bills
            set status = 'ALLOCATED', version = version + 1
          where id = $1 and status in ${EDITABLE}`,
        [billId],
      );

      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'bill.allocated',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `${ctx.member.displayName} split the bill — each member confirms their own lines`,
      });
    });

    const allocations = await loadAllocations(billId);
    return { allocations: allocations.map(mapAllocation) };
  });

  /** A member confirms only the lines assigned to them. Idempotent. */
  app.post<AllocationParams>('/allocations/:id/confirm', async (request) => {
    const allocationId = pathUuid(request.params.id);

    const { rows } = await query<AllocationConfirmRow>(
      `select al.id, al.bill_item_id, al.member_id, al.amount, al.status,
              b.id as bill_id, a.group_id, b.currency, b.status as bill_status
         from allocations al
         join bill_items bi on bi.id = al.bill_item_id
         join bills b on b.id = bi.bill_id
         join agreements a on a.id = b.agreement_id
        where al.id = $1`,
      [allocationId],
    );
    const allocation = rows[0];
    if (!allocation) throw ApiError.notFound('Allocation not found');

    const member = await requireBillMember(request, allocation.bill_id);
    if (member.member.id !== allocation.member_id) {
      throw new ApiError(403, 'not_your_line', 'You can only confirm your own items');
    }
    if (LOCKED.has(allocation.bill_status)) {
      throw ApiError.conflict('bill_locked', 'This bill is already locked');
    }

    if (allocation.status !== 'confirmed') {
      await withTransaction(async (tx) => {
        // Serialize confirmations on the bill row. Without this lock the last
        // two taps can each read "one line still pending" and the split would
        // never be locked.
        await tx.query(`select id from bills where id = $1 for update`, [
          allocation.bill_id,
        ]);

        await tx.query(
          `insert into item_confirmations (allocation_id, member_id, status, confirmed_amount)
           values ($1, $2, 'confirmed', $3)`,
          [allocationId, allocation.member_id, allocation.amount],
        );
        await tx.query(
          `update allocations set status = 'confirmed'
            where id = $1 and status = 'proposed'`,
          [allocationId],
        );

        const { rows: pendingRows } = await tx.query<{ pending: number }>(
          `select count(*)::int as pending
             from allocations al
             join bill_items bi on bi.id = al.bill_item_id
            where bi.bill_id = $1 and al.status = 'proposed'`,
          [allocation.bill_id],
        );
        const pending = pendingRows[0]?.pending ?? 0;

        if (pending === 0) {
          await tx.query(
            `update bills set status = 'CONFIRMED'
              where id = $1 and status in ('UPLOADED', 'PARSED', 'ALLOCATED')`,
            [allocation.bill_id],
          );
        }

        await recordEvent(tx, {
          groupId: allocation.group_id,
          agreementId: null,
          memberId: allocation.member_id,
          eventType: 'allocation.confirmed',
          amountMinor: allocation.amount,
          currency: allocation.currency,
          actor: member.member.displayName,
          summary: `${member.member.displayName} confirmed their line`,
        });

        if (pending === 0) {
          // The last line is confirmed, so the split is final. Create the
          // shares right here: nobody should have to be told to lock the bill
          // afterwards, and a member who confirmed everything must not be left
          // looking at an empty Shares screen.
          const outcome = await finalizeBill(tx, {
            billId: allocation.bill_id,
            actorMemberId: allocation.member_id,
            actorName: member.member.displayName,
            fallbackFronterId: allocation.member_id,
          });
          if (!outcome.ok) {
            // The bill stays CONFIRMED and the fronter can retry the split.
            request.log.warn(
              { billId: allocation.bill_id, reason: outcome.reason },
              'auto-lock skipped',
            );
          }
        }
      });
    }

    return { allocation: mapAllocation(await loadAllocation(allocationId)) };
  });

  /**
   * Turn confirmed lines into one share per member. The last confirmation
   * already does this implicitly; the route stays for bills whose split could
   * not be built at confirm time and for a fronter retrying by hand.
   */
  app.post<BillParams>('/bills/:id/finalize', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    const current = await loadBill(billId);

    if (current.bill.status === 'FINALIZED' || current.bill.status === 'COLLECTING') {
      const shares = await loadShares(billId);
      return {
        bill: mapBill(current.bill, current.items),
        shares: shares.map((share) => mapShare(share)),
      };
    }

    const outcome = await withTransaction((tx) =>
      finalizeBill(tx, {
        billId,
        actorMemberId: ctx.member.id,
        actorName: ctx.member.displayName,
        fallbackFronterId: ctx.member.id,
      }),
    );
    if (!outcome.ok) throw ApiError.conflict(outcome.reason, outcome.message);

    const [bill, shares] = await Promise.all([loadBill(billId), loadShares(billId)]);

    return {
      bill: mapBill(bill.bill, bill.items),
      shares: shares.map((share) => mapShare(share)),
    };
  });

  /** One PayPal order per share, approved in the system browser. */
  app.post<BillParams>('/bills/:id/request-payments', async (request) => {
    const billId = pathUuid(request.params.id);
    const ctx = await requireBillMember(request, billId);
    requireFronter(ctx);

    if (ctx.status !== 'FINALIZED' && ctx.status !== 'COLLECTING') {
      throw ApiError.conflict(
        'bill_not_finalized',
        'Finalize the bill before requesting payments',
      );
    }

    if (!isPayPalConfigured()) {
      throw ApiError.conflict(
        'paypal_not_configured',
        'PayPal sandbox credentials are not configured on this server',
      );
    }

    const { bill } = await loadBill(billId);
    const shares = await loadShares(billId);

    const collected = shares.reduce((sum, row) => sum + row.amount, 0);
    if (collected !== bill.total) {
      throw ApiError.conflict(
        'totals_mismatch',
        'Shares do not add up to the bill total',
      );
    }

    // A checkout the member abandoned — or one PayPal refused at its own page —
    // never comes back to us, so a `requested` share can be dead while the row
    // still reads "Payment requested". Re-read those orders before deciding what
    // is outstanding, and hand back the links that are already live so pressing
    // the button again reopens them instead of doing nothing.
    const outstanding: typeof shares = [];
    const requests: {
      shareId: string;
      approveUrl: string | null;
      paymentMode: PaymentMode;
    }[] = [];

    for (const share of shares) {
      if (share.status === 'proposed' || share.status === 'failed') {
        outstanding.push(share);
        continue;
      }
      if (share.status !== 'requested') continue;

      // A PayPal.Me link has no order behind it, so there is nothing to re-read.
      if (share.payment_mode === 'paypal_me') {
        if (share.paypal_approve_url) {
          requests.push({
            shareId: share.id,
            approveUrl: share.paypal_approve_url,
            paymentMode: 'paypal_me',
          });
        }
        continue;
      }

      const state = await reconcileShare(share);
      // PayPal already holds an approval we can capture; a second order would
      // let the member pay twice instead of finishing the first one.
      if (state.canFinish) continue;
      if (state.status === 'failed') {
        outstanding.push({ ...share, status: 'failed' });
      } else if (share.paypal_approve_url) {
        requests.push({
          shareId: share.id,
          approveUrl: share.paypal_approve_url,
          paymentMode: 'payee_direct',
        });
      }
    }

    const currency = bill.currency.trim();

    for (const share of outstanding) {
      const result = await requestPaymentForShare({
        share,
        merchant: bill.merchant,
        currency,
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        actor: { memberId: ctx.member.id, displayName: ctx.member.displayName },
      });
      requests.push({
        shareId: result.shareId,
        approveUrl: result.approveUrl,
        paymentMode: result.paymentMode,
      });
    }

    await query(
      `update bills set status = 'COLLECTING'
        where id = $1 and status in ('FINALIZED', 'COLLECTING')`,
      [billId],
    );

    return { requests };
  });
};
