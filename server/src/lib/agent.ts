/**
 * The Globie agent (DEV_PLAN §2.11).
 *
 * One deterministic dispatcher over the seven tools the product promises. Every
 * call is authorised against the database — never on the ids the caller claims —
 * audited to `agent_events`, and the four tools that move money or people need a
 * short-lived HMAC confirmation token issued by a previous, unconfirmed call.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import { query, withTransaction } from '../db/pool.js';
import {
    requireAgreementMember,
    requireBillMember,
    requireFronter,
} from './access.js';
import {
    LOCKED,
    loadAllocations,
    loadBill,
    loadShareById,
    loadShares,
    requestPaymentForShare,
    startBillParse,
} from './bills.js';
import { config, isProduction } from './config.js';
import { ApiError } from './http-error.js';
import { recordEvent } from './ledger.js';
import { allocate } from './money.js';
import { reminderMessage } from './notify.js';
import { formatAmount } from './paypal.js';
import { mapAllocation, mapBillItem, mapShare } from './serialize.js';
import { awardGlobie } from './settlement.js';
import { asRecord, optionalString, pathUuid, requiredUuid } from './validate.js';

export const AGENT_TOOLS = [
  'parse_receipt_media',
  'propose_allocation',
  'request_item_confirmation',
  'create_payment_request',
  'get_bill_status',
  'send_reminder',
  'award_points',
] as const;

export type AgentToolName = (typeof AGENT_TOOLS)[number];

/** Tools that must be confirmed out-of-band before they take effect. */
const CONFIRMATION_TOOLS = new Set<AgentToolName>([
  'create_payment_request',
  'send_reminder',
  'award_points',
]);

const CONFIRM_QUESTION: Record<string, string> = {
  create_payment_request:
    'This sends a real PayPal payment request to a member. Confirm to continue.',
  send_reminder: 'This messages the member. Confirm to send it.',
  award_points: 'This writes Globie points. Confirm to continue.',
};

const REMINDER_TONES = new Set(['friendly', 'firm', 'final']);

const CONFIRM_TTL_MS = 10 * 60 * 1000;
const DEV_CONFIRM_SECRET = 'globie-dev-confirm';

// ---------------------------------------------------------------------------
// Confirmation tokens
// ---------------------------------------------------------------------------

function confirmKey(): string {
  const secret = config.agentConfirmSecret || (isProduction ? '' : DEV_CONFIRM_SECRET);
  if (!secret) {
    throw new ApiError(
      503,
      'agent_not_configured',
      'Set AGENT_CONFIRMATION_SECRET before the agent can move money',
    );
  }
  return secret;
}

/** Stable JSON so the same arguments always hash to the same token. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function argsFingerprint(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonical(args)).digest('hex');
}

function sign(payload: string): string {
  return createHmac('sha256', confirmKey()).update(payload).digest('base64url');
}

function issueConfirmation(input: {
  memberId: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
}): string {
  const payload = Buffer.from(
    JSON.stringify({
      a: input.memberId,
      t: input.tool,
      h: argsFingerprint(input.args),
      e: Date.now() + CONFIRM_TTL_MS,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function verifyConfirmation(input: {
  memberId: string;
  tool: AgentToolName;
  args: Record<string, unknown>;
  token: string;
}): boolean {
  const [payload, mac] = input.token.split('.');
  if (!payload || !mac) return false;

  const given = Buffer.from(mac);
  const expected = Buffer.from(sign(payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return false;
  }

  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { a?: unknown; t?: unknown; h?: unknown; e?: unknown };
    return (
      claims.a === input.memberId &&
      claims.t === input.tool &&
      claims.h === argsFingerprint(input.args) &&
      typeof claims.e === 'number' &&
      claims.e > Date.now()
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

type ToolOutcome = {
  groupId: string;
  executed: boolean;
  confirmationRequired: boolean;
  confirmToken: string | null;
  result: Record<string, unknown>;
  reply: string;
};

type ConfirmationPending = {
  confirmationRequired: true;
  confirmToken: string;
  result: Record<string, unknown>;
  reply: string;
};

/** Returns a challenge when the token is missing, and `null` once it checks out. */
function demandConfirmation(
  tool: AgentToolName,
  args: Record<string, unknown>,
  confirmToken: string | null,
  memberId: string,
): ConfirmationPending | null {
  const token = confirmToken?.trim();
  if (token) {
    if (!verifyConfirmation({ memberId, tool, args, token })) {
      throw ApiError.badRequest(
        'invalid_confirmation',
        'That confirmation token is invalid or has expired — ask again',
      );
    }
    return null;
  }

  return {
    confirmationRequired: true,
    confirmToken: issueConfirmation({ memberId, tool, args }),
    result: { tool, args },
    reply: CONFIRM_QUESTION[tool] ?? 'Confirm to continue.',
  };
}

