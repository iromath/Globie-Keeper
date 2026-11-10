import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { currencyExponent, formatMinor, fromMinor, sumMinor, toMinor } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import {
  useAddBillItem,
  useBill,
  useCaptureTip,
  useConfirmAllocation,
  useCreateBill,
  useDeleteBillItem,
  useFinalizeBill,
  useGroup,
  useParseBill,
  useRequestPayments,
  useRequestTip,
  useSetAllocations,
  useTips,
  useUpdateBillItem,
  useUploadMedia,
  useVoteSplitMode
} from '@/lib/queries';
import type { AgreementSplitMode, BillItem, BillKind, BillSplitMode } from '@/lib/types';

type Assignment = Record<string, string[]>;

const statusCopy: Record<string, string> = {
  UPLOADED: 'Uploaded',
  PARSING: 'Reading the bill',
  PARSED: 'Read, check the lines',
  ALLOCATED: 'Split proposed',
  CONFIRMED: 'Everyone confirmed',
  FINALIZED: 'Locked',
  COLLECTING: 'Collecting',
  SETTLED: 'Settled',
};
const collectedStatus = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);

/**
 * Thank-you sizes as a share of the bill, not a fixed dollar ladder: on a $96
 * dinner a $20 opener reads as a second bill rather than a tip. Whole major
 * units keep the taps clean, and the floor keeps them usable on tiny bills.
 */
const TIP_SHARES = [0.02, 0.05, 0.1];

function tipPresets(totalMinor: number, currency: string): number[] {
  const unit = 10 ** currencyExponent(currency);
  const rounded = TIP_SHARES.map((share) =>
    Math.max(unit, Math.round((totalMinor * share) / unit) * unit)
  );
  return [...new Set(rounded)];
}

/**
 * Preset thank-yous plus a field for anything else. The two states of the tip
 * card (first try and retry after a declined checkout) share this picker.
 */
function TipAmounts({
  currency,
  maxMinor,
  busy,
  onSend
}: {
  currency: string;
  maxMinor: number;
  busy: boolean;
  onSend: (amountMinor: number) => void;
}) {
  const [draft, setDraft] = useState('');
  const typed = draft.trim() ? toMinor(draft, currencyExponent(currency)) : NaN;
  const tooLarge = Number.isFinite(typed) && typed > maxMinor;
  const canSend = Number.isFinite(typed) && typed > 0 && !tooLarge;

  return (
    <>
      <View style={styles.chips}>
        {tipPresets(maxMinor, currency).map((amountMinor) => (
          <Button
            key={amountMinor}
            compact
            variant="secondary"
            icon={icon.hand}
            title={formatMinor(amountMinor, currency)}
            accessibilityLabel={`Tip ${formatMinor(amountMinor, currency)}`}
            onPress={() => onSend(amountMinor)}
            disabled={busy}
          />
        ))}
      </View>
      <Field
        label="Or enter your own amount"
        keyboardType="decimal-pad"
        placeholder="0.00"
        value={draft}
        onChangeText={setDraft}
        error={
          tooLarge
            ? `A tip can’t be larger than the bill (${formatMinor(maxMinor, currency)}).`
            : undefined
        }
        hint={`Anything up to ${formatMinor(maxMinor, currency)}`}
      />
      <Button
        compact
        icon={icon.hand}
        title={canSend ? `Send ${formatMinor(typed, currency)}` : 'Send tip'}
        loading={busy}
        disabled={!canSend || busy}
        onPress={() => {
          onSend(typed);
          setDraft('');
        }}
      />
    </>
  );
}

const SPLIT_MODES: { id: BillSplitMode; label: string }[] = [
  { id: 'item', label: 'By item' },
  { id: 'equal', label: 'Even' },
  { id: 'custom', label: 'Amounts' },
  { id: 'percent', label: 'Percent' },
];

/** The two modes the whole group votes on. Amounts and percent stay the fronter's call. */
const SPLIT_VOTES: { id: AgreementSplitMode; label: string }[] = [
  { id: 'item', label: 'By line item' },
  { id: 'equal', label: 'Evenly' },
];

const SPLIT_HINTS: Record<BillSplitMode, string> = {
  item: 'Assign each line. Each member confirms their own lines.',
  equal: 'Everybody pays the same. Tax, tip and service are shared too.',
  custom: 'Type each member’s amount. They must add up to the total.',
  percent: 'Type each member’s percentage. They must add up to 100%.',
};

/** The kinds the server accepts. `group_buy` is deliberately not one of them yet. */
const BILL_KINDS: { id: BillKind; label: string }[] = [
  { id: 'meal', label: 'Meal' },
  { id: 'groceries', label: 'Groceries' },
  { id: 'rent', label: 'Rent' },
  { id: 'utilities', label: 'Utilities' },
  { id: 'travel', label: 'Travel' },
  { id: 'gift', label: 'Gift' },
  { id: 'subscription', label: 'Subscription' },
  { id: 'other', label: 'Other' },
];

