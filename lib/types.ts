export type Currency = string;

/** PayPal's own rate for a capture, read back from the provider response. */
export type SettledRate = {
  fromCurrency: Currency;
  toCurrency: Currency;
  rate: number;
};

export type Group = {
  id: string;
  name: string;
  defaultCurrency: Currency;
  ownerId: string;
  inviteToken: string;
  createdAt: string;
};

export type Member = {
  id: string;
  groupId: string;
  userId: string;
  displayName: string;
  role: 'owner' | 'fronter' | 'member';
  status: 'invited' | 'active' | 'removed';
};

export type Agreement = {
  id: string;
  groupId: string;
  currency: Currency;
  estimatedTotalMinor: number;
  deadline: string | null;
  status: 'draft' | 'pending' | 'accepted' | 'cancelled' | 'settled';
  createdBy: string;
  frontedBy: string | null;
  acceptedCount: number;
  memberCount: number;
};

export type BillItem = {
  id: string;
  name: string;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  confidence: number;
};

export type Bill = {
  id: string;
  agreementId: string;
  merchant: string | null;
  currency: Currency;
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  tipMinor: number;
  discountMinor: number;
  totalMinor: number;
  status: string;
  items: BillItem[];
  framesExtracted: number;
  warnings: string[];
};

export type Allocation = {
  id: string;
  billItemId: string;
  memberId: string;
  memberName: string;
  itemName: string;
  qty: number;
  amountMinor: number;
  status: 'proposed' | 'confirmed' | 'disputed';
};

export type Share = {
  id: string;
  billId: string;
  groupId: string;
  groupName?: string;
  memberId: string;
  memberName: string;
  amountMinor: number;
  currency: Currency;
  status:
    | 'proposed'
    | 'requested'
    | 'paid'
    | 'settled'
    | 'disputed'
    | 'failed'
    | 'refunded';
  dueAt: string | null;
  paidAt: string | null;
  /** PayPal order behind this share, once payments were requested. */
  paypalOrderId?: string | null;
  /** Browser approval link; the member resumes checkout from here. */
  approveUrl?: string | null;
  /** PayPal holds an approval we can still capture; only on a `requested` share. */
  canFinish?: boolean;
};

/**
 * A voluntary extra for the person who fronted the bill (DEV_PLAN §2.18).
 * Deliberately not a `Share`: a tip never settles anything, and it is paid to
 * the fronter directly, so it needs its own row.
 */
export type Tip = {
  id: string;
  billId: string;
  fromMemberId: string;
  fromMemberName: string;
  toMemberId: string;
  toMemberName: string;
  amountMinor: number;
  currency: Currency;
  message: string | null;
  status: 'proposed' | 'requested' | 'paid' | 'refunded' | 'failed';
  paidAt: string | null;
  createdAt: string;
  paypalOrderId?: string | null;
  /** Browser approval link; only present while the tip is `requested`. */
  approveUrl?: string | null;
  /** PayPal holds an approval we can still capture; only on a `requested` tip. */
  canFinish?: boolean;
};

export type TipsResponse = {
  billId: string;
  currency: Currency;
  frontedBy: string | null;
  frontedByName: string;
  canTip: boolean;
  /** Sum of tips that actually went through. */
  totalMinor: number;
  myTip: Tip | null;
  tips: Tip[];
};

export type LeaderboardRow = {
  memberId: string;
  memberName: string;
  frontedMinor: number;
  globieBalance: number;
  repaymentSpeedHours: number | null;
  isHero: boolean;
};

export type TimelineEvent = {
  id: string;
  at: string;
  actor: string;
  type: string;
  summary: string;
  amountMinor?: number;
  /** Only present on the cross-group feed (`GET /me/activity`). */
  groupId?: string;
  groupName?: string;
  currency?: Currency;
  /**
   * PayPal's own rate for the capture behind this event. Only present when the
   * payer's funding currency differed from the group currency.
   */
  settledRate?: SettledRate;
};

/** The seven tools of the agent contract (DEV_PLAN §2.11). */
export type AgentToolName =
  | 'parse_receipt_media'
  | 'propose_allocation'
  | 'request_item_confirmation'
  | 'create_payment_request'
  | 'get_bill_status'
  | 'send_reminder'
  | 'award_points';

export type ReminderTone = 'friendly' | 'firm' | 'final';

/**
 * `POST /api/agent/message`. When `confirmationRequired` is true nothing has
 * happened yet: repeat the same call with `confirmToken` to commit it.
 */
export type AgentResponse = {
  tool: AgentToolName;
  groupId: string;
  executed: boolean;
  confirmationRequired: boolean;
  confirmToken: string | null;
  result: Record<string, unknown>;
  reply: string;
};