function billTotals(bill: {
  subtotal: number;
  tax: number;
  service_charge: number;
  tip: number;
  discount: number;
  total: number;
}) {
  return {
    subtotalMinor: bill.subtotal,
    taxMinor: bill.tax,
    serviceChargeMinor: bill.service_charge,
    tipMinor: bill.tip,
    discountMinor: bill.discount,
    totalMinor: bill.total,
  };
}

// --- parse_receipt_media ---------------------------------------------------

const parseReceiptMedia: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  if (ctx.status === 'PARSING') {
    return {
      groupId: ctx.groupId,
      executed: false,
      confirmationRequired: false,
      confirmToken: null,
      result: { status: 'PARSING', items: [], totals: null, warnings: [], confidence: 0 },
      reply: 'I am still reading that receipt — ask me again in a moment.',
    };
  }

  await startBillParse({
    billId,
    agreementId: ctx.agreementId,
    groupId: ctx.groupId,
    memberId: ctx.member.id,
    actor: ctx.member.displayName,
    currency: ctx.currency,
    log: request.log,
    wait: true,
  });

  const { bill, items } = await loadBill(billId);
  const confidences = items
    .map((item) => Number(item.confidence))
    .filter((value) => Number.isFinite(value));
  const confidence =
    confidences.length > 0
      ? Number(
          (
            confidences.reduce((sum, value) => sum + value, 0) /
            confidences.length
          ).toFixed(3),
        )
      : 0;

  const warnings = Array.isArray(bill.warnings) ? bill.warnings.map(String) : [];
  const reply =
    bill.status === 'PARSED'
      ? `I read ${items.length} line${items.length === 1 ? '' : 's'} from ${
          bill.merchant ?? 'the receipt'
        } — ${formatAmount(bill.total, bill.currency.trim())} ${bill.currency.trim()}.`
      : 'I could not read that receipt — try a clearer photo or a short video.';

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      status: bill.status,
      merchant: bill.merchant,
      currency: bill.currency.trim(),
      items: items.map(mapBillItem),
      totals: billTotals(bill),
      warnings,
      confidence,
    },
    reply,
  };
};

// --- propose_allocation ----------------------------------------------------

function hintedMembers(args: Record<string, unknown>): string[] | null {
  if (args.hints === undefined || args.hints === null) return null;

  const hints = asRecord(args.hints);
  const raw = hints.member_ids ?? hints.memberIds;
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw)) {
    throw ApiError.badRequest('invalid_hints', 'hints.member_ids must be an array');
  }

  const ids = raw.map((value) => pathUuid(value, 'member_ids'));
  return [...new Set(ids)];
}

