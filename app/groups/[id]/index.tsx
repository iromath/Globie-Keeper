import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { GlobieChat } from '@/components/chat/globie-chat';
import { Timeline } from '@/components/chat/timeline';
import { InviteCard } from '@/components/groups/invite-card';
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
import { formatMinor, toMinor } from '@/lib/money';
import { useMoney } from '@/lib/money-context';
import {
  useAcceptAgreement,
  useCreateAgreement,
  useGroup,
  useGroupTimeline,
  useVoteSplitMode,
} from '@/lib/queries';
import type { Agreement, AgreementSplitMode } from '@/lib/types';

const statusCopy: Record<Agreement['status'], string> = {
  draft: 'Draft',
  pending: 'Pending',
  accepted: 'Agreed',
  cancelled: 'Cancelled',
  settled: 'Settled',
};

const SPLIT_VOTES: { id: AgreementSplitMode; label: string }[] = [
  { id: 'item', label: 'By line item' },
  { id: 'equal', label: 'Evenly' },
];

/** 300 bps reads as 3% — terms are signed in percents, not basis points. */
const asPercent = (bps: number) => String(Number((bps / 100).toFixed(2)));

export default function GroupScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const notify = useMascotToast();
  const money = useMoney();
  const group = useGroup(id);
  const timeline = useGroupTimeline(id);
  const createAgreement = useCreateAgreement(id);
  const acceptAgreement = useAcceptAgreement(id);
  const voteSplit = useVoteSplitMode(id);

  const [estimate, setEstimate] = useState('');
  const [deadlineDays, setDeadlineDays] = useState('3');
  /** `none` means nobody can be charged extra; `monthly` needs a rate to sign. */
  const [lateFeeKind, setLateFeeKind] = useState<'none' | 'monthly'>('none');
  const [lateFeeRate, setLateFeeRate] = useState('3');
  const [lateFeeCap, setLateFeeCap] = useState('5');
  const [formError, setFormError] = useState<string | null>(null);
  // Who actually paid the merchant. Creating the agreement does not answer it.
  const [frontedBy, setFrontedBy] = useState<string | null>(null);

  if (group.isLoading) {
    return (
      <Screen scroll={false} header={{ title: 'Group', back: true }}>
        <Skeleton height={28} width="55%" />
        <Skeleton height={124} />
        <Skeleton height={96} />
      </Screen>
    );
  }

  if (group.error || !group.data) {
    return (
      <Screen scroll={false} header={{ title: 'Group', back: true }}>
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

  const { members, agreement, bill, me } = group.data;
  const currency = group.data.group.defaultCurrency;
  const myAcceptanceMissing =
    agreement?.status === 'pending' &&
    !timeline.data?.events.some(
      (event) => event.type === 'agreement.accepted' && event.actor === me.displayName
    );
  const agreed = agreement?.status === 'accepted';
  const isFronter = Boolean(agreement && agreement.frontedBy === me.id);
  const fronterName = members.find((member) => member.id === agreement?.frontedBy)?.displayName;

  async function onCreateAgreement() {
    const estimatedTotalMinor = toMinor(estimate || '0');
    if (!Number.isFinite(estimatedTotalMinor)) return;
    let lateFeeBps = 0;
    let lateFeeCapBps: number | null = null;
    if (lateFeeKind === 'monthly') {
      const rate = Number(lateFeeRate);
      if (!Number.isFinite(rate) || rate <= 0) {
        setFormError('Give the monthly fee a rate, or choose no late fee.');
        return;
      }
      lateFeeBps = Math.round(rate * 100);
      if (lateFeeCap.trim()) {
        const cap = Number(lateFeeCap);
        if (!Number.isFinite(cap) || cap <= 0) {
          setFormError('The cap is a percentage of the share, or leave it empty.');
          return;
        }
        lateFeeCapBps = Math.round(cap * 100);
      }
    }
    setFormError(null);
    const days = Number(deadlineDays) || 3;
    await createAgreement.mutateAsync({
      estimatedTotalMinor,
      deadline: new Date(Date.now() + days * 86_400_000).toISOString(),
      frontedByMemberId: frontedBy ?? me.id,
      lateFeeBps,
      lateFeeCapBps,
    });
    setEstimate('');
    notify({
      title: 'Agreement set',
      body: `${formatMinor(estimatedTotalMinor, currency)} locked in — everyone taps to agree.`,
    });
  }

  async function onAcceptAgreement(agreementId: string) {
    await acceptAgreement.mutateAsync(agreementId);
    notify({ title: 'You agreed', body: 'Kae Na has your tap on record.' });
  }

  async function onVote(splitMode: AgreementSplitMode) {
    if (!agreement || agreement.myVote === splitMode) return;
    try {
      await voteSplit.mutateAsync({ agreementId: agreement.id, splitMode });
    } catch (cause) {
      notify({
        title: 'Vote not saved',
        body: cause instanceof Error ? cause.message : 'Try again in a moment.',
      });
    }
  }

  const billAction = bill
    ? bill.items.length > 0 || !isFronter
      ? { title: 'Open the bill', glyph: icon.receipt }
      : { title: 'Upload the receipt', glyph: icon.upload }
    : isFronter
      ? { title: 'Capture the receipt', glyph: icon.camera }
      : { title: 'Waiting for the receipt', glyph: icon.time };

  return (
    <Screen
      header={{
        title: group.data.group.name,
        subtitle: `${members.length} in the group · ${currency}`,
        back: true,
      }}
      bottomInset={space.xl}
    >
      <InviteCard group={group.data.group} memberCount={members.length} />

      <Card tone="alt" enter={1}>
        <SectionHeading
          glyph={icon.people}
          title="Who is in"
          hint={`${members.length} in the group`}
        />
        <View style={styles.memberChips}>
          {members.map((member) => {
            const mine = member.id === me.id;
            return (
              <View key={member.id} style={[styles.chip, mine && styles.chipMe]}>
                <Icon name={icon.person} size={12} color={mine ? colors.accent : colors.mutedDim} />
                <Text variant="caption" tone={mine ? 'accent' : 'muted'}>
                  {member.displayName}
                  {member.role === 'owner' ? ' (host)' : ''}
                </Text>
              </View>
            );
          })}
        </View>
      </Card>

      {!agreement ? (
        <Card tone="accent" enter={2}>
          <SectionHeading
            glyph={icon.shield}
            title="Set the agreement"
            hint="Everyone taps once. Nobody argues later about who said they were in."
          />
          <Text variant="label" tone="muted">
            Who paid the merchant?
          </Text>
          <View style={styles.memberChips}>
            {members.map((member) => {
              const selected = (frontedBy ?? me.id) === member.id;
              return (
                <Pressable
                  key={member.id}
                  onPress={() => setFrontedBy(member.id)}
                  style={[styles.chip, styles.pickerChip, selected && styles.pickerChipActive]}
                >
                  <Icon
                    name={icon.person}
                    size={12}
                    color={selected ? colors.accent : colors.mutedDim}
                  />
                  <Text variant="caption" tone={selected ? 'accent' : 'muted'}>
                    {member.displayName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          <Text variant="caption" tone="muted">
            Only the person who paid the merchant can steer the bill — the split,
            the nudges and the payment requests are theirs.
          </Text>
          <Field
            label={`Estimated total (${currency})`}
            value={estimate}
            onChangeText={setEstimate}
            keyboardType="decimal-pad"
            placeholder="1200.00"
          />
          <Field
            label="Reimburse within (days)"
            value={deadlineDays}
            onChangeText={setDeadlineDays}
            keyboardType="number-pad"
            error={createAgreement.error?.message}
          />
          <Text variant="label" tone="muted">
            If someone is late
          </Text>
          <View style={styles.segmented}>
            {(
              [
                { id: 'none', label: 'No late fee' },
                { id: 'monthly', label: 'Monthly fee' },
              ] as const
            ).map((option) => {
              const selected = lateFeeKind === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    setLateFeeKind(option.id);
                    setFormError(null);
                  }}
                  style={[styles.segment, selected && styles.segmentActive]}
                >
                  <Text variant="caption" tone={selected ? 'accent' : 'muted'}>
                    {option.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>
          {lateFeeKind === 'monthly' ? (
            <>
              <Field
                label="Late fee (% per month)"
                value={lateFeeRate}
                onChangeText={setLateFeeRate}
                keyboardType="decimal-pad"
                placeholder="3"
                error={formError ?? undefined}
              />
              <Field
                label="Cap (% of the share, optional)"
                value={lateFeeCap}
                onChangeText={setLateFeeCap}
                keyboardType="decimal-pad"
                placeholder="5"
              />
              <Text variant="caption" tone="muted">
                Charged on top of the share, only after the due date, and only by the
                person who fronted. Everyone signs these exact terms.
              </Text>
            </>
          ) : (
            <Text variant="caption" tone="muted">
              Nobody can be charged extra for paying late. This is part of the terms
              everyone signs.
            </Text>
          )}
          <Button
            title="Create agreement"
            icon={icon.check}
            onPress={onCreateAgreement}
            loading={createAgreement.isPending}
          />
        </Card>
      ) : (
        <Card tone={agreed ? 'accent' : 'surface'} enter={2}>
          <View style={styles.rowBetween}>
            <Text variant="label" tone="muted">
              Agreement
            </Text>
            <View style={[styles.badge, agreed && styles.badgeAgreed]}>
              <Icon
                name={agreed ? icon.shield : icon.time}
                size={12}
                color={agreed ? colors.accent : colors.warn}
              />
              <Text variant="caption" tone={agreed ? 'accent' : 'warn'}>
                {statusCopy[agreement.status]}
              </Text>
            </View>
          </View>
          <Text variant="figure" numberOfLines={1}>
            {money.format(agreement.estimatedTotalMinor, agreement.currency)}
          </Text>
          <Text variant="caption" tone="muted">
            {money.approximate(agreement.estimatedTotalMinor, agreement.currency)
              ? `${money.formatOriginal(agreement.estimatedTotalMinor, agreement.currency)} · `
              : ''}
            {agreement.acceptedCount} of {agreement.memberCount} accepted
            {agreement.deadline
              ? `, due ${new Date(agreement.deadline).toLocaleDateString()}`
              : ''}
          </Text>
          {fronterName ? (
            <Text variant="caption" tone={isFronter ? 'accent' : 'muted'}>
              Fronted by {fronterName}
              {isFronter ? ' (you)' : ''}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            {agreement.lateFeeBps > 0
              ? `Late fee ${asPercent(agreement.lateFeeBps)}% per month${
                  agreement.lateFeeCapBps !== null
                    ? `, capped at ${asPercent(agreement.lateFeeCapBps)}% of the share`
                    : ''
                }`
              : 'No late fee'}
          </Text>
          {/* The vote is agreement-wide, not per bill: whatever leads here is the
              mode a new bill starts in, and everyone sees the same tally. */}
          <View style={styles.rowBetween}>
            <View style={styles.inline}>
              <Icon name={icon.people} size={13} color={colors.mutedDim} />
              <Text variant="label" tone="muted">
                How to divide
              </Text>
            </View>
            <Text variant="caption" tone="accent">
              {agreement.splitMode === 'equal' ? 'Evenly' : 'By line item'}
            </Text>
          </View>
          <View style={styles.segmented}>
            {SPLIT_VOTES.map((option) => {
              const leading = agreement.splitMode === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: agreement.myVote === option.id }}
                  disabled={voteSplit.isPending}
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
            {agreement.votes.item + agreement.votes.equal} of {agreement.memberCount}{' '}
            members have voted. This is the agreement-wide vote, applied to every bill.
          </Text>
          {/* The figure above is only what everyone agreed to before the receipt.
              When the receipt lands higher, say so here, next to that number. */}
          {bill &&
          agreement.currency === bill.currency &&
          bill.totalMinor > agreement.estimatedTotalMinor ? (
            <Text variant="caption" tone="warn">
              Bill {money.format(bill.totalMinor, bill.currency)} —{' '}
              {money.format(bill.totalMinor - agreement.estimatedTotalMinor, bill.currency)}{' '}
              over the agreed estimate.
            </Text>
          ) : null}

          {myAcceptanceMissing ? (
            <Button
              title="I agree to these terms"
              icon={icon.check}
              onPress={() => onAcceptAgreement(agreement.id)}
              loading={acceptAgreement.isPending}
            />
          ) : null}

          {/* An existing bill stays reachable while the agreement is still being
              accepted — its shares, receipt and tip card do not wait on a tap. */}
          {agreed || bill ? (
            <View style={styles.actions}>
              <Button
                title={billAction.title}
                icon={billAction.glyph}
                onPress={() =>
                  bill
                    ? router.push({
                        pathname: '/groups/[id]/bill',
                        params: { id, billId: bill.id },
                      })
                    : router.push({ pathname: '/groups/[id]/bill', params: { id } })
                }
              />
              {agreed ? (
                <Button
                  title="Leaderboard"
                  variant="secondary"
                  icon={icon.hero}
                  onPress={() =>
                    router.push({ pathname: '/groups/[id]/leaderboard', params: { id } })
                  }
                />
              ) : null}
            </View>
          ) : myAcceptanceMissing ? null : (
            <View style={styles.waiting}>
              <Icon name={icon.time} size={14} color={colors.warn} />
              <Text variant="caption" tone="warn">
                Waiting for every member to tap accept.
              </Text>
            </View>
          )}
        </Card>
      )}

      <View style={styles.section}>
        <SectionHeading glyph={icon.chat} title="Group chat" hint="Every tap lands here." />
        <Timeline events={timeline.data?.events ?? []} currency={currency} />
      </View>

      <GlobieChat
        groupId={id}
        agreementId={agreement?.id ?? null}
        billId={bill?.id ?? null}
        billStatus={bill?.status ?? null}
        currency={currency}
        members={members}
        isFronter={isFronter}
        onPayMyShare={() => router.push('/me/shares')}
        onOpenBill={() =>
          bill
            ? router.push({ pathname: '/groups/[id]/bill', params: { id, billId: bill.id } })
            : router.push({ pathname: '/groups/[id]/bill', params: { id } })
        }
      />

      <View style={styles.linkRow}>
        <Button
          variant="ghost"
          compact
          icon={icon.hero}
          title="Who fronted the most this month?"
          onPress={() => router.push({ pathname: '/groups/[id]/leaderboard', params: { id } })}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  memberChips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.xs },
  // squared off: a person is not a status pill
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.sm,
    paddingVertical: 4,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
  },
  chipMe: { backgroundColor: colors.wash },
  pickerChip: { borderWidth: 1, borderColor: 'transparent' },
  pickerChipActive: { borderColor: colors.accentText, backgroundColor: colors.wash },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.warn,
  },
  badgeAgreed: { borderColor: colors.accentText },
  actions: { gap: space.sm },
  waiting: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  inline: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
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
  section: { gap: space.md },
  linkRow: { alignItems: 'center' },
});
