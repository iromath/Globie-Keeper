import type { FastifyRequest } from 'fastify';

import { query } from '../db/pool.js';
import { ApiError } from '../lib/http-error.js';
import { requireUser } from '../plugins/auth.js';

export type MemberContext = {
  id: string;
  groupId: string;
  userId: string;
  displayName: string;
  role: 'owner' | 'fronter' | 'member';
  status: string;
};

type MemberQueryRow = {
  id: string;
  group_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: string;
};

/** Resolve the caller's active membership in a group or reject the request. */
export async function requireMember(
  request: FastifyRequest,
  groupId: string,
): Promise<MemberContext> {
  const auth = requireUser(request);

  const { rows } = await query<MemberQueryRow>(
    `select m.id, m.group_id, m.user_id, u.display_name, m.role, m.status
       from members m
       join users u on u.id = m.user_id
      where m.group_id = $1 and m.user_id = $2 and m.status <> 'removed'`,
    [groupId, auth.userId],
  );

  const row = rows[0];
  if (!row) throw ApiError.forbidden();

  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role as MemberContext['role'],
    status: row.status,
  };
}

export type AgreementContext = {
  agreementId: string;
  groupId: string;
  currency: string;
  status: string;
  frontedBy: string | null;
  member: MemberContext;
};

export async function requireAgreementMember(
  request: FastifyRequest,
  agreementId: string,
): Promise<AgreementContext> {
  const { rows } = await query<{
    group_id: string;
    currency: string;
    status: string;
    fronted_by: string | null;
  }>(
    `select group_id, currency, status, fronted_by
       from agreements where id = $1`,
    [agreementId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Agreement not found');

  const member = await requireMember(request, row.group_id);
  return {
    agreementId,
    groupId: row.group_id,
    currency: row.currency.trim(),
    status: row.status,
    frontedBy: row.fronted_by,
    member,
  };
}

export type ShareContext = {
  shareId: string;
  billId: string;
  agreementId: string;
  groupId: string;
  amount: number;
  currency: string;
  status: string;
  paypalOrderId: string | null;
  /** Snapshot of how the fronter asked to be reimbursed for this share. */
  paymentMode: string | null;
  member: MemberContext;
};

/** Only the member who owes a share may pay it. */
export async function requireShareMember(
  request: FastifyRequest,
  shareId: string,
): Promise<ShareContext> {
  const { rows } = await query<{
    bill_id: string;
    agreement_id: string;
    group_id: string;
    amount: number;
    currency: string;
    status: string;
    paypal_order_id: string | null;
    payment_mode: string | null;
    user_id: string;
  }>(
    `select s.bill_id, b.agreement_id, a.group_id, s.amount, s.currency,
            s.status, s.paypal_order_id, s.payment_mode, m.user_id
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join members m on m.id = s.member_id
      where s.id = $1`,
    [shareId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Share not found');

  const member = await requireMember(request, row.group_id);
  if (member.userId !== row.user_id) {
    throw ApiError.forbidden('This share belongs to someone else');
  }

  return {
    shareId,
    billId: row.bill_id,
    agreementId: row.agreement_id,
    groupId: row.group_id,
    amount: row.amount,
    currency: row.currency.trim(),
    status: row.status,
    paypalOrderId: row.paypal_order_id,
    paymentMode: row.payment_mode,
    member,
  };
}

export type TipContext = {
  tipId: string;
  billId: string;
  agreementId: string;
  groupId: string;
  amount: number;
  currency: string;
  status: string;
  paypalOrderId: string | null;
  fromMemberId: string;
  toMemberId: string;
  /** Fee snapshot (DEV_PLAN §2.20); `gross` is what PayPal was asked for. */
  feeMinor: number;
  grossMinor: number | null;
  member: MemberContext;
};

/** Only the member who gave a tip may capture it. */
export async function requireTipMember(
  request: FastifyRequest,
  tipId: string,
): Promise<TipContext> {
  const { rows } = await query<{
    bill_id: string;
    agreement_id: string;
    group_id: string;
    amount: number;
    currency: string;
    status: string;
    paypal_order_id: string | null;
    from_member_id: string;
    to_member_id: string;
    fee_minor: number;
    gross_minor: number | null;
    user_id: string;
  }>(
    `select t.bill_id, t.agreement_id, a.group_id, t.amount, t.currency,
            t.status, t.paypal_order_id, t.from_member_id, t.to_member_id,
            t.fee_minor, t.gross_minor, fm.user_id
       from tips t
       join bills b on b.id = t.bill_id
       join agreements a on a.id = t.agreement_id
       join members fm on fm.id = t.from_member_id
      where t.id = $1`,
    [tipId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Tip not found');

  const member = await requireMember(request, row.group_id);
  if (member.userId !== row.user_id) {
    throw ApiError.forbidden('This tip belongs to someone else');
  }

  return {
    tipId,
    billId: row.bill_id,
    agreementId: row.agreement_id,
    groupId: row.group_id,
    amount: row.amount,
    currency: row.currency.trim(),
    status: row.status,
    paypalOrderId: row.paypal_order_id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    feeMinor: row.fee_minor ?? 0,
    grossMinor: row.gross_minor ?? null,
    member,
  };
}

export type BillContext = {
  billId: string;
  agreementId: string;
  groupId: string;
  currency: string;
  status: string;
  frontedBy: string | null;
  member: MemberContext;
};

export async function requireBillMember(
  request: FastifyRequest,
  billId: string,
): Promise<BillContext> {
  const { rows } = await query<{
    agreement_id: string;
    group_id: string;
    currency: string;
    status: string;
    fronted_by: string | null;
  }>(
    `select b.agreement_id, a.group_id, b.currency, b.status, a.fronted_by
       from bills b
       join agreements a on a.id = b.agreement_id
      where b.id = $1`,
    [billId],
  );

  const row = rows[0];
  if (!row) throw ApiError.notFound('Bill not found');

  const member = await requireMember(request, row.group_id);
  return {
    billId,
    agreementId: row.agreement_id,
    groupId: row.group_id,
    currency: row.currency.trim(),
    status: row.status,
    frontedBy: row.fronted_by,
    member,
  };
}

type FronterScope = { frontedBy: string | null; member: MemberContext };

/** The fronter paid the merchant; only they steer the bill. */
export function isFronter(ctx: FronterScope): boolean {
  return ctx.frontedBy !== null && ctx.frontedBy === ctx.member.id;
}

export function requireFronter(ctx: FronterScope): void {
  if (!isFronter(ctx)) {
    throw new ApiError(403, 'fronter_only', 'Only the fronter can do this');
  }
}
