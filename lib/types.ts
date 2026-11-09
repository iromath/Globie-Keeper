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

export type BillKind =
  | 'meal'
  | 'groceries'
  | 'rent'
  | 'utilities'
  | 'travel'
  | 'gift'
  | 'subscription'
  | 'other';

export type BillSplitMode = 'item' | 'equal' | 'custom' | 'percent';

export type BillSplitEntry = {
  memberId: string;
  amountMinor: number | null;
  weight: number | null;
};

export type Bill = {
  id: string;
  agreementId: string;
  merchant: string | null;
  title: string | null;
  kind: BillKind;
  splitMode: BillSplitMode;
  currency: Currency;
  subtotalMinor: number;
  taxMinor: number;
  serviceChargeMinor: number;
  tipMinor: number;
  discountMinor: number;
  totalMinor: number;
  status: string;
  items: BillItem[];
  splitEntries: BillSplitEntry[];
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
  /** Who fronted the bill: the member who has to request this payment. */
  fronterName?: string | null;
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
  /**
   * How the fronter asked to be reimbursed: `payee_direct` finishes through a
   * PayPal order, `paypal_me` is a link the payer confirms by hand.
   */
  paymentMode?: PaymentMode | null;
  /**
   * Optional fee coverage (DEV_PLAN §2.20). `feeMinor` is what the payer was
   * asked for on top of the share when the fronter opted in; `grossMinor` is
   * the amount the checkout actually shows. `null` means the share was never
   * grossed up. The share itself always stays the net.
   */
  feeMinor?: number;
  grossMinor?: number | null;
  /** PayPal holds an approval we can still capture; only on a `requested` share. */
  canFinish?: boolean;
};

/** The two ways a fronter can collect: an order with them as payee, or PayPal.Me. */
export type PaymentMode = 'payee_direct' | 'paypal_me';

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
  /** Optional fee coverage (DEV_PLAN §2.20); the net stays `amountMinor`. */
  feeMinor?: number;
  grossMinor?: number | null;
  /** PayPal holds an approval we can still capture; only on a `requested` tip. */
  canFinish?: boolean;
};

export type TipsResponse = {
  billId: string;
  currency: Currency;
  frontedBy: string | null;
  frontedByName: string;
  /** False while the fronter has no PayPal email or merchant id to be paid at. */
  payoutReady: boolean;
  canTip: boolean;
  /** Sum of tips that actually went through. */
  totalMinor: number;
  myTip: Tip | null;
  tips: Tip[];
};

/** One tree the sanctuary can register for a gift (DEV_PLAN §2.21). */
export type DonationSpecies = {
  id: string;
  name: string;
  latin: string | null;
  /** `critical` / `urgent` come from the sanctuary's own catalogue. */
  status: 'critical' | 'urgent' | null;
  blurb: string;
};

export type DonationMethod = 'paypal' | 'points';

/** How the adoption call to the sanctuary went — independent of the payment. */
export type AdoptionStatus = 'none' | 'pending' | 'adopted' | 'failed';

/** A gift to the Globie Fund: PayPal money, or Globie points at 1000 = US$1. */
export type Donation = {
  id: string;
  method: DonationMethod;
  amountMinor: number;
  currency: Currency;
  /** Points redeemed on the `points` rail; 0 on the PayPal rail. */
  pointsSpent: number;
  speciesId: string;
  speciesName: string | null;
  quantity: number;
  status: 'proposed' | 'requested' | 'paid' | 'refunded' | 'failed';
  paypalOrderId: string | null;
  /** Browser approval link; only present while the donation is `requested`. */
  approveUrl?: string | null;
  grossMinor: number | null;
  mcpStatus: AdoptionStatus;
  /** The sanctuary's deed number, once the adoption is logged. */
  deedNo: string | null;
  paidAt: string | null;
  createdAt: string;
};

export type DonationSpeciesResponse = {
  species: DonationSpecies[];
  currency: Currency;
  pointsPerUsd: number;
  minMinor: number;
  maxMinor: number;
};

export type DonationsResponse = {
  donations: Donation[];
  totalMinor: number;
  treesAdopted: number;
  currency: Currency;
  pointsBalance: number;
  pointsPerUsd: number;
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

/**
 * `POST /api/agent/chat`. The conversational layer only explains and answers
 * from the group's data; nothing on the bill changes.
 */
export type AgentChatResponse = {
  reply: string;
};

/**
 * `GET /api/help` (§2.22). A manual section is also what Globie is taught, so
 * the words on the Help page and in a reply cannot drift apart.
 */
export type ManualSection = {
  id: string;
  title: string;
  summary: string;
  keywords: string[];
  steps: string[];
  screen: string | null;
};
