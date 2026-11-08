import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { formatMinor, toMinor } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import {
    useBill,
    useCaptureTip,
    useConfirmAllocation,
    useCreateBill,
    useFinalizeBill,
    useGroup,
    useParseBill,
    useRequestPayments,
    useRequestTip,
    useSetAllocations,
    useTips,
    useUploadMedia
} from '@/lib/queries';

type Assignment = Record<string, string[]>;

const statusCopy: Record<string, string> = {
  UPLOADED: 'Uploaded',
  PARSING: 'Reading the receipt',
  PARSED: 'Read, check the lines',
  ALLOCATED: 'Split proposed',
  CONFIRMED: 'Everyone confirmed',
  FINALIZED: 'Locked',
  COLLECTING: 'Collecting',
  SETTLED: 'Settled',
};
const collectedStatus = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);

/** Thank-you sizes, in major units, so the taps stay one-handed. */
const TIP_PRESETS = [toMinor(20), toMinor(50), toMinor(100)];

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
  const finalize = useFinalizeBill(id);
  const requestPayments = useRequestPayments();
  const requestTip = useRequestTip(activeBillId);
  const captureTip = useCaptureTip();

  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approveUrl, setApproveUrl] = useState<string | null>(null);

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
  const paidTips = (tips.data?.tips ?? []).filter((tip) => tip.status === 'paid');
  const myTip = tips.data?.myTip ?? null;

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
  const pendingCount = allocations.filter((a) => a.status === 'proposed').length;

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
        const agreement = group.data?.agreement;
        if (!agreement) throw new Error('Create the agreement first');
        const created = await createBill.mutateAsync({
          agreementId: agreement.id,
          currency: agreement.currency,
        });
        targetBillId = created.bill.id;
      }

      await uploadMedia.mutateAsync({
        billId: targetBillId,
        uri: asset.uri,
        kind,
        file: asset.file ?? undefined,
      });
      await parseBill.mutateAsync({ billId: targetBillId });
      notify({ title: 'Receipt read', body: 'Kae Na checked every line. Confirm your share.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read the receipt');
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
        memberIds.map((memberId) => ({ billItemId, memberId, qty: 1 }))
      );
      await setAllocations.mutateAsync({ billId: bill.id, allocations: payload });
      notify({ title: 'Split proposed', body: 'The crew gets a tap to confirm.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save the split');
    } finally {
      setBusy(null);
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

  async function runFinalize() {
    if (!bill) return;
    setBusy('finalize');
    setError(null);
    try {
      await finalize.mutateAsync({ billId: bill.id });
      notify({ title: 'Bill locked', body: 'Nobody edits it now — time to collect.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not lock the bill');
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
      <Screen scroll={false} header={{ title: 'Receipt', back: true }}>
        <Skeleton height={28} width="50%" />
        <Skeleton height={96} />
        <Skeleton height={120} />
        <Skeleton height={72} />
      </Screen>
    );
  }

  if (group.error || !group.data) {
    return (
      <Screen scroll={false} header={{ title: 'Receipt', back: true }}>
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
      <Screen scroll={false} header={{ title: 'Receipt', back: true }}>
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
        title: bill?.merchant ?? 'Receipt',
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
            title="Waiting for the receipt"
            hint={`${fronterName} covered this bill and will capture it. Your lines show up here once the split is proposed.`}
          />
        </Card>
      ) : null}

      {isFronter && (!bill || (!locked && bill.items.length === 0)) ? (
        <Card tone="accent">
          <SectionHeading
            glyph={bill ? icon.upload : icon.camera}
            title={bill ? 'Upload the receipt' : 'Capture the receipt'}
            hint={
              bill
                ? 'A photo is enough. Pick one you already have.'
                : 'A photo is enough. A short video works too: we sample frames and reconcile them into one list.'
            }
          />
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
          </Card>

          {bill.status === 'PARSING' ? (
            <Card>
              <SectionHeading glyph={icon.scan} title="Reading the receipt" hint="This takes a moment." />
              <Skeleton height={20} width="72%" />
              <Skeleton height={20} width="48%" />
            </Card>
          ) : null}

          {bill.items.length > 0 ? (
            <View style={styles.section}>
              <SectionHeading
                glyph={icon.receipt}
                title="Who had what"
                hint={
                  isFronter
                    ? 'Tap a name on every item to assign it. Each member confirms their own lines.'
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
                  {isFronter ? (
                    <View style={styles.chips}>
                      {(group.data?.members ?? []).map((member) => {
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
                  ) : (
                    <Text variant="caption" tone="muted">
                      {(assignment[item.id] ?? [])
                        .map(
                          (memberId) =>
                            (group.data?.members ?? []).find((member) => member.id === memberId)
                              ?.displayName
                        )
                        .filter(Boolean)
                        .join(', ') || 'Not assigned yet'}
                    </Text>
                  )}
                  {item.confidence < 0.8 ? (
                    <View style={styles.warnRow}>
                      <Icon name={icon.warning} size={13} color={colors.warn} />
                      <Text variant="caption" tone="warn" style={styles.flex}>
                        Low confidence in this line. Check the amount.
                      </Text>
                    </View>
                  ) : null}
                </Card>
              ))}
              {isFronter ? (
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

          {isFronter && pendingCount === 0 && allocations.length > 0 && !locked ? (
            <Card>
              <SectionHeading
                glyph={icon.lock}
                title="Lock the bill"
                hint="Every line is confirmed. Locking turns the split into shares and starts the Globie race."
              />
              <Button
                title="Lock the bill"
                icon={icon.lock}
                onPress={runFinalize}
                loading={busy === 'finalize'}
              />
            </Card>
          ) : null}

          {!isFronter && (bill.status === 'FINALIZED' || bill.status === 'COLLECTING') ? (
            <Card>
              <SectionHeading
                glyph={icon.paypal}
                title="Reimbursement"
                hint={`${fronterName} paid the merchant. Pay your share from the My shares tab — the money goes straight to them, never to Globie.`}
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

          {locked && tips.data ? (
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
                    Try again with one of these amounts.
                  </Text>
                  {tips.data.canTip ? (
                    <View style={styles.chips}>
                      {TIP_PRESETS.map((amountMinor) => (
                        <Button
                          key={amountMinor}
                          compact
                          variant="secondary"
                          icon={icon.hand}
                          title={formatMinor(amountMinor, currency)}
                          accessibilityLabel={`Tip ${formatMinor(amountMinor, currency)}`}
                          onPress={() => tipFronter(amountMinor)}
                          disabled={busy === 'tip'}
                        />
                      ))}
                    </View>
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
                <View style={styles.chips}>
                  {TIP_PRESETS.map((amountMinor) => (
                    <Button
                      key={amountMinor}
                      compact
                      variant="secondary"
                      icon={icon.hand}
                      title={formatMinor(amountMinor, currency)}
                      accessibilityLabel={`Tip ${formatMinor(amountMinor, currency)}`}
                      onPress={() => tipFronter(amountMinor)}
                      disabled={busy === 'tip'}
                    />
                  ))}
                </View>
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
  warnRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
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