const proposeAllocation: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  const { bill, items } = await loadBill(billId);
  if (items.length === 0) {
    throw ApiError.conflict('bill_empty', 'Read the receipt before splitting it');
  }

  const { rows: memberRows } = await query<{ id: string }>(
    `select m.id
       from members m
      where m.group_id = $1 and m.status <> 'removed'
      order by m.joined_at asc`,
    [ctx.groupId],
  );
  const activeIds = new Set(memberRows.map((row) => row.id));

  const hinted = hintedMembers(args);
  if (hinted) {
    for (const id of hinted) {
      if (!activeIds.has(id)) {
        throw ApiError.badRequest(
          'invalid_member_ids',
          'A member does not belong to this group',
        );
      }
    }
  }

  const members = hinted && hinted.length > 0 ? hinted : [...activeIds];
  if (members.length === 0) {
    throw ApiError.conflict('no_members', 'This group has no active members');
  }

  await withTransaction(async (tx) => {
    // Replacing the split must also clear the previous one.
    await tx.query(
      `delete from allocations
        where bill_item_id in (select id from bill_items where bill_id = $1)`,
      [billId],
    );

    for (const item of items) {
      const parts = allocate(
        item.line_total,
        members.map(() => 1),
      );
      for (let index = 0; index < members.length; index += 1) {
        await tx.query(
          `insert into allocations (bill_item_id, member_id, qty, amount, status)
           values ($1, $2, 1, $3, 'proposed')`,
          [item.id, members[index], parts[index] ?? 0],
        );
      }
    }

    await tx.query(
      `update bills set status = 'ALLOCATED', version = version + 1 where id = $1`,
      [billId],
    );

    await recordEvent(tx, {
      groupId: ctx.groupId,
      agreementId: ctx.agreementId,
      memberId: ctx.member.id,
      eventType: 'bill.allocated',
      currency: ctx.currency,
      actor: ctx.member.displayName,
      summary: `Globie split the bill equally across ${members.length} member${
        members.length === 1 ? '' : 's'
      } — each member confirms their own lines`,
      metadata: { tool: 'propose_allocation' },
    });
  });

  const allocations = await loadAllocations(billId);

  const lineSum = items.reduce((sum, item) => sum + item.line_total, 0);
  const questions: string[] = [];
  for (const item of items) {
    const expected = Math.round(Number(item.qty) * item.unit_price);
    if (expected !== item.line_total) {
      questions.push(
        `${item.name}: quantity × unit price does not match the line total.`,
      );
    }
  }
  if (lineSum !== bill.total) {
    questions.push(
      `The lines add up to ${formatAmount(lineSum, bill.currency.trim())} but the receipt says ${formatAmount(
        bill.total,
        bill.currency.trim(),
      )} — the difference lands on the fronter.`,
    );
  }

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      allocations: allocations.map(mapAllocation),
      questions,
    },
    reply: `I split ${items.length} line${items.length === 1 ? '' : 's'} across ${
      members.length
    } member${members.length === 1 ? '' : 's'}. Everyone still needs to confirm their own lines.`,
  };
};

// --- request_item_confirmation --------------------------------------------

const requestItemConfirmation: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  if (LOCKED.has(ctx.status)) {
    throw ApiError.conflict('bill_locked', 'This bill is already locked');
  }

  const { rows } = await query<{ id: string; member_id: string }>(
    `select al.id, al.member_id
       from allocations al
       join bill_items bi on bi.id = al.bill_item_id
      where bi.bill_id = $1 and al.status = 'proposed'
      order by al.created_at asc`,
    [billId],
  );

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const list = grouped.get(row.member_id) ?? [];
    list.push(row.id);
    grouped.set(row.member_id, list);
  }

  const { rows: versionRows } = await query<{ version: number }>(
    `select version from bills where id = $1`,
    [billId],
  );
  const version = versionRows[0]?.version ?? 1;

  let sent = 0;
  await withTransaction(async (tx) => {
    for (const [memberId, allocationIds] of grouped) {
      const { rowCount } = await tx.query(
        `insert into notification_outbox (channel, recipient, template, payload, idempotency_key)
         values ('in_app', $1, 'item_confirmation', $2::jsonb, $3)
         on conflict (idempotency_key) do nothing`,
        [
          memberId,
          JSON.stringify({ billId, memberId, allocationIds }),
          `item-confirm:${billId}:${memberId}:${version}`,
        ],
      );
      sent += rowCount ?? 0;
    }

    if (grouped.size > 0) {
      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId: ctx.agreementId,
        memberId: ctx.member.id,
        eventType: 'allocation.confirmation_requested',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `Globie asked ${grouped.size} member${
          grouped.size === 1 ? '' : 's'
        } to confirm their lines`,
        metadata: { tool: 'request_item_confirmation' },
      });
    }
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: { bill_id: billId, sent },
    reply:
      sent > 0
        ? `I asked ${sent} member${sent === 1 ? '' : 's'} to confirm their lines.`
        : 'Nobody has unconfirmed lines right now.',
  };
};

