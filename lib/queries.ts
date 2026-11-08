import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { request } from './api';
import type { FxSnapshot } from './fx';
import type {
    AgentChatResponse,
    AgentResponse,
    AgentToolName,
    Agreement,
    Allocation,
    Bill,
    BillKind,
    BillSplitMode,
    Group,
    LeaderboardRow,
    Member,
    PaymentMode,
    SettledRate,
    Share,
    TimelineEvent,
    TipsResponse
} from './types';

export type GroupDetail = {
  group: Group;
  members: Member[];
  agreement: Agreement | null;
  bill: Bill | null;
  me: Member;
};

/** A membership row in the signed-in member's own group list. */
export type MyGroup = Group & {
  role: Member['role'];
  memberCount: number;
};

export const queryKeys = {
  group: (groupId: string) => ['group', groupId] as const,
  timeline: (groupId: string) => ['timeline', groupId] as const,
  bill: (billId: string) => ['bill', billId] as const,
  leaderboard: (groupId: string) => ['leaderboard', groupId] as const,
  tips: (billId: string) => ['tips', billId] as const,
  fxRates: ['fx', 'rates'] as const,
  myProfile: ['me', 'profile'] as const,
  myGroups: ['me', 'groups'] as const,
  myShares: ['me', 'shares'] as const,
  myPoints: ['me', 'points'] as const,
  myActivity: ['me', 'activity'] as const,
  myNotifications: ['me', 'notifications'] as const,
};

export function useGroup(groupId: string) {
  return useQuery({
    queryKey: queryKeys.group(groupId),
    queryFn: () => request<GroupDetail>(`/groups/${groupId}`),
    enabled: Boolean(groupId),
  });
}

export function useGroupTimeline(groupId: string) {
  return useQuery({
    queryKey: queryKeys.timeline(groupId),
    queryFn: () => request<{ events: TimelineEvent[] }>(`/groups/${groupId}/timeline`),
    enabled: Boolean(groupId),
    refetchInterval: 5000,
  });
}

export function useBill(billId: string) {
  return useQuery({
    queryKey: queryKeys.bill(billId),
    queryFn: () =>
      request<{ bill: Bill; allocations: Allocation[]; shares: Share[] }>(`/bills/${billId}`),
    enabled: Boolean(billId),
    refetchInterval: (query) =>
      query.state.data?.bill.status === 'PARSING' ? 1500 : false,
  });
}

export function useLeaderboard(groupId: string) {
  return useQuery({
    queryKey: queryKeys.leaderboard(groupId),
    queryFn: () => request<{ rows: LeaderboardRow[] }>(`/groups/${groupId}/leaderboard`),
    enabled: Boolean(groupId),
  });
}

export type MyProfile = {
  userId: string;
  email: string;
  displayName: string;
  /** null means "no override": the client uses the device or group currency. */
  displayCurrency: string | null;
  paypalLinked: boolean;
  /** Where members reimburse this member when they front a bill. */
  paypalEmail: string | null;
  /** Preferred payee when set: the Business account's merchant id. */
  paypalMerchantId: string | null;
  /** Chosen way to collect; `payee_direct` unless changed. */
  paypalMode: PaymentMode;
  /** PayPal.Me slug used by the `paypal_me` mode. */
  paypalMeHandle: string | null;
  /**
   * Opt-in fee coverage (DEV_PLAN §2.20): members are asked for the share plus
   * an estimate of PayPal's fee, so the fronter nets the share. Off by default;
   * the server reports `false` while live mode refuses the feature.
   */
  coverPaypalFee: boolean;
};

export function useMyProfile(enabled = true) {
  return useQuery({
    queryKey: queryKeys.myProfile,
    queryFn: () => request<MyProfile>('/me'),
    enabled,
  });
}

