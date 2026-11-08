import { router, useFocusEffect } from 'expo-router';
import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Button, IconButton } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, icon, type IconName } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { stagger } from '@/components/ui/transitions';
import { markActivitySeen } from '@/lib/activity-seen';
import { useMoney } from '@/lib/money-context';
import { useMyActivity } from '@/lib/queries';
import type { TimelineEvent } from '@/lib/types';

/** One glyph per kind of event, so a glance down the feed reads as a shape. */
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

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const minutes = Math.round((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function dayLabel(iso: string): string {
  const day = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(day, today)) return 'Today';
  if (sameDay(day, yesterday)) return 'Yesterday';
  return day.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

export default function ActivityScreen() {
  const activity = useMyActivity();
  const events = useMemo(() => activity.data?.events ?? [], [activity.data?.events]);

  // Opening the feed is what "seen" means: the tab dot clears and does not come
  // back until something newer lands.
  useFocusEffect(
    useCallback(() => {
      const newest = activity.data?.events[0]?.at;
      if (newest) void markActivitySeen(newest);
    }, [activity.data?.events])
  );

  // Newest first from the API; the feed reads top-down, so keep that order.
  const groups = useMemo(() => {
    const buckets: { label: string; items: TimelineEvent[] }[] = [];
    for (const event of events) {
      const label = dayLabel(event.at);
      const last = buckets[buckets.length - 1];
      if (last && last.label === label) last.items.push(event);
      else buckets.push({ label, items: [event] });
    }
    return buckets;
  }, [events]);

  return (
    <Screen
      header={{
        title: 'Activity',
        subtitle: 'Every move across your groups.',
        action: (
          <IconButton
            name={icon.settingsOutline}
            label="Settings"
            tone="muted"
            onPress={() => router.push('/settings')}
          />
        ),
      }}
      bottomInset={space.xl}
    >
      {activity.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={64} />
          <Skeleton height={64} />
          <Skeleton height={64} />
        </View>
      ) : activity.error ? (
        <Card>
          <Text variant="title">Could not load your activity</Text>
          <Text variant="body" tone="muted">
            {activity.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => activity.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : groups.length === 0 ? (
        <EmptyState
          icon={icon.activity}
          title="Nothing has happened yet"
          body="Start a group, accept an agreement, or upload a receipt and the story shows up here."
        />
      ) : (
        groups.map((group) => (
          <View key={group.label} style={styles.section}>
            <Text variant="label" tone="dim" style={styles.dayLabel}>
              {group.label}
            </Text>
            <Card style={styles.feed}>
              {group.items.map((event, index) => (
                <EventRow key={event.id} event={event} index={index} first={index === 0} />
              ))}
            </Card>
          </View>
        ))
      )}
    </Screen>
  );
}

function EventRow({ event, index, first }: { event: TimelineEvent; index: number; first: boolean }) {
  const money = useMoney();

  return (
    <Animated.View entering={stagger(index, 40)} style={[styles.row, !first && styles.rowDivider]}>
      <Pressable
        accessibilityRole={event.groupId ? 'button' : undefined}
        accessibilityLabel={event.groupId ? `Open ${event.groupName ?? 'group'}` : undefined}
        disabled={!event.groupId}
        onPress={() =>
          event.groupId &&
          router.push({ pathname: '/groups/[id]', params: { id: event.groupId } })
        }
        style={({ pressed }) => [styles.hit, pressed && styles.hitPressed]}
      >
        <View style={styles.glyph}>
          {event.type.startsWith('globie.') ? (
            <BabyKaeNa size={34} variant="badge" sparkles={false} label={null} />
          ) : (
            <Icon name={glyphFor(event.type)} size={16} color={colors.accent} />
          )}
        </View>
        <View style={styles.copy}>
          <Text variant="body" numberOfLines={2}>
            {event.summary}
          </Text>
          <Text variant="caption" tone="dim">
            {event.groupName ? `${event.groupName} · ` : ''}
            {relativeTime(event.at)}
          </Text>
        </View>
        {event.amountMinor ? (
          <Text variant="mono" tone="accent">
            {money.format(event.amountMinor, event.currency ?? 'THB')}
          </Text>
        ) : null}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  section: { gap: space.sm },
  dayLabel: { marginLeft: space.xs },
  feed: { padding: 0, paddingVertical: space.xs, gap: 0 },
  list: { gap: space.sm },
  row: { paddingHorizontal: space.sm },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  hit: { flexDirection: 'row', alignItems: 'center', gap: space.md, paddingVertical: space.md },
  hitPressed: { opacity: 0.7 },
  glyph: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  copy: { flex: 1, gap: 2 },
  inline: { alignSelf: 'flex-start' },
});