// --- create_payment_request ----------------------------------------------

const createPaymentRequest: ToolHandler = async (request, args, confirmToken) => {
  const billId = requiredUuid(args, 'bill_id');
  const shareId = requiredUuid(args, 'share_id');
  const ctx = await requireBillMember(request, billId);
  requireFronter(ctx);

  const gate = demandConfirmation(
    'create_payment_request',
    args,
    confirmToken,
    ctx.member.id,
  );
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  if (ctx.status !== 'FINALIZED' && ctx.status !== 'COLLECTING') {
    throw ApiError.conflict(
      'bill_not_finalized',
      'Finalize the bill before requesting payments',
    );
  }

  const share = await loadShareById(shareId);
  if (share.bill_id !== billId) {
    throw ApiError.badRequest(
      'share_not_on_bill',
      'That share belongs to another bill',
    );
  }

  const { bill } = await loadBill(billId);
  const shares = await loadShares(billId);
  const collected = shares.reduce((sum, row) => sum + row.amount, 0);
  if (collected !== bill.total) {
    throw ApiError.conflict('totals_mismatch', 'Shares do not add up to the bill total');
  }

  const result = await requestPaymentForShare({
    share,
    merchant: bill.merchant,
    currency: ctx.currency,
    groupId: ctx.groupId,
    agreementId: ctx.agreementId,
    actor: { memberId: ctx.member.id, displayName: ctx.member.displayName },
  });

  await query(
    `update bills set status = 'COLLECTING'
      where id = $1 and status in ('FINALIZED', 'COLLECTING')`,
    [billId],
  );

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      share_id: result.shareId,
      paypal_order_id: result.paypalOrderId,
      approve_url: result.approveUrl,
      payment_mode: result.paymentMode,
      amount: result.amount,
      currency: result.currency,
    },
    reply:
      result.paymentMode === 'paypal_me'
        ? `I sent ${share.member_name} a PayPal.Me link to pay ${formatAmount(
            result.amount,
            result.currency,
          )} ${result.currency} to the fronter.`
        : `I sent ${share.member_name} a PayPal request for ${formatAmount(
            result.amount,
            result.currency,
          )} ${result.currency}.`,
  };
};

// --- get_bill_status -------------------------------------------------------

const getBillStatus: ToolHandler = async (request, args) => {
  const billId = requiredUuid(args, 'bill_id');
  const ctx = await requireBillMember(request, billId);

  const [{ bill }, shares] = await Promise.all([loadBill(billId), loadShares(billId)]);
  const outstanding = shares.filter(
    (row) => !['paid', 'settled', 'refunded'].includes(row.status),
  );
  const outstandingMinor = outstanding.reduce((sum, row) => sum + row.amount, 0);

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      bill_id: billId,
      status: bill.status,
      shares: shares.map((share) => mapShare(share)),
      totals: billTotals(bill),
      outstanding: {
        count: outstanding.length,
        amountMinor: outstandingMinor,
        shareIds: outstanding.map((row) => row.id),
      },
    },
    reply:
      outstanding.length === 0
        ? 'Everyone has paid — this bill is settled.'
        : `${outstanding.length} share${
            outstanding.length === 1 ? '' : 's'
          } still open: ${formatAmount(outstandingMinor, bill.currency.trim())} ${bill.currency
            .trim()
            .toString()} outstanding.`,
  };
};

