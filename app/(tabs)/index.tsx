import { Link, router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ShareRow } from '@/components/ledger/share-row';
import { Button, IconButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { CurrencyPill } from '@/components/ui/currency-pill';
import { CurrencySelect } from '@/components/ui/currency-select';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, space } from '@/components/ui/theme';
import { useMoney } from '@/lib/money-context';
import { useCreateGroup, useJoinGroup, useMyPoints, useMyShares } from '@/lib/queries';
import { useSession } from '@/lib/session-context';

const DEFAULT_CURRENCY = 'THB';

export default function HomeScreen() {
  const { session, signOut } = useSession();
  const shares = useMyShares();
  const points = useMyPoints();
  const createGroup = useCreateGroup();
  const joinGroup = useJoinGroup();
  const notify = useMascotToast();
  const money = useMoney();

  const [groupName, setGroupName] = useState('');
  const [currency, setCurrency] = useState(DEFAULT_CURRENCY);
  const [inviteCode, setInviteCode] = useState('');

  const openShares = (shares.data?.shares ?? []).filter(
    (share) => share.status !== 'paid' && share.status !== 'settled'
  );
  const firstName = (session?.displayName ?? 'Friend').split(' ')[0];

  const owesMinor = shares.data?.outstandingMinor ?? 0;
  const owesCurrency = shares.data?.currency ?? DEFAULT_CURRENCY;
  // The hero may read in the member's own currency, but the amount they will be
  // charged stays on screen beside it (§2.19).
  const owesConverted =
    money.displayCurrency !== null && money.displayCurrency !== owesCurrency;

  async function onCreate() {
    if (groupName.trim().length < 2) return;
    const result = await createGroup.mutateAsync({
      name: groupName.trim(),
      currency,
    });
    setGroupName('');
    notify({
      title: 'Table opened',
      body: `${result.group.name} is ready for the crew.`,
    });
    router.push({ pathname: '/groups/[id]', params: { id: result.group.id } });
  }

  async function onJoin() {
    if (inviteCode.trim().length < 4) return;
    const result = await joinGroup.mutateAsync({
      inviteToken: inviteCode.trim(),
      displayName: session?.displayName ?? '',
    });
    setInviteCode('');
    notify({
      title: 'You are in',
      body: `${result.group.name} joined. Globie is keeping score.`,
    });
    router.push({ pathname: '/groups/[id]', params: { id: result.group.id } });
  }

  return (
    <Screen
      header={{
        title: `Hey, ${firstName}`,
        subtitle: 'Globie is keeping the table honest.',
        action: (
          <View style={styles.headerActions}>
            <CurrencyPill />
            <IconButton name={icon.logOut} label="Sign out" tone="muted" onPress={signOut} />
          </View>
        ),
      }}
    >
      <Card tone="accent">
        <View style={styles.heroRow}>
          <View style={styles.heroCopy}>
            <Text variant="label" tone="muted">
              You owe
            </Text>
            <Text variant="figure">{money.format(owesMinor, owesCurrency)}</Text>
            <Text variant="caption" tone="muted">
              {owesConverted
                ? `${money.formatOriginal(owesMinor, owesCurrency)} · `
                : ''}
              across {openShares.length} open {openShares.length === 1 ? 'share' : 'shares'}
            </Text>
          </View>
          <View style={styles.heroGlyph}>
            <BabyKaeNa size={54} variant="badge" mood="cheer" label={null} />
          </View>
        </View>
      </Card>

      <View style={styles.tiles}>
        <Stat
          glyph={icon.hero}
          mascot
          label="Globie"
          value={String(points.data?.balance ?? 0)}
          hint="engagement points"
        />
        <Stat glyph={icon.receipt} label="Open" value={String(openShares.length)} hint="unsettled bills" />
      </View>

      <Card>
        <SectionHeading glyph={icon.people} title="Start a dinner" hint="Open a table and invite the crew." />
        <Field
          label="Group name"
          value={groupName}
          onChangeText={setGroupName}
          placeholder="Friday somtam crew"
        />
        <CurrencySelect
          label="Currency"
          value={currency}
          onChange={setCurrency}
          hint="Members are reimbursed in this currency."
          error={createGroup.error?.message}
        />
        <Button
          title="Create group"
          icon={icon.add}
          onPress={onCreate}
          loading={createGroup.isPending}
          disabled={groupName.trim().length < 2}
        />
      </Card>

      <Card>
        <SectionHeading glyph={icon.qr} title="Join with a code" hint="Got an invite from the fronter?" />
        <Field
          label="Invite code"
          value={inviteCode}
          onChangeText={setInviteCode}
          placeholder="Paste the group code"
          autoCapitalize="none"
          error={joinGroup.error?.message}
        />
        <Button
          title="Join group"
          variant="secondary"
          icon={icon.personAdd}
          onPress={onJoin}
          loading={joinGroup.isPending}
          disabled={inviteCode.trim().length < 4}
        />
        <Button
          title="Scan the QR code"
          variant="ghost"
          compact
          icon={icon.scan}
          onPress={() => router.push('/scan')}
        />
      </Card>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text variant="title">Open shares</Text>
          <Link href="/me/shares" asChild>
            <Button variant="ghost" compact title="See all" icon={icon.chevronRight} iconSide="right" />
          </Link>
        </View>
        {shares.isLoading ? (
          <View style={styles.list} accessibilityElementsHidden>
            <Skeleton height={72} />
            <Skeleton height={72} />
          </View>
        ) : shares.error ? (
          <Card>
            <Text variant="label" tone="danger">
              Could not load your shares
            </Text>
            <Text variant="caption" tone="muted">
              {shares.error.message}
            </Text>
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => shares.refetch()}
              style={styles.inline}
            />
          </Card>
        ) : openShares.length === 0 ? (
          <EmptyState
            icon={icon.checkCircle}
            title="Nothing outstanding"
            body="Front a meal and you take the Hero crown."
          />
        ) : (
          <View style={styles.list}>
            {openShares.slice(0, 4).map((share) => (
              <ShareRow
                key={share.id}
                share={share}
                onPress={() =>
                  router.push({ pathname: '/groups/[id]', params: { id: share.groupId } })
                }
              />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function Stat({
  glyph,
  mascot = false,
  label,
  value,
  hint,
}: {
  glyph: (typeof icon)[keyof typeof icon];
  mascot?: boolean;
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card style={styles.tile}>
      <View style={styles.tileTop}>
        <Text variant="label" tone="muted">
          {label}
        </Text>
        {mascot ? (
          <BabyKaeNa size={22} variant="badge" sparkles={false} label={null} />
        ) : (
          <Icon name={glyph} size={16} color={colors.mutedDim} />
        )}
      </View>
      <Text variant="title" tone="accent">
        {value}
      </Text>
      <Text variant="caption" tone="dim">
        {hint}
      </Text>
    </Card>
  );
}

const styles = StyleSheet.create({
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroCopy: { flex: 1, gap: space.xs },
  heroGlyph: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tiles: { flexDirection: 'row', gap: space.md },
  tile: { flex: 1, gap: space.xs },
  tileTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  section: { gap: space.md },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  list: { gap: space.sm },
  inline: { alignSelf: 'flex-start' },
});