/** Saving the display currency touches both the device and the account (§2.19). */
export function useUpdateDisplayCurrency() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (displayCurrency: string | null) =>
      request<{ userId: string; displayCurrency: string | null }>('/me', {
        method: 'PATCH',
        body: { displayCurrency },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * The address reimbursements settle into. Written to every active membership on
 * the server, because that is what the PayPal order names as payee.
 */
export function useUpdatePaypalEmail() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paypalEmail: string | null) =>
      request<{ userId: string; paypalEmail: string | null }>('/me', {
        method: 'PATCH',
        body: { paypalEmail },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * The account-level id PayPal can address instead of an email. Preferred when
 * set: a Business account needs it to receive a cross-border reimbursement.
 */
export function useUpdatePaypalMerchantId() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paypalMerchantId: string | null) =>
      request<{ userId: string; paypalMerchantId: string | null }>('/me', {
        method: 'PATCH',
        body: { paypalMerchantId },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * Which way members reimburse this member. `payee_direct` needs a PayPal
 * account that can act as payee on an order; `paypal_me` works with any
 * personal account because the payer just follows a link.
 */
export function useUpdatePaypalMode() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paypalMode: PaymentMode) =>
      request<{ userId: string; paypalMode: PaymentMode }>('/me', {
        method: 'PATCH',
        body: { paypalMode },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/** The slug after `paypal.me/`, stored without the leading "@". */
export function useUpdatePaypalMeHandle() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (paypalMeHandle: string | null) =>
      request<{ userId: string; paypalMeHandle: string | null }>('/me', {
        method: 'PATCH',
        body: { paypalMeHandle },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * Opt-in fee coverage (DEV_PLAN §2.20). Live mode answers
 * `403 fee_cover_not_permitted`, because passing PayPal's fee to the payer is
 * a surcharge under the US and Thai agreements.
 */
export function useUpdateCoverPaypalFee() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (coverPaypalFee: boolean) =>
      request<{ userId: string; coverPaypalFee: boolean }>('/me', {
        method: 'PATCH',
        body: { coverPaypalFee },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myProfile }),
  });
}

/**
 * Indicative market rates for the whole app. Refreshed hourly on the server, so
 * the client caches for the same window and never blocks a render on it.
 */
export function useFxRates() {
  return useQuery({
    queryKey: queryKeys.fxRates,
    queryFn: () => request<FxSnapshot>('/fx/rates'),
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

/** Every table the member belongs to. The only stable way back into a group. */
export function useMyGroups() {
  return useQuery({
    queryKey: queryKeys.myGroups,
    queryFn: () => request<{ groups: MyGroup[] }>('/groups'),
  });
}

export function useMyShares() {
  return useQuery({
    queryKey: queryKeys.myShares,
    queryFn: () => request<{ shares: Share[]; outstandingMinor: number; currency: string }>(
      '/me/shares'
    ),
  });
}

export function useMyPoints() {
  return useQuery({
    queryKey: queryKeys.myPoints,
    queryFn: () => request<{ balance: number }>('/me/points'),
  });
}

/** The cross-group ledger feed. Slow-moving, so it only refreshes on focus. */
export function useMyActivity() {
  return useQuery({
    queryKey: queryKeys.myActivity,
    queryFn: () => request<{ events: TimelineEvent[] }>('/me/activity'),
    refetchInterval: 15_000,
  });
}

export type NotificationChannel = 'in_app' | 'push' | 'email' | 'whatsapp';

export type NotificationSettings = {
  /** `available` is what the server can actually send; a dark channel still lists. */
  channels: { channel: NotificationChannel; enabled: boolean; available: boolean }[];
  pushRegistered: boolean;
};

export function useNotificationSettings() {
  return useQuery({
    queryKey: queryKeys.myNotifications,
    queryFn: () => request<NotificationSettings>('/me/notifications'),
  });
}

/** One toggle fans out to every membership server-side, so the answer is authoritative. */
export function useUpdateNotificationChannel() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { channel: NotificationChannel; enabled: boolean }) =>
      request<NotificationSettings>('/me/notifications', { method: 'PATCH', body: input }),
    onSuccess: (settings) => client.setQueryData(queryKeys.myNotifications, settings),
  });
}

export function useCreateGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string; currency: string }) =>
      request<{ group: Group; member: Member }>('/groups', { body: input }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myGroups });
      client.invalidateQueries({ queryKey: ['group'] });
    },
  });
}

export function useJoinGroup() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { inviteToken: string; displayName: string }) =>
      request<{ group: Group; member: Member }>('/groups/join', { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.myGroups }),
  });
}

export function useCreateAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { estimatedTotalMinor: number; deadline: string | null }) =>
      request<{ agreement: Agreement }>('/agreements', {
        body: { groupId, ...input },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
  });
}

export function useAcceptAgreement(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (agreementId: string) =>
      request<{ agreement: Agreement }>(`/agreements/${agreementId}/accept`, { body: {} }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.group(groupId) });
      client.invalidateQueries({ queryKey: queryKeys.timeline(groupId) });
    },
  });
}

export function useCreateBill(groupId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      agreementId: string;
      currency: string;
      title?: string | null;
      kind?: BillKind;
      splitMode?: BillSplitMode;
    }) => request<{ bill: Bill }>('/bills', { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.group(groupId) }),
  });
}