export default function BillScreen() {
  const { id, billId } = useLocalSearchParams<{ id: string; billId?: string }>();
  const notify = useMascotToast();
  const money = useMoney();
  const group = useGroup(id);
  const activeBillId = billId ?? group.data?.bill?.id ?? '';

  const billQuery = useBill(activeBillId);
  const createBill = useCreateBill(id);
  const uploadMedia = useUploadMedia();
  const parseBill = useParseBill();
  const setAllocations = useSetAllocations();
  const confirmAllocation = useConfirmAllocation();
  const requestPayments = useRequestPayments();
  const requestTip = useRequestTip(activeBillId);
  const captureTip = useCaptureTip();
  const addItem = useAddBillItem();
  const deleteItem = useDeleteBillItem();
  const updateItem = useUpdateBillItem();
  const finalizeBill = useFinalizeBill();
  const voteSplit = useVoteSplitMode(id);

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveUrl, setApproveUrl] = useState<string | null>(null);
  /** Set before the bill exists, then carried on the create call. */
  const [kind, setKind] = useState<BillKind>('meal');
  const [title, setTitle] = useState('');
  /** `null` until the fronter picks a mode; the server's value wins after. */
  const [modeDraft, setModeDraft] = useState<BillSplitMode | null>(null);
  const [shares, setShares] = useState<Record<string, string>>({});
  const [qtyEdits, setQtyEdits] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState({ name: '', qty: '1', price: '' });
  /** The line being corrected in place, and the values typed into it. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [lineDraft, setLineDraft] = useState({ name: '', qty: '1', price: '' });

  const bill = billQuery.data?.bill;
  const locked = bill ? collectedStatus.has(bill.status) : false;
  const tips = useTips(bill?.id ?? '', locked);
  const allocations = useMemo(() => billQuery.data?.allocations ?? [], [billQuery.data]);
  const me = group.data?.me;
  const agreement = group.data?.agreement;
  const isFronter = Boolean(me && agreement?.frontedBy === me.id);
  const fronterName =
    group.data?.members.find((member) => member.id === agreement?.frontedBy)?.displayName ??
    'The fronter';
  const currency = bill?.currency ?? group.data?.group.defaultCurrency ?? 'THB';
  const members = group.data?.members ?? [];
  const splitMode: BillSplitMode = modeDraft ?? bill?.splitMode ?? 'item';
  const evenShare = bill && members.length > 0 ? Math.round(bill.totalMinor / members.length) : 0;
  const customSum = sumMinor(
    members.map((member) => toMinor(shares[member.id] ?? '', currencyExponent(currency)))
  );
  const percentSum = members.reduce(
    (total, member) => total + (Number(shares[member.id]) || 0),
    0
  );
  const paidTips = (tips.data?.tips ?? []).filter((tip) => tip.status === 'paid');
  const myTip = tips.data?.myTip ?? null;

  // The agreement figure is an estimate the group agreed to up front; the
  // receipt can land above it. Show the gap next to the total, not in a corner.
  const overEstimate =
    agreement &&
    bill &&
    agreement.currency === bill.currency &&
    bill.totalMinor > agreement.estimatedTotalMinor
      ? bill.totalMinor - agreement.estimatedTotalMinor
      : null;

  // The server's allocation is the truth. A tap is an overlay on top of it, and
  // the overlay dies the moment the server's version of the bill changes.
  const syncKey = `${bill?.id ?? ''}:${bill?.status ?? ''}:${allocations.length}`;
  const [edits, setEdits] = useState<{ key: string; map: Assignment }>({ key: syncKey, map: {} });
  const localMap = useMemo(() => (edits.key === syncKey ? edits.map : {}), [edits, syncKey]);
  const assignment = useMemo(() => {
    const next: Assignment = {};
    for (const item of bill?.items ?? []) {
      next[item.id] =
        localMap[item.id] ??
        allocations
          .filter((allocation) => allocation.billItemId === item.id)
          .map((allocation) => allocation.memberId);
    }
    return next;
  }, [bill?.items, allocations, localMap]);

  const myPending = useMemo(
    () => allocations.filter((a) => a.memberId === me?.id && a.status === 'proposed'),
    [allocations, me?.id]
  );

  /** Create the bill on first use, carrying the kind and title typed above. */
  async function ensureBill(): Promise<string> {
    if (activeBillId) return activeBillId;
    const current = group.data?.agreement;
    if (!current) throw new Error('Create the agreement first');
    const created = await createBill.mutateAsync({
      agreementId: current.id,
      currency: current.currency,
      title: title.trim() || null,
      kind,
      splitMode,
    });
    return created.bill.id;
  }

  async function capture(source: 'camera' | 'library') {
    setError(null);
    setBusy('capture');
    try {
      const result =
        source === 'camera'
          ? await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 0.85 })
          : await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images', 'videos'],
              quality: 0.85,
            });
      if (result.canceled || !result.assets[0]) return;
      const asset = result.assets[0];
      const kind: 'photo' | 'video' = asset.type === 'video' ? 'video' : 'photo';

      let targetBillId = activeBillId;
      if (!targetBillId) {
        targetBillId = await ensureBill();
      }

      await uploadMedia.mutateAsync({
        billId: targetBillId,
        uri: asset.uri,
        kind,
        file: asset.file ?? undefined,
      });
      await parseBill.mutateAsync({ billId: targetBillId });
      notify({ title: 'Bill read', body: 'Kae Na checked every line. Confirm your share.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the bill');
    } finally {
      setBusy(null);
    }
  }

  function toggle(itemId: string, memberId: string) {
    const members = assignment[itemId] ?? [];
    setEdits({
      key: syncKey,
      map: {
        ...localMap,
        [itemId]: members.includes(memberId)
          ? members.filter((entry) => entry !== memberId)
          : [...members, memberId],
      },
    });
  }

  async function saveAssignments() {
    if (!bill) return;
    setBusy('assign');
    setError(null);
    try {
      const payload = Object.entries(assignment).flatMap(([billItemId, memberIds]) =>
        memberIds.map((memberId) => ({
          billItemId,
          memberId,
          qty: qtyEdits[`${billItemId}:${memberId}`] ?? 1,
        }))
      );
      await setAllocations.mutateAsync({
        billId: bill.id,
        splitMode: 'item',
        allocations: payload,
      });
      notify({ title: 'Split proposed', body: 'The crew gets a tap to confirm.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the split');
    } finally {
      setBusy(null);
    }
  }

  /** A bill does not need a photo: the fronter can type the lines. */
  async function addManualItem() {
    const name = draft.name.trim();
    const qty = Math.max(1, Math.round(Number(draft.qty) || 1));
    const unitPriceMinor = toMinor(draft.price, currencyExponent(currency));
    if (!name) {
      setError('Give the line a name');
      return;
    }
    if (!Number.isFinite(unitPriceMinor) || unitPriceMinor <= 0) {
      setError('Type a price for the line');
      return;
    }
    setBusy('item');
    setError(null);
    try {
      const billId = await ensureBill();
      await addItem.mutateAsync({ billId, name, qty, unitPriceMinor });
      setDraft({ name: '', qty: '1', price: '' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not add the line');
    } finally {
      setBusy(null);
    }
  }

  async function removeItem(itemId: string) {
    if (!bill) return;
    setBusy(`item:${itemId}`);
    setError(null);
    try {
      await deleteItem.mutateAsync({ billId: bill.id, itemId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not remove the line');
    } finally {
      setBusy(null);
    }
  }

  /** A misread line is fixed in place; the server rebuilds the total from it. */
  function startEdit(item: BillItem) {
    const exponent = currencyExponent(currency);
    setEditingId(item.id);
    setLineDraft({
      name: item.name,
      qty: String(item.qty),
      price: fromMinor(item.unitPriceMinor, exponent).toFixed(exponent),
    });
    setError(null);
  }

  async function saveLine(itemId: string) {
    if (!bill) return;
    const name = lineDraft.name.trim();
    const qty = Math.max(1, Math.round(Number(lineDraft.qty) || 1));
    const unitPriceMinor = toMinor(lineDraft.price, currencyExponent(currency));
    if (!name) {
      setError('Give the line a name');
      return;
    }
    if (!Number.isFinite(unitPriceMinor) || unitPriceMinor <= 0) {
      setError('Type a price for the line');
      return;
    }
    setBusy(`edit:${itemId}`);
    setError(null);
    try {
      await updateItem.mutateAsync({ billId: bill.id, itemId, name, qty, unitPriceMinor });
      setEditingId(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the line');
    } finally {
      setBusy(null);
    }
  }

  /**
   * Even, custom and percent have no per-line confirmations to wait for, so the
   * fronter saves the split and turns it into shares in one step.
   */
  async function lockSplit() {
    if (!bill) return;
    setBusy('assign');
    setError(null);
    try {
      if (splitMode === 'equal') {
        await setAllocations.mutateAsync({
          billId: bill.id,
          splitMode: 'equal',
          splitEntries: members.map((member) => ({ memberId: member.id })),
        });
      } else if (splitMode === 'custom') {
        await setAllocations.mutateAsync({
          billId: bill.id,
          splitMode: 'custom',
          splitEntries: members.map((member) => ({
            memberId: member.id,
            amountMinor: toMinor(shares[member.id] ?? '', currencyExponent(currency)),
          })),
        });
      } else {
        await setAllocations.mutateAsync({
          billId: bill.id,
          splitMode: 'percent',
          splitEntries: members.map((member) => ({
            memberId: member.id,
            weight: Number(shares[member.id]) || 0,
          })),
        });
      }
      await finalizeBill.mutateAsync({ billId: bill.id });
      notify({ title: 'Split locked', body: 'Each member can pay from My shares.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not lock the split');
    } finally {
      setBusy(null);
    }
  }

  /** The vote is agreement-wide, so it also decides how this bill is divided. */
  async function onVote(splitMode: AgreementSplitMode) {
    if (!agreement || agreement.myVote === splitMode) return;
    setError(null);
    try {
      await voteSplit.mutateAsync({ agreementId: agreement.id, splitMode });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the vote');
    }
  }

  async function confirmMine() {
    if (!bill) return;
    setBusy('confirm');
    try {
      for (const allocation of myPending) {
        await confirmAllocation.mutateAsync({ billId: bill.id, allocationId: allocation.id });
      }
      notify({ title: 'Share confirmed', body: 'Kae Na has your tap on record.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not confirm');
    } finally {
      setBusy(null);
    }
  }

  async function runRequestPayments() {
    if (!bill) return;
    setBusy('request');
    setError(null);
    try {
      const result = await requestPayments.mutateAsync({ billId: bill.id });
      const first = result.requests[0];
      setApproveUrl(first?.approveUrl ?? null);
      notify({ title: 'Requests sent', body: 'Each member can now pay from My shares.' });
      // A PayPal.Me link is the fronter's own collect link; opening it here would
      // just show their profile, so only an order checkout is worth a trip.
      if (first?.approveUrl && first.paymentMode === 'payee_direct') {
        await WebBrowser.openBrowserAsync(first.approveUrl);
      }
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : 'PayPal requests are not configured yet'
      );
    } finally {
      setBusy(null);
    }
  }

  /**
   * A tip is a second, independent PayPal order: approve it in the browser,
   * then capture it. It never touches the bill's settlement state.
   */
  async function tipFronter(amountMinor: number) {
    if (!bill) return;
    setBusy('tip');
    setError(null);
    try {
      const request = await requestTip.mutateAsync({ amountMinor });
      try {
        await WebBrowser.openBrowserAsync(request.approveUrl);
      } catch {
        // A dismissed browser is not a failure; the capture decides below.
      }
      const capture = await captureTip.mutateAsync({ tipId: request.tipId });
      notify({
        title: 'Tip sent',
        body:
          capture.pointsAwarded > 0
            ? `Kae Na thanks you — +${capture.pointsAwarded} Globie`
            : 'Kae Na thanks you.',
        points: capture.pointsAwarded,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the tip');
    } finally {
      setBusy(null);
    }
  }

  /**
   * The tip was approved in PayPal but never captured — a closed browser tab, a
   * dropped callback. The server re-reads the order and flags it, so the capture
   * can be finished here without another trip through the approval page.
   */
  async function finishTip(tipId: string) {
    setBusy('tip');
    setError(null);
    try {
      const capture = await captureTip.mutateAsync({ tipId });
      notify({
        title: 'Tip sent',
        body:
          capture.pointsAwarded > 0
            ? `Kae Na thanks you — +${capture.pointsAwarded} Globie`
            : 'Kae Na thanks you.',
        points: capture.pointsAwarded,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not finish the tip');
    } finally {
      setBusy(null);
    }
  }

  if (group.isLoading || (activeBillId && billQuery.isLoading)) {
    return (
      <Screen scroll={false} header={{ title: 'Bill', back: true }}>
        <Skeleton height={28} width="50%" />
        <Skeleton height={96} />
        <Skeleton height={120} />
        <Skeleton height={72} />
      </Screen>
    );
  }

  if (group.error || !group.data) {
    return (
      <Screen scroll={false} header={{ title: 'Bill', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Group unavailable"
          body={group.error?.message ?? 'This group is gone, or the link is wrong.'}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => group.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  if (billQuery.error) {
    return (
      <Screen scroll={false} header={{ title: 'Bill', back: true }}>
        <EmptyState
          icon={icon.warning}
          title="Could not load the bill"
          body={billQuery.error.message}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => billQuery.refetch()}
            />
          }
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={{
        title: bill?.title ?? bill?.merchant ?? 'Bill',
        subtitle: bill
          ? `${group.data.group.name} · ${statusCopy[bill.status] ?? bill.status}`
          : group.data.group.name,
        back: true,
      }}
      bottomInset={space.xl}
    >

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.alert} size={15} color={colors.danger} />
            <Text variant="label" tone="danger">
              That step did not go through
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}

      {!isFronter && (!bill || (!locked && bill.items.length === 0)) ? (
        <Card>
          <SectionHeading
            glyph={icon.time}
            title="Waiting for the bill"
            hint={`${fronterName} covered this bill. Your lines show up here once the split is proposed.`}
          />
        </Card>
      ) : null}

      {isFronter && !locked && (!bill || bill.items.length === 0) ? (
        <Card tone="accent">
          <SectionHeading
            glyph={bill ? icon.upload : icon.camera}
            title={bill ? 'Add a photo' : 'Start a bill'}
            hint={
              bill
                ? 'A photo is enough. Pick one you already have.'
                : 'A meal, rent, a trip, a gift — anything shared. Add a photo, or type the lines below.'
            }
          />
          {!bill ? (
            <>
              <Field
                label="What is it for?"
                placeholder="Rent, groceries, dinner…"
                value={title}
                onChangeText={setTitle}
                maxLength={120}
              />
              <View style={styles.chips}>
                {BILL_KINDS.map((entry) => (
                  <Button
                    key={entry.id}
                    compact
                    variant={kind === entry.id ? 'primary' : 'secondary'}
                    title={entry.label}
                    accessibilityLabel={`Bill type: ${entry.label}`}
                    onPress={() => setKind(entry.id)}
                  />
                ))}
              </View>
            </>
          ) : null}
          <Button
            title="Take a photo"
            icon={icon.camera}
            onPress={() => capture('camera')}
            loading={busy === 'capture'}
          />
          <Button
            title="Pick a photo or video"
            variant="secondary"
            icon={icon.images}
            onPress={() => capture('library')}
            loading={busy === 'capture'}
          />
        </Card>
      ) : null}

      {isFronter && !locked ? (
        <Card>
          <SectionHeading
            glyph={icon.add}
            title="Add a line by hand"
            hint="No photo needed. Type the name, how many, and the price."
          />
          <Field
            label="Line"
            placeholder="Pad thai"
            value={draft.name}
            onChangeText={(value) => setDraft((prev) => ({ ...prev, name: value }))}
            maxLength={200}
          />
          <View style={styles.pair}>
            <View style={styles.flex}>
              <Field
                label="How many"
                keyboardType="number-pad"
                value={draft.qty}
                onChangeText={(value) => setDraft((prev) => ({ ...prev, qty: value }))}
              />
            </View>
            <View style={styles.flex}>
              <Field
                label={`Price each (${currency})`}
                keyboardType="decimal-pad"
                placeholder="0.00"
                value={draft.price}
                onChangeText={(value) => setDraft((prev) => ({ ...prev, price: value }))}
              />
            </View>
          </View>
          <Button
            title="Add line"
            icon={icon.add}
            variant="secondary"
            onPress={addManualItem}
            loading={busy === 'item'}
          />
        </Card>
      ) : null}

      {bill ? (
        <>
          <Card>
            <View style={styles.rowBetween}>
              <View style={styles.flex}>
                <Text variant="label" tone="muted">
                  Total
                </Text>
                <Text variant="figure">{money.format(bill.totalMinor, currency)}</Text>
              </View>
              <View style={[styles.badge, locked && styles.badgeDone]}>
                <Icon
                  name={locked ? icon.lock : icon.sync}
                  size={12}
                  color={locked ? colors.accent : colors.muted}
                />
                <Text variant="caption" tone={locked ? 'accent' : 'muted'}>
                  {statusCopy[bill.status] ?? bill.status}
                </Text>
              </View>
            </View>
            {overEstimate !== null && agreement ? (
              <View
                accessible
                accessibilityRole="alert"
                accessibilityLabel={`This bill is ${money.format(
                  overEstimate,
                  currency
                )} more than the ${money.format(
                  agreement.estimatedTotalMinor,
                  agreement.currency
                )} you agreed to.`}
                style={styles.overEstimate}
              >
                <Icon name={icon.alert} size={15} color={colors.warn} />
                <View style={styles.flex}>
                  <Text variant="label" tone="warn">
                    {money.format(overEstimate, currency)} more than agreed
                  </Text>
                  <Text variant="caption" tone="warn">
                    You agreed to{' '}
                    {money.format(agreement.estimatedTotalMinor, agreement.currency)}. The
                    receipt came in at {money.format(bill.totalMinor, currency)}.
                  </Text>
                </View>
              </View>
            ) : null}
            <Text variant="caption" tone="muted">
              {money.approximate(bill.totalMinor, currency)
                ? `${money.formatOriginal(bill.totalMinor, currency)} · `
                : ''}
              {bill.items.length} {bill.items.length === 1 ? 'item' : 'items'}
              {bill.framesExtracted > 1
                ? `, reconciled from ${bill.framesExtracted} video frames`
                : ''}
            </Text>
            {bill.warnings.map((warning) => (
              <Text key={warning} variant="caption" tone="warn">
                {warning}
              </Text>
            ))}
            {isFronter && !locked && bill.status !== 'PARSING' ? (
              <>
                <Text variant="caption" tone="muted">
                  Wrong total or the photo was hard to read? Read the bill again from a
                  sharper photo. A new read replaces every line and clears the split.
                </Text>
                <View style={styles.chips}>
                  <Button
                    compact
                    variant="secondary"
                    icon={icon.camera}
                    title="Re-scan"
                    accessibilityLabel="Re-scan the receipt with the camera"
                    onPress={() => capture('camera')}
                    loading={busy === 'capture'}
                  />
                  <Button
                    compact
                    variant="secondary"
                    icon={icon.images}
                    title="Use another photo"
                    accessibilityLabel="Re-scan the receipt from another photo or video"
                    onPress={() => capture('library')}
                    loading={busy === 'capture'}
                  />
                </View>
              </>
            ) : null}
          </Card>

          {bill.status === 'PARSING' ? (
            <Card>
              <SectionHeading glyph={icon.scan} title="Reading the bill" hint="This takes a moment." />
              <Skeleton height={20} width="72%" />
              <Skeleton height={20} width="48%" />
            </Card>
          ) : null}

          {bill.items.length > 0 ? (
            <Card>
              <View style={styles.rowBetween}>
                <View style={styles.warnRow}>
                  <Icon name={icon.people} size={13} color={colors.mutedDim} />
                  <Text variant="label" tone="muted">
                    How to divide
                  </Text>
                </View>
                <Text variant="caption" tone="accent">
                  {splitMode === 'equal'
                    ? 'Evenly'
                    : splitMode === 'item'
                      ? 'By line item'
                      : splitMode === 'custom'
                        ? 'Amounts'
                        : 'Percent'}
                </Text>
              </View>
              {/* Everyone votes, not just the fronter: the agreement is shared. */}
              {agreement ? (
                <>
                  <View style={styles.segmented}>
                    {SPLIT_VOTES.map((option) => {
                      const leading = agreement.splitMode === option.id;
                      return (
                        <Pressable
                          key={option.id}
                          accessibilityRole="button"
                          accessibilityState={{ selected: agreement.myVote === option.id }}
                          disabled={locked || voteSplit.isPending}
                          onPress={() => onVote(option.id)}
                          style={[styles.segment, leading && styles.segmentActive]}
                        >
                          <Text variant="caption" tone={leading ? 'accent' : 'muted'}>
                            {option.label} · {agreement.votes[option.id]}
                          </Text>
                          {agreement.myVote === option.id ? (
                            <Icon name={icon.check} size={11} color={colors.accentText} />
                          ) : null}
                        </Pressable>
                      );
                    })}
                  </View>
                  <Text variant="caption" tone="muted">
                    {agreement.votes.item + agreement.votes.equal} of{' '}
                    {agreement.memberCount} members have voted. This is the
                    agreement-wide vote, applied to every bill.
                  </Text>
                </>
              ) : null}

              {isFronter && !locked ? (
                <>
                  <Text variant="label" tone="muted">
                    This bill
                  </Text>
                  <View style={styles.chips}>
                    {SPLIT_MODES.map((entry) => (
                      <Button
                        key={entry.id}
                        compact
                        variant={splitMode === entry.id ? 'primary' : 'secondary'}
                        title={entry.label}
                        accessibilityLabel={`Split: ${entry.label}`}
                        onPress={() => setModeDraft(entry.id)}
                      />
                    ))}
                  </View>
                  <Text variant="caption" tone="muted">
                    {SPLIT_HINTS[splitMode]}
                  </Text>
                </>
              ) : splitMode === 'equal' ? (
                <Text variant="caption" tone="muted">
                  The group chose to divide this bill equally, so there is nothing to
                  assign. Each of the {members.length} members gets the same share when it
                  is locked.
                </Text>
              ) : null}

              {splitMode === 'equal' ? (
                <Text variant="caption" tone="muted">
                  {members.length} {members.length === 1 ? 'member' : 'members'} · about{' '}
                  {money.format(evenShare, currency)} each.
                </Text>
              ) : null}
              {isFronter && !locked && (splitMode === 'custom' || splitMode === 'percent') ? (
                <>
                  {members.map((member) => (
                    <Field
                      key={member.id}
                      label={member.displayName}
                      keyboardType="decimal-pad"
                      placeholder={splitMode === 'percent' ? '%' : '0.00'}
                      value={shares[member.id] ?? ''}
                      onChangeText={(value) =>
                        setShares((prev) => ({ ...prev, [member.id]: value }))
                      }
                    />
                  ))}
                  <Text
                    variant="caption"
                    tone={
                      splitMode === 'custom'
                        ? customSum === bill.totalMinor
                          ? 'accent'
                          : 'warn'
                        : Math.abs(percentSum - 100) <= 0.01
                          ? 'accent'
                          : 'warn'
                    }
                  >
                    {splitMode === 'custom'
                      ? `${money.format(customSum, currency)} of ${money.format(bill.totalMinor, currency)}`
                      : `${percentSum}% of 100%`}
                  </Text>
                </>
              ) : null}
              {isFronter && !locked && splitMode !== 'item' ? (
                <Button
                  title="Lock the split"
                  icon={icon.lock}
                  onPress={lockSplit}
                  loading={busy === 'assign'}
                />
              ) : null}
            </Card>
          ) : null}

          {bill.items.length > 0 ? (
            <View style={styles.section}>
              <SectionHeading
                glyph={icon.receipt}
                title={splitMode === 'item' ? 'Who had what' : 'What is on the bill'}
                hint={
                  splitMode !== 'item'
                    ? 'These lines make up the total. The split is set above.'
                    : isFronter
                      ? 'Tap a name on every line to assign it. Each member confirms their own lines.'
                      : `${fronterName} is splitting this. You will confirm your own lines below.`
                }
              />
              {bill.items.map((item, index) => (
                <Card key={item.id} enter={index + 1} style={styles.itemCard}>
                  <View style={styles.rowBetween}>
                    <Text variant="label" style={styles.flex}>
                      {item.qty > 1 ? `${item.qty}× ` : ''}
                      {item.name}
                    </Text>
                    <Text variant="mono">{money.format(item.lineTotalMinor, currency)}</Text>
                  </View>
                  {splitMode === 'item' ? (
                    isFronter ? (
                      <>
                        <View style={styles.chips}>
                          {members.map((member) => {
                            const selected = (assignment[item.id] ?? []).includes(member.id);
                            return (
                              <Button
                                key={member.id}
                                compact
                                variant={selected ? 'primary' : 'secondary'}
                                icon={selected ? icon.check : undefined}
                                title={member.displayName}
                                accessibilityLabel={`${member.displayName}, ${
                                  selected ? 'on this item' : 'not on this item'
                                }`}
                                onPress={() => toggle(item.id, member.id)}
                              />
                            );
                          })}
                        </View>
                        {item.qty > 1 && (assignment[item.id] ?? []).length > 0 ? (
                          <View style={styles.chips}>
                            {(assignment[item.id] ?? []).map((memberId) => {
                              const member = members.find((entry) => entry.id === memberId);
                              if (!member) return null;
                              const key = `${item.id}:${memberId}`;
                              const count = qtyEdits[key] ?? 1;
                              return (
                                <View key={key} style={styles.stepper}>
                                  <Text variant="caption" tone="muted">
                                    {member.displayName}
                                  </Text>
                                  <Button
                                    compact
                                    variant="secondary"
                                    title="−"
                                    accessibilityLabel={`Fewer for ${member.displayName}`}
                                    disabled={count <= 1}
                                    onPress={() =>
                                      setQtyEdits((prev) => ({
                                        ...prev,
                                        [key]: Math.max(1, count - 1),
                                      }))
                                    }
                                  />
                                  <Text variant="mono">{count}</Text>
                                  <Button
                                    compact
                                    variant="secondary"
                                    title="+"
                                    accessibilityLabel={`More for ${member.displayName}`}
                                    disabled={count >= item.qty}
                                    onPress={() =>
                                      setQtyEdits((prev) => ({
                                        ...prev,
                                        [key]: Math.min(item.qty, count + 1),
                                      }))
                                    }
                                  />
                                </View>
                              );
                            })}
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <Text variant="caption" tone="muted">
                        {(assignment[item.id] ?? [])
                          .map(
                            (memberId) =>
                              members.find((member) => member.id === memberId)?.displayName
                          )
                          .filter(Boolean)
                          .join(', ') || 'Not assigned yet'}
                      </Text>
                    )
                  ) : null}
                  {item.confidence < 0.8 ? (
                    <View style={styles.warnRow}>
                      <Icon name={icon.warning} size={13} color={colors.warn} />
                      <Text variant="caption" tone="warn" style={styles.flex}>
                        Low confidence in this line. Check the amount.
                      </Text>
                    </View>
                  ) : null}
                  {isFronter && !locked ? (
                    editingId === item.id ? (
                      <>
                        <Field
                          label="Line"
                          value={lineDraft.name}
                          onChangeText={(value) =>
                            setLineDraft((prev) => ({ ...prev, name: value }))
                          }
                          maxLength={120}
                        />
                        <View style={styles.pair}>
                          <View style={styles.flex}>
                            <Field
                              label="How many"
                              keyboardType="number-pad"
                              value={lineDraft.qty}
                              onChangeText={(value) =>
                                setLineDraft((prev) => ({ ...prev, qty: value }))
                              }
                            />
                          </View>
                          <View style={styles.flex}>
                            <Field
                              label={`Price each (${currency})`}
                              keyboardType="decimal-pad"
                              placeholder="0.00"
                              value={lineDraft.price}
                              onChangeText={(value) =>
                                setLineDraft((prev) => ({ ...prev, price: value }))
                              }
                            />
                          </View>
                        </View>
                        <View style={styles.chips}>
                          <Button
                            compact
                            title="Save line"
                            icon={icon.check}
                            onPress={() => saveLine(item.id)}
                            loading={busy === `edit:${item.id}`}
                          />
                          <Button
                            compact
                            variant="secondary"
                            title="Cancel"
                            onPress={() => setEditingId(null)}
                          />
                        </View>
                      </>
                    ) : (
                      <View style={styles.chips}>
                        <Button
                          compact
                          variant="ghost"
                          title="Edit line"
                          onPress={() => startEdit(item)}
                          style={styles.inlineAction}
                        />
                        <Button
                          compact
                          variant="ghost"
                          title="Remove line"
                          onPress={() => removeItem(item.id)}
                          loading={busy === `item:${item.id}`}
                          style={styles.inlineAction}
                        />
                      </View>
                    )
                  ) : null}
                </Card>
              ))}
              {isFronter && splitMode === 'item' ? (
                <Button
                  title="Save split"
                  variant="secondary"
                  icon={icon.checkDone}
                  onPress={saveAssignments}
                  loading={busy === 'assign'}
                />
              ) : null}
            </View>
          ) : null}

          {myPending.length > 0 ? (
            <Card tone="accent">
              <SectionHeading
                glyph={icon.person}
                title="Confirm your share"
                hint="Only you can confirm your own lines."
              />
              {myPending.map((allocation) => (
                <View key={allocation.id} style={styles.rowBetween}>
                  <Text variant="body" style={styles.flex}>
                    {allocation.itemName}
                  </Text>
                  <View style={styles.amount}>
                    <Text variant="mono">{money.format(allocation.amountMinor, currency)}</Text>
                    {money.approximate(allocation.amountMinor, currency) ? (
                      <Text variant="caption" tone="dim" style={styles.amountNote}>
                        {money.formatOriginal(allocation.amountMinor, currency)}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
              <Button
                title="These are mine"
                icon={icon.check}
                onPress={confirmMine}
                loading={busy === 'confirm'}
              />
            </Card>
          ) : null}

          {!isFronter && (bill.status === 'FINALIZED' || bill.status === 'COLLECTING') ? (
            <Card>
              <SectionHeading
                glyph={icon.paypal}
                title="Reimbursement"
                hint={`${fronterName} paid the bill. Pay your share from the My shares tab — the money goes straight to them, never to Globie.`}
              />
            </Card>
          ) : null}

          {isFronter && (bill.status === 'FINALIZED' || bill.status === 'COLLECTING') ? (
            <Card>
              <SectionHeading
                glyph={icon.paypal}
                title="Request payment"
                hint="Each member gets a PayPal order or a PayPal.Me link in the system browser, not an embedded webview. Both pay the fronter direct."
              />
              <Button
                title="Send PayPal requests"
                icon={icon.paypal}
                onPress={runRequestPayments}
                loading={busy === 'request'}
              />
              {approveUrl ? (
                <Button
                  variant="ghost"
                  compact
                  icon={icon.link}
                  title="Reopen payment link"
                  onPress={() => WebBrowser.openBrowserAsync(approveUrl)}
                  style={styles.inlineAction}
                />
              ) : null}
            </Card>
          ) : null}

          {bill && locked && tips.data ? (
            <Card>
              <SectionHeading
                glyph={icon.hand}
                title="Tip the fronter"
                hint={`${tips.data.frontedByName} covered the bill. A tip is a thank-you, on top of your share.`}
              />
              {myTip && myTip.status === 'failed' ? (
                <>
                  <Text variant="body">
                    The PayPal checkout didn&apos;t go through, so nothing was charged.
                    Try again with one of these amounts, or name your own.
                  </Text>
                  {tips.data.canTip ? (
                    <TipAmounts
                      currency={currency}
                      maxMinor={bill.totalMinor}
                      busy={busy === 'tip'}
                      onSend={tipFronter}
                    />
                  ) : null}
                </>
              ) : myTip ? (
                <>
                  <View style={styles.rowBetween}>
                    <Text variant="body" style={styles.flex}>
                      {myTip.status === 'paid'
                        ? 'You tipped'
                        : 'Your tip is waiting for approval'}
                    </Text>
                    <Text variant="mono">
                      {money.format(myTip.amountMinor, currency)}
                    </Text>
                  </View>
                  {myTip.feeMinor ? (
                    <Text variant="caption" tone="dim">
                      {myTip.status === 'paid' ? 'Paid' : 'PayPal asks for'}{' '}
                      {money.format(myTip.grossMinor ?? myTip.amountMinor, currency)} —{' '}
                      {money.format(myTip.feeMinor, currency)} covers the PayPal fee.
                    </Text>
                  ) : null}
                  {myTip.canFinish ? (
                    <Button
                      compact
                      icon={icon.paypal}
                      title="Finish payment"
                      loading={busy === 'tip'}
                      onPress={() => finishTip(myTip.id)}
                    />
                  ) : null}
                </>
              ) : !tips.data.payoutReady ? (
                <Text variant="caption" tone="warn">
                  {tips.data.frontedBy === me?.id
                    ? 'Add your PayPal email in Settings so the group can tip you.'
                    : `${tips.data.frontedByName} needs to add a PayPal email before tips can go through.`}
                </Text>
              ) : tips.data.canTip ? (
                <TipAmounts
                  currency={currency}
                  maxMinor={bill.totalMinor}
                  busy={busy === 'tip'}
                  onSend={tipFronter}
                />
              ) : (
                <Text variant="caption" tone="muted">
                  {tips.data.frontedBy === me?.id
                    ? 'You fronted this bill — the tips land with you.'
                    : 'Tips are closed for this bill.'}
                </Text>
              )}

              {tips.data.canTip ? (
                <Text variant="caption" tone="dim">
                  If {tips.data.frontedByName} covers the PayPal fee, PayPal asks for
                  the tip plus an estimated fee. The amount is shown before you approve.
                </Text>
              ) : null}

              {paidTips.map((tip) => (
                <View key={tip.id} style={styles.rowBetween}>
                  <Text variant="caption" style={styles.flex}>
                    {tip.fromMemberName}
                    {tip.message ? ` — ${tip.message}` : ''}
                  </Text>
                  <Text variant="mono">{money.format(tip.amountMinor, currency)}</Text>
                </View>
              ))}

              {tips.data.totalMinor > 0 ? (
                <Text variant="caption" tone="accent">
                  {money.format(tips.data.totalMinor, currency)} tipped so far
                </Text>
              ) : null}
            </Card>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  amount: { alignItems: 'flex-end' },
  amountNote: { textAlign: 'right' },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  badgeDone: { borderColor: colors.accentText },
  section: { gap: space.md },
  itemCard: { gap: space.sm },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // a two-way vote reads as one control, not two buttons
  segmented: {
    flexDirection: 'row',
    gap: space.xs,
    padding: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  segment: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  segmentActive: { backgroundColor: colors.wash, borderWidth: 1, borderColor: colors.accentText },
  pair: { flexDirection: 'row', gap: space.md },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  overEstimate: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.warn,
    backgroundColor: colors.warnWash,
  },
  inlineAction: { alignSelf: 'flex-start' },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