// --- send_reminder ---------------------------------------------------------

const sendReminder: ToolHandler = async (request, args, confirmToken) => {
  const shareId = requiredUuid(args, 'share_id');
  const tone = optionalString(args, 'tone', 16)?.toLowerCase() ?? 'friendly';
  if (!REMINDER_TONES.has(tone)) {
    throw ApiError.badRequest('invalid_tone', 'tone must be friendly, firm or final');
  }

  const share = await loadShareById(shareId);
  const ctx = await requireBillMember(request, share.bill_id);
  requireFronter(ctx);

  const gate = demandConfirmation('send_reminder', args, confirmToken, ctx.member.id);
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  if (['paid', 'settled', 'refunded'].includes(share.status)) {
    throw ApiError.conflict('share_already_paid', 'This share is already paid');
  }

  const currency = share.currency.trim();
  const message = reminderMessage({
    firstName: share.member_name.split(' ')[0] ?? share.member_name,
    amount: formatAmount(share.amount, currency),
    currency,
    groupName: share.group_name,
    tone,
  });

  const day = new Date().toISOString().slice(0, 10);
  const idempotencyKey = `reminder:${shareId}:${tone}:${day}`;

  const sentAt = await withTransaction(async (tx) => {
    const { rows } = await tx.query<{ sent_at: Date }>(
      `insert into reminders
         (share_id, scheduled_for, sent_at, channel, template, message, idempotency_key, status)
       values ($1, now(), now(), 'in_app', 'reminder', $2, $3, 'sent')
       on conflict (idempotency_key) do nothing
       returning sent_at`,
      [shareId, message, idempotencyKey],
    );

    await tx.query(
      `insert into notification_outbox (channel, recipient, template, payload, idempotency_key)
       values ('in_app', $1, 'reminder', $2::jsonb, $3)
       on conflict (idempotency_key) do nothing`,
      [
        share.member_id,
        JSON.stringify({
          shareId,
          billId: share.bill_id,
          tone,
          message,
          amountMinor: share.amount,
          currency,
        }),
        `outbox:${idempotencyKey}`,
      ],
    );

    await recordEvent(tx, {
      groupId: ctx.groupId,
      agreementId: ctx.agreementId,
      shareId,
      memberId: share.member_id,
      eventType: 'reminder.sent',
      amountMinor: share.amount,
      currency,
      actor: ctx.member.displayName,
      summary: `Globie nudged ${share.member_name} (${tone})`,
      metadata: { tool: 'send_reminder', tone },
    });

    return rows[0]?.sent_at ?? new Date();
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: { share_id: shareId, tone, message, sent_at: sentAt.toISOString() },
    reply: `Reminder sent to ${share.member_name}.`,
  };
};

// --- award_points ----------------------------------------------------------

const awardPoints: ToolHandler = async (request, args, confirmToken) => {
  const agreementId = requiredUuid(args, 'agreement_id');
  const shareId = requiredUuid(args, 'share_id');
  const reason = optionalString(args, 'reason', 40) ?? 'globie';

  const ctx = await requireAgreementMember(request, agreementId);
  requireFronter(ctx);

  const gate = demandConfirmation('award_points', args, confirmToken, ctx.member.id);
  if (gate) {
    return { groupId: ctx.groupId, executed: false, ...gate };
  }

  const share = await loadShareById(shareId);
  if (share.agreement_id !== agreementId) {
    throw ApiError.badRequest(
      'share_not_in_agreement',
      'That share belongs to another agreement',
    );
  }
  if (!['paid', 'settled'].includes(share.status)) {
    throw ApiError.conflict(
      'share_unpaid',
      'Globie is awarded when the share is paid',
    );
  }

  const award = await withTransaction(async (tx) => {
    const result = await awardGlobie(tx, {
      agreementId,
      groupId: ctx.groupId,
      memberId: share.member_id,
      shareId,
      reason,
    });

    if (result.delta > 0) {
      await recordEvent(tx, {
        groupId: ctx.groupId,
        agreementId,
        shareId,
        memberId: share.member_id,
        eventType: 'globie.awarded',
        currency: ctx.currency,
        actor: ctx.member.displayName,
        summary: `Globie awarded ${share.member_name} +${result.delta} (rank ${result.rank})`,
        metadata: { tool: 'award_points', reason },
      });
    }

    return result;
  });

  return {
    groupId: ctx.groupId,
    executed: true,
    confirmationRequired: false,
    confirmToken: null,
    result: {
      share_id: shareId,
      delta: award.delta,
      balance: award.balance,
      rank: award.rank,
      reason,
    },
    reply:
      award.delta > 0
        ? `${share.member_name} earned ${award.delta} Globie — balance ${award.balance}.`
        : `${share.member_name} already had this award; balance stays at ${award.balance}.`,
  };
};

// ---------------------------------------------------------------------------

type ToolHandler = (
  request: FastifyRequest,
  args: Record<string, unknown>,
  confirmToken: string | null,
) => Promise<ToolOutcome>;

const HANDLERS: Record<AgentToolName, ToolHandler> = {
  parse_receipt_media: parseReceiptMedia,
  propose_allocation: proposeAllocation,
  request_item_confirmation: requestItemConfirmation,
  create_payment_request: createPaymentRequest,
  get_bill_status: getBillStatus,
  send_reminder: sendReminder,
  award_points: awardPoints,
};

export type AgentResponse = ToolOutcome & { tool: AgentToolName };

function parseTool(value: string): AgentToolName {
  if (!(AGENT_TOOLS as readonly string[]).includes(value)) {
    throw ApiError.badRequest(
      'unknown_tool',
      `Unknown tool "${value}" — one of ${AGENT_TOOLS.join(', ')}`,
    );
  }
  return value as AgentToolName;
}

/**
 * Run one tool and append it to `agent_events`. Authorisation happens inside the
 * handler, so a refused call is still audited with whatever the caller claimed.
 */
export async function runAgentTool(input: {
  request: FastifyRequest;
  tool: string;
  args: Record<string, unknown>;
  confirmToken: string | null;
}): Promise<AgentResponse> {
  const startedAt = Date.now();
  const actor = input.request.auth?.displayName ?? 'anonymous';
  let groupId: string | null = null;
  let output: Record<string, unknown> = {};
  let confirmed = false;

  try {
    const tool = parseTool(input.tool);
    confirmed = Boolean(
      CONFIRMATION_TOOLS.has(tool) && input.confirmToken?.trim(),
    );

    const outcome = await HANDLERS[tool](input.request, input.args, input.confirmToken);
    groupId = outcome.groupId;
    output = outcome.executed
      ? outcome.result
      : { confirmationRequired: outcome.confirmationRequired, result: outcome.result };

    return { tool, ...outcome };
  } catch (error) {
    output = {
      error: error instanceof ApiError ? error.code : 'internal_error',
      message: error instanceof Error ? error.message : 'Unexpected failure',
    };
    throw error;
  } finally {
    await query(
      `insert into agent_events (group_id, actor, tool, input, output, latency_ms)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        groupId,
        actor,
        input.tool.slice(0, 64) || 'unknown',
        JSON.stringify({ args: input.args, confirmed }),
        JSON.stringify(output),
        Date.now() - startedAt,
      ],
    ).catch((error: unknown) => {
      input.request.log.warn({ err: error }, 'agent_events insert failed');
    });
  }
}
