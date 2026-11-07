import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useMoney } from '@/lib/money-context';
import { useGroup, useLeaderboard } from '@/lib/queries';

export default function LeaderboardScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = useGroup(id);
  const leaderboard = useLeaderboard(id);
  const money = useMoney();

  const currency = group.data?.group.defaultCurrency ?? 'THB';
  const rows = leaderboard.data?.rows ?? [];

  return (
    <Screen>
      <View style={styles.header}>
        <View style={styles.halo}>
          <Icon name={icon.hero} size={28} color={colors.hero} />
        </View>
        <Text variant="display">Hero board</Text>
        <Text variant="body" tone="muted">
          Rolling 30 days. The money shows cash fronted — it wins the Hero seat and pays a flat 5
          Globie. The line under a name shows how fast they repay others, and that speed earns more.
        </Text>
      </View>

      {leaderboard.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      ) : leaderboard.error ? (
        <EmptyState
          icon={icon.warning}
          title="Could not load the board"
          body={leaderboard.error.message}
          action={
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => leaderboard.refetch()}
            />
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={icon.heroOutline}
          title="Nobody has fronted yet"
          body="The board fills in once a bill is settled. Pay for the next meal and you take the top seat."
        />
      ) : (
        <View style={styles.list}>
          {rows.map((row, index) => (
            <Card
              key={row.memberId}
              tone={row.isHero ? 'accent' : 'surface'}
              enter={index}
              style={styles.row}
            >
              <View style={[styles.rank, row.isHero && styles.heroRank]}>
                {row.isHero ? (
                  <Icon name={icon.hero} size={16} color={colors.accentInk} />
                ) : (
                  <Text variant="label" tone="muted">
                    {index + 1}
                  </Text>
                )}
              </View>
              <View style={styles.copy}>
                <View style={styles.nameRow}>
                  <Text variant="label">{row.memberName}</Text>
                  {row.isHero ? (
                    <View style={styles.heroTag}>
                      <Icon name={icon.star} size={11} color={colors.hero} />
                      <Text variant="caption" tone="hero">
                        Hero
                      </Text>
                    </View>
                  ) : null}
                </View>
                <Text variant="caption" tone="muted">
                  {row.repaymentSpeedHours === null
                    ? row.frontedMinor > 0
                      ? 'Fronted the bill'
                      : 'No repayments yet'
                    : `Repays others in ~${Math.round(row.repaymentSpeedHours)}h`}
                </Text>
              </View>
              <View style={styles.right}>
                {row.frontedMinor > 0 ? (
                  <Text variant="mono">{money.format(row.frontedMinor, currency)}</Text>
                ) : (
                  <Text variant="mono" tone="muted">
                    —
                  </Text>
                )}
                <View style={styles.globie}>
                  <Icon name={icon.sparkles} size={11} color={colors.accent} />
                  <Text variant="caption" tone="accent">
                    {row.globieBalance}
                  </Text>
                  <Text variant="caption" tone="muted">
                    Globie
                  </Text>
                </View>
              </View>
            </Card>
          ))}
        </View>
      )}

      <Text variant="caption" tone="muted">
        Globie points are a non-transferable engagement reward with no cash value and no
        redemption guarantee.
      </Text>
    </Screen>
  );
}

const styles = StyleSheet.create({
  header: { gap: space.sm },
  halo: {
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.heroWash,
    borderWidth: 1,
    borderColor: 'rgba(243, 199, 79, 0.32)',
    marginBottom: space.xs,
  },
  list: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  // the signature object: a rank chip that turns gold for the member who fronted the most
  rank: {
    width: 32,
    height: 32,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  heroRank: { backgroundColor: colors.hero, borderColor: colors.hero },
  copy: { flex: 1, gap: 2 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  heroTag: { flexDirection: 'row', alignItems: 'center', gap: 3 },
  right: { alignItems: 'flex-end', gap: 2 },
  globie: { flexDirection: 'row', alignItems: 'center', gap: 3 },
});