export function useUploadMedia() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      uri,
      kind,
      file,
    }: {
      billId: string;
      uri: string;
      kind: 'photo' | 'video';
      /** Browsers get a real File from the picker; native passes a uri instead. */
      file?: Blob | null;
    }) => {
      const form = new FormData();
      const name = uri.split('/').pop() ?? `receipt.${kind === 'video' ? 'mp4' : 'jpg'}`;
      form.append('kind', kind);
      if (file) {
        form.append('file', file, name);
      } else {
        form.append(
          'file',
          { uri, name, type: kind === 'video' ? 'video/mp4' : 'image/jpeg' } as unknown as Blob
        );
      }
      return request<{ mediaId: string; status: string }>(`/bills/${billId}/media`, {
        method: 'POST',
        formData: form,
      });
    },
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // Re-requesting can revive a dead checkout, so the member's own list must
      // stop showing the old approve link too.
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export function useParseBill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId }: { billId: string }) =>
      request<{ status: string }>(`/bills/${billId}/parse`, { body: {} }),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) }),
  });
}

export function useSetAllocations() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      allocations,
      splitEntries,
      splitMode,
      title,
      kind,
    }: {
      billId: string;
      /** `item` mode: who shares which line, and how much of it. */
      allocations?: { billItemId: string; memberId: string; qty: number }[];
      /** `equal` / `custom` / `percent` mode: one entry per member. */
      splitEntries?: { memberId: string; amountMinor?: number; weight?: number }[];
      splitMode?: BillSplitMode;
      title?: string | null;
      kind?: BillKind;
    }) =>
      request<{ allocations?: Allocation[]; bill?: Bill }>(
        `/bills/${billId}/allocations`,
        {
          method: 'PATCH',
          body: { allocations, splitEntries, splitMode, title, kind },
        },
      ),
    onSuccess: (_data, vars) =>
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) }),
  });
}

/** Add a line by hand, for bills that arrive as a number rather than a photo. */
export function useAddBillItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      name,
      qty,
      unitPriceMinor,
    }: {
      billId: string;
      name: string;
      qty: number;
      unitPriceMinor: number;
    }) =>
      request<{ bill: Bill }>(`/bills/${billId}/items`, {
        body: { name, qty, unitPriceMinor },
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
    },
  });
}

export function useUpdateBillItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({
      billId,
      itemId,
      name,
      qty,
      unitPriceMinor,
    }: {
      billId: string;
      itemId: string;
      name: string;
      qty: number;
      unitPriceMinor: number;
    }) =>
      request<{ bill: Bill }>(`/bills/${billId}/items/${itemId}`, {
        method: 'PATCH',
        body: { name, qty, unitPriceMinor },
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
    },
  });
}

export function useDeleteBillItem() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId, itemId }: { billId: string; itemId: string }) =>
      request<{ bill: Bill }>(`/bills/${billId}/items/${itemId}`, {
        method: 'DELETE',
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
    },
  });
}

export function useConfirmAllocation() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId, allocationId }: { billId: string; allocationId: string }) =>
      request<{ allocation: Allocation }>(`/allocations/${allocationId}/confirm`, {
        body: {},
      }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // The last confirmation locks the split on the server, so the payer's
      // own share is new too — refresh the lists that would otherwise sit on
      // an empty "Nothing owed either way".
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myGroups });
      client.invalidateQueries({ queryKey: queryKeys.myActivity });
    },
  });
}

/**
 * Turn the saved split into shares. Item mode does this on the last confirm;
 * even/custom/percent have nothing to confirm, so the fronter locks it here.
 */
export function useFinalizeBill() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId }: { billId: string }) =>
      request<{ bill: Bill; shares: Share[] }>(`/bills/${billId}/finalize`, { body: {} }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myGroups });
      client.invalidateQueries({ queryKey: queryKeys.myActivity });
    },
  });
}

export type CaptureShareResult = {
  shareId: string;
  status: string;
  alreadyPaid: boolean;
  captureId: string | null;
  pointsAwarded: number;
  rank: number | null;
  billSettled: boolean;
  /** PayPal's own rate, when the payer's currency differed from the bill's. */
  settledRate: SettledRate | null;
};

/**
 * Capture happens after the member approves in the browser. The API settles the
 * share, so both "My shares" and the Globie balance are stale afterwards.
 */
export function useCaptureShare() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ shareId }: { shareId: string }) =>
      request<CaptureShareResult>(`/shares/${shareId}/capture`, { body: {} }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['group'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    // A checkout PayPal refused leaves the share `failed` server-side; refetching
    // replaces the dead "Payment requested" row with the truth.
    onError: () => client.invalidateQueries({ queryKey: queryKeys.myShares }),
  });
}

