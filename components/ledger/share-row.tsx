import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Icon, icon, type IconName } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { useMoney } from '@/lib/money-context';
import type { Share } from '@/lib/types';

const statusCopy: Record<Share['status'], string> = {
  proposed: 'Waiting on you',
  requested: 'Payment requested',
  paid: 'Paid',
  settled: 'Settled',
  disputed: 'Disputed',
  failed: 'Failed',
  refunded: 'Refunded',
};

const statusTone: Record<Share['status'], 'muted' | 'accent' | 'danger'> = {
  proposed: 'muted',
  requested: 'muted',
  paid: 'accent',
  settled: 'accent',
  disputed: 'danger',
  failed: 'danger',
  refunded: 'muted',
};

/** One glyph per state, so a share is readable before the words are. */
const statusGlyph: Record<Share['status'], IconName> = {
  proposed: icon.time,
  requested: icon.send,
  paid: icon.checkCircle,
  settled: icon.checkCircle,
  disputed: icon.alert,
  failed: icon.alert,
  refunded: icon.refresh,
};

export function ShareRow({
  share,
  onPress,
  onPay,
  paying = false,
}: {
  share: Share;
  onPress?: () => void;
  onPay?: () => void;
  paying?: boolean;
}) {
  const settled = share.status === 'paid' || share.status === 'settled';
  const tone = statusTone[share.status];
  const tint = tone === 'accent' ? colors.accent : tone === 'danger' ? colors.danger : colors.mutedDim;
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const money = useMoney();
  // A share is what the member will be charged, so the canonical amount keeps
  // its place under the conversion (§2.19).
  const approx = money.approximate(share.amountMinor, share.currency);

  const copy = (
    <View style={styles.copy}>
      <View style={styles.line}>
        <View style={[styles.disc, tone === 'danger' && styles.discDanger]}>
          <Icon name={statusGlyph[share.status]} size={15} color={tint} />
        </View>
        <Text variant="label" style={styles.flex} numberOfLines={1}>
          {share.groupName ?? 'Group'}
        </Text>
        {onPress ? <Icon name={icon.chevronRight} size={15} color={colors.mutedDim} /> : null}
      </View>
      <Text variant="caption" tone={tone}>
        {statusCopy[share.status]}
        {share.dueAt ? `, due ${new Date(share.dueAt).toLocaleDateString()}` : ''}
      </Text>
    </View>
  );

  return (
    <View style={styles.row}>
      {onPress ? (
        // one interactive surface per row: the copy navigates, the Pay button pays
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${share.groupName ?? 'group'}`}
          onPress={onPress}
          onHoverIn={() => setHovered(true)}
          onHoverOut={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          style={({ pressed }) => [
            styles.hit,
            hovered && styles.hitHovered,
            pressed && styles.hitPressed,
            focused && styles.hitFocused,
          ]}
        >
          {copy}
        </Pressable>
      ) : (
        <View style={styles.hit}>{copy}</View>
      )}

      <View style={styles.amount}>
        <Text variant="mono" tone={settled ? 'accent' : 'default'}>
          {money.format(share.amountMinor, share.currency)}
        </Text>
        {approx ? (
          <Text variant="caption" tone="dim" style={styles.amountNote}>
            {money.formatOriginal(share.amountMinor, share.currency)}
          </Text>
        ) : null}
      </View>
      {onPay ? (
        <Button
          title="Pay"
          compact
          icon={icon.card}
          loading={paying}
          disabled={settled}
          onPress={onPay}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.xs,
    paddingHorizontal: space.xs,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  hit: {
    flex: 1,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.md,
  },
  hitHovered: { backgroundColor: colors.surfaceHi },
  hitPressed: { backgroundColor: colors.surface },
  hitFocused: { outlineWidth: 2, outlineColor: colors.focus, outlineOffset: 1 },
  copy: { gap: space.xs },
  amount: { alignItems: 'flex-end' },
  amountNote: { textAlign: 'right' },
  line: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  disc: {
    width: 26,
    height: 26,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  discDanger: { backgroundColor: colors.dangerWash, borderColor: 'rgba(255, 107, 107, 0.3)' },
});
