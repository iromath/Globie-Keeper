/**
 * Row -> JSON mappers. Every route speaks the camelCase shapes defined in
 * lib/types.ts so the Expo client can consume responses without adapters.
 * Money columns are bigint minor units and already arrive as JS numbers.
 */

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function numeric(value: number | string | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type SettledRateView = {
  fromCurrency: string;
  toCurrency: string;
  rate: number;
};

/**
 * `metadata.fx_rate` as written by settlement — PayPal's own rate for that
 * capture. Anything malformed is dropped rather than rendered.
 */
export function mapSettledRate(
  metadata: Record<string, unknown>,
): SettledRateView | null {
  const raw = metadata.fx_rate as
    | { fromCurrency?: unknown; toCurrency?: unknown; rate?: unknown }
    | undefined;
  if (!raw) return null;

  const fromCurrency = typeof raw.fromCurrency === 'string' ? raw.fromCurrency : '';
  const toCurrency = typeof raw.toCurrency === 'string' ? raw.toCurrency : '';
  const rate = numeric(raw.rate as number);

  if (!fromCurrency || !toCurrency || rate <= 0) return null;
  return { fromCurrency, toCurrency, rate };
}

export type GroupRow = {
  id: string;
  name: string;
  default_currency: string;
  owner_id: string;
  invite_token: string;
  created_at: Date;
};

export function mapGroup(row: GroupRow) {
  return {
    id: row.id,
    name: row.name,
    defaultCurrency: row.default_currency.trim(),
    ownerId: row.owner_id,
    inviteToken: row.invite_token,
    createdAt: iso(row.created_at),
  };
}

export type MemberRow = {
  id: string;
  group_id: string;
  user_id: string;
  display_name: string;
  role: string;
  status: string;
};

export function mapMember(row: MemberRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    userId: row.user_id,
    displayName: row.display_name,
    role: row.role as 'owner' | 'fronter' | 'member',
    status: row.status as 'invited' | 'active' | 'removed',
  };
}

export type AgreementRow = {
  id: string;
  group_id: string;
  currency: string;
  estimated_total: number;
  deadline: Date | null;
  status: string;
  created_by: string;
  accepted_count?: number | string;
  member_count?: number | string;
};

export function mapAgreement(row: AgreementRow) {
  return {
    id: row.id,
    groupId: row.group_id,
    currency: row.currency.trim(),
    estimatedTotalMinor: row.estimated_total,
    deadline: row.deadline ? iso(row.deadline) : null,
    status: row.status as
      | 'draft'
      | 'pending'
      | 'accepted'
      | 'cancelled'
      | 'settled',
    createdBy: row.created_by,
    acceptedCount: numeric(row.accepted_count),
    memberCount: numeric(row.member_count),
  };
}

export type BillRow = {
  id: string;
  agreement_id: string;
  merchant: string | null;
  currency: string;
  subtotal: number;
  tax: number;
  service_charge: number;
  tip: number;
  discount: number;
  total: number;
  status: string;
  warnings: unknown;
  frames_extracted: number;
};

export type BillItemRow = {
  id: string;
  name: string;
  qty: number | string;
  unit_price: number;
  line_total: number;
  confidence: number | string;
};

export function mapBillItem(row: BillItemRow) {
  return {
    id: row.id,
    name: row.name,
    qty: numeric(row.qty, 1),
    unitPriceMinor: row.unit_price,
    lineTotalMinor: row.line_total,
    confidence: numeric(row.confidence, 1),
  };
}

export function mapBill(row: BillRow, items: BillItemRow[]) {
  return {
    id: row.id,
    agreementId: row.agreement_id,
    merchant: row.merchant,
    currency: row.currency.trim(),
    subtotalMinor: row.subtotal,
    taxMinor: row.tax,
    serviceChargeMinor: row.service_charge,
    tipMinor: row.tip,
    discountMinor: row.discount,
    totalMinor: row.total,
    status: row.status,
    items: items.map(mapBillItem),
    framesExtracted: row.frames_extracted,
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
  };
}

export type AllocationRow = {
  id: string;
  bill_item_id: string;
  member_id: string;
  member_name: string;
  item_name: string;
  qty: number | string;
  amount: number;
  status: string;
};

export function mapAllocation(row: AllocationRow) {
  return {
    id: row.id,
    billItemId: row.bill_item_id,
    memberId: row.member_id,
    memberName: row.member_name,
    itemName: row.item_name,
    qty: numeric(row.qty, 1),
    amountMinor: row.amount,
    status: row.status as 'proposed' | 'confirmed' | 'disputed',
  };
}

export type ShareRow = {
  id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  group_name: string;
  member_id: string;
  member_name: string;
  amount: number;
  currency: string;
  status: string;
  due_at: Date | null;
  paid_at: Date | null;
  paypal_order_id?: string | null;
  paypal_approve_url?: string | null;
};

export function mapShare(row: ShareRow) {
  return {
    id: row.id,
    billId: row.bill_id,
    groupId: row.group_id,
    groupName: row.group_name,
    memberId: row.member_id,
    memberName: row.member_name,
    amountMinor: row.amount,
    currency: row.currency.trim(),
    status: row.status as
      | 'proposed'
      | 'requested'
      | 'paid'
      | 'settled'
      | 'disputed'
      | 'failed'
      | 'refunded',
    dueAt: row.due_at ? iso(row.due_at) : null,
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    paypalOrderId: row.paypal_order_id ?? null,
    approveUrl: row.paypal_approve_url ?? null,
  };
}

export type TipRow = {
  id: string;
  bill_id: string;
  from_member_id: string;
  from_member_name: string;
  to_member_id: string;
  to_member_name: string;
  amount: number;
  currency: string;
  message: string | null;
  status: string;
  paypal_order_id?: string | null;
  paypal_approve_url?: string | null;
  paid_at: Date | null;
  created_at: Date;
};

export function mapTip(row: TipRow) {
  return {
    id: row.id,
    billId: row.bill_id,
    fromMemberId: row.from_member_id,
    fromMemberName: row.from_member_name,
    toMemberId: row.to_member_id,
    toMemberName: row.to_member_name,
    amountMinor: row.amount,
    currency: row.currency.trim(),
    message: row.message,
    status: row.status as
      | 'proposed'
      | 'requested'
      | 'paid'
      | 'refunded'
      | 'failed',
    paidAt: row.paid_at ? iso(row.paid_at) : null,
    createdAt: iso(row.created_at),
    paypalOrderId: row.paypal_order_id ?? null,
    approveUrl: row.paypal_approve_url ?? null,
  };
}