/**
 * PayPal.Me has no order to capture and PayPal never reports the transfer, so
 * the payer confirms it here and the API settles the share.
 */
export function useConfirmSharePaid() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ shareId }: { shareId: string }) =>
      request<CaptureShareResult>(`/shares/${shareId}/paid`, { body: {} }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['group'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    onError: () => client.invalidateQueries({ queryKey: queryKeys.myShares }),
  });
}

export function useRequestPayments() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ billId }: { billId: string }) =>
      request<{
        requests: { shareId: string; approveUrl: string | null; paymentMode: PaymentMode }[];
      }>(`/bills/${billId}/request-payments`, { body: {} }),
    onSuccess: (_data, vars) => {
      client.invalidateQueries({ queryKey: queryKeys.bill(vars.billId) });
      // Re-requesting can revive a dead checkout, so the member's own list must
      // stop showing the old approve link too.
      client.invalidateQueries({ queryKey: queryKeys.myShares });
    },
  });
}

export type RequestTipResult = {
  tipId: string;
  status: string;
  paypalOrderId: string;
  approveUrl: string;
  amountMinor: number;
  currency: string;
  alreadyRequested: boolean;
};

/**
 * Tips only exist on a bill that the fronter has already paid, so the caller
 * gates this query on the bill status.
 */
export function useTips(billId: string, enabled = true) {
  return useQuery({
    queryKey: queryKeys.tips(billId),
    queryFn: () => request<TipsResponse>(`/bills/${billId}/tips`),
    enabled: Boolean(billId) && enabled,
  });
}

export function useRequestTip(billId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { amountMinor: number; message?: string }) =>
      request<RequestTipResult>(`/bills/${billId}/tips`, { body: input }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tips(billId) }),
  });
}

export type CaptureTipResult = {
  tipId: string;
  status: string;
  alreadyPaid: boolean;
  captureId: string | null;
  pointsAwarded: number;
  settledRate: SettledRate | null;
  /** Fee snapshot (DEV_PLAN §2.20); `grossMinor` is what PayPal charged. */
  feeMinor: number;
  grossMinor: number;
};

/** Same eager capture as a share, but a tip never settles the bill. */
export function useCaptureTip() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tipId }: { tipId: string }) =>
      request<CaptureTipResult>(`/tips/${tipId}/capture`, { body: {} }),
    onSuccess: () => {
      client.invalidateQueries({ queryKey: ['tips'] });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
      client.invalidateQueries({ queryKey: ['timeline'] });
    },
    // A checkout PayPal refused leaves the tip `failed` server-side; refetching
    // turns the card back into an offer instead of a dead "waiting" row.
    onError: () => client.invalidateQueries({ queryKey: ['tips'] }),
  });
}

export type AgentMessageInput = {
  tool: AgentToolName;
  args: Record<string, unknown>;
  /** Only sent on the replay that commits a confirmed tool. */
  confirmToken?: string | null;
};

/**
 * One Globie turn. A confirmed tool answers `confirmationRequired` first and
 * changes nothing; the caller repeats the identical call with the token.
 */
export function useAgentMessage() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ tool, args, confirmToken }: AgentMessageInput) =>
      request<AgentResponse>('/agent/message', {
        body: confirmToken ? { tool, args, confirmToken } : { tool, args },
      }),
    onSuccess: (response) => {
      if (!response.executed) return;
      client.invalidateQueries({ queryKey: ['bill'] });
      client.invalidateQueries({ queryKey: ['group'] });
      client.invalidateQueries({ queryKey: ['timeline'] });
      client.invalidateQueries({ queryKey: ['leaderboard'] });
      client.invalidateQueries({ queryKey: queryKeys.myShares });
      client.invalidateQueries({ queryKey: queryKeys.myPoints });
    },
  });
}

export type AgentChatInput = {
  message: string;
  groupId: string;
  billId?: string | null;
  /** Recent turns, oldest first; the server truncates what it replays. */
  history: { role: 'user' | 'assistant'; content: string }[];
};

/** Free-form Globie turn: conversation only, no tool runs, no writes. */
export function useAgentChat() {
  return useMutation({
    mutationFn: ({ message, groupId, billId, history }: AgentChatInput) =>
      request<AgentChatResponse>('/agent/chat', {
        body: {
          message,
          group_id: groupId,
          bill_id: billId ?? null,
          history,
        },
      }),
  });
}
