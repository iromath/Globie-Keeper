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
  failed: 'Didn\u2019t go through, nothing was charged',
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
  payTitle,
}: {
  share: Share;
  onPress?: () => void;
  onPay?: () => void;
  paying?: boolean;
  /** Overrides the default label, e.g. "Open link" before a PayPal.Me transfer. */
  payTitle?: string;
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
  // Optional fee coverage (§2.20): the order asks for a grossed-up amount, so
  // the breakdown has to be visible before the member taps Pay.
  const feeMinor = share.feeMinor ?? 0;
  const grossMinor = share.grossMinor ?? null;
  const covered = feeMinor > 0 && grossMinor !== null && grossMinor > share.amountMinor;

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
        {share.status === 'requested' && share.paymentMode === 'paypal_me'
          ? 'PayPal.Me link sent — tap “I’ve paid” after sending'
          : share.status === 'requested' && share.canFinish
            ? 'Approved — finish the payment'
            : /* No checkout exists yet, so there is nothing to tap: say whose
                 move it is instead of leaving the row without an explanation. */
              share.status === 'proposed' && !onPay
              ? `Waiting for ${share.fronterName ?? 'the person who fronted this bill'} to request payment`
              : share.status === 'failed' && !onPay
                ? 'Waiting for a new request from the person who fronted this bill'
                : statusCopy[share.status]}
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
        {covered ? (
          <>
            <Text variant="caption" tone="dim" style={styles.amountNote}>
              + {money.format(feeMinor, share.currency)} covers the PayPal fee
            </Text>
            <Text variant="caption" tone="muted" style={styles.amountNote}>
              {money.format(grossMinor, share.currency)} at PayPal
            </Text>
          </>
        ) : null}
      </View>
      {onPay ? (
        <Button
          title={
            payTitle ??
            (share.paymentMode === 'paypal_me' && !settled
              ? 'I’ve paid'
              : share.canFinish
                ? 'Finish payment'
                : 'Pay')
          }
          compact
          icon={share.paymentMode === 'paypal_me' ? icon.link : icon.card}
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
