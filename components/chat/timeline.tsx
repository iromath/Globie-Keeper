import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Icon, icon, type IconName } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { stagger } from '@/components/ui/transitions';
import { formatRate } from '@/lib/fx';
import { useMoney } from '@/lib/money-context';
import type { TimelineEvent } from '@/lib/types';

/** One glyph per family of event, so the shape of the feed is readable at a glance. */
function glyphFor(type: string): IconName {
  if (type.startsWith('bill.')) return icon.receipt;
  if (type.startsWith('allocation.')) return icon.people;
  if (type.startsWith('agreement.')) return icon.shield;
  if (type.startsWith('member.')) return icon.personAdd;
  if (type.startsWith('reminder.')) return icon.time;
  if (type.startsWith('globie.')) return icon.sparkles;
  if (type.startsWith('share.') || type.startsWith('payment.')) return icon.cash;
  return icon.information;
}

/** How many events stay in view before the feed asks to be expanded. */
const LATEST_COUNT = 3;

export function Timeline({ events, currency }: { events: TimelineEvent[]; currency: string }) {
  const money = useMoney();
  const [expanded, setExpanded] = useState(false);

  if (events.length === 0) {
    return (
      <Text variant="body" tone="muted">
        No activity yet. Create the agreement and the group chat starts here.
      </Text>
    );
  }

  const collapsible = events.length > LATEST_COUNT;
  // Collapsed means the newest few, so the feed still answers "what just happened".
  const visible = collapsible && !expanded ? events.slice(-LATEST_COUNT) : events;

  return (
    <View style={styles.list}>
      {collapsible ? (
        <View style={styles.toggleRow}>
          <Button
            variant="secondary"
            compact
            icon={expanded ? icon.chevronUp : icon.chevronDown}
            iconSide="right"
            aria-expanded={expanded}
            title={expanded ? `Show latest ${LATEST_COUNT}` : `Show all ${events.length} events`}
            onPress={() => setExpanded((open) => !open)}
          />
        </View>
      ) : null}
      {visible.map((event, index) => {
        const system = event.type.startsWith('system.');

        if (system) {
          return (
            <Animated.View key={event.id} entering={stagger(index, 35)} style={styles.systemRow}>
              <View style={styles.systemChip}>
                <Icon name={glyphFor(event.type)} size={13} color={colors.mutedDim} />
                <Text variant="caption" tone="dim">
                  {event.actor} · {event.summary}
                </Text>
              </View>
            </Animated.View>
          );
        }

        return (
          <Animated.View key={event.id} entering={stagger(index, 35)} style={styles.row}>
            {event.type.startsWith('globie.') ? (
              <BabyKaeNa size={30} variant="badge" sparkles={false} label={null} />
            ) : (
              <Avatar name={event.actor} />
            )}
            <View style={styles.bubble}>
              <View style={styles.bubbleHeader}>
                <View style={styles.actor}>
                  {event.type.startsWith('globie.') ? (
                    <BabyKaeNa size={18} variant="badge" sparkles={false} label={null} />
                  ) : (
                    <Icon name={glyphFor(event.type)} size={13} color={colors.mutedDim} />
                  )}
                  <Text variant="label">{event.actor}</Text>
                </View>
                <Text variant="caption" tone="dim">
                  {new Date(event.at).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </Text>
              </View>
              <Text variant="body">{event.summary}</Text>
              {typeof event.amountMinor === 'number' ? (
                <Text variant="mono" tone="accent">
                  {money.format(event.amountMinor, currency)}
                </Text>
              ) : null}
              {event.settledRate ? (
                <Text variant="caption" tone="dim">
                  PayPal converted at 1 {event.settledRate.fromCurrency} ={' '}
                  {formatRate(event.settledRate.rate)} {event.settledRate.toCurrency}
                </Text>
              ) : null}
            </View>
          </Animated.View>
        );
      })}
    </View>
  );
}

function Avatar({ name }: { name: string }) {
  const initials = name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join('');
  return (
    <View style={styles.avatar}>
      <Text variant="caption" tone="accent">
        {initials || '?'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.md },
  toggleRow: { alignItems: 'center' },
  row: { flexDirection: 'row', gap: space.sm, alignItems: 'flex-start' },
  systemRow: { alignItems: 'center' },
  systemChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    backgroundColor: colors.wash,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.24)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  bubble: {
    flex: 1,
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderTopLeftRadius: radius.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  bubbleHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  actor: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
});
