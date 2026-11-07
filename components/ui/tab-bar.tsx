/* A Reanimated shared value is mutable by contract — the press handlers below write
   to `.value` to drive the spring. The React Compiler's immutability rule cannot see
   that intent, so it is off for this file rather than silenced line by line. */
/* eslint-disable react-hooks/immutability */
import { useRouter, type Href } from 'expo-router';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useActivitySeenAt } from '@/lib/activity-seen';
import { useMyActivity } from '@/lib/queries';

import { haptics } from './haptics';
import { Icon, icon, type IconName } from './icon';
import { Text } from './text';
import { colors, maxContentWidth, motion, radius, space } from './theme';

export type TabName = 'index' | 'groups' | 'me/shares' | 'me/activity';

type Destination = { label: string; glyph: IconName; glyphActive: IconName };

/** Four destinations, one meaning each — the bar never grows by accident. */
const destinations: Record<TabName, Destination> = {
  index: { label: 'Home', glyph: icon.homeOutline, glyphActive: icon.home },
  groups: { label: 'Groups', glyph: icon.peopleOutline, glyphActive: icon.people },
  'me/shares': { label: 'Shares', glyph: icon.sharesOutline, glyphActive: icon.shares },
  'me/activity': { label: 'Activity', glyph: icon.activityOutline, glyphActive: icon.activity },
};

/** The order the four places appear in, left to right. */
const order: TabName[] = ['index', 'groups', 'me/shares', 'me/activity'];

const hrefs: Record<TabName, Href> = {
  index: '/',
  groups: '/groups',
  'me/shares': '/me/shares',
  'me/activity': '/me/activity',
};

/**
 * Which destination a route belongs to. A detail page keeps its section lit —
 * a bill is still Groups — while a page that belongs to no tab (Settings, the
 * scanner) leaves the bar with nothing highlighted.
 */
export function tabFor(pathname: string): TabName | null {
  if (pathname === '/' || pathname === '') return 'index';
  if (pathname.startsWith('/groups')) return 'groups';
  if (pathname.startsWith('/me/shares')) return 'me/shares';
  if (pathname.startsWith('/me/activity')) return 'me/activity';
  return null;
}

/**
 * The bottom bar. It belongs to the shell rather than to the tabs navigator, so
 * it stays put when a bill or the Hero board is pushed on top of a tab — the
 * four places are always one tap away. The focused capsule is the state; the
 * icon swap (outline to filled) carries the same message without colour, so the
 * bar still reads in greyscale.
 */
export function AppNavBar({ active }: { active: TabName | null }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const activity = useMyActivity();
  const seenAt = useActivitySeenAt();

  const newest = activity.data?.events[0]?.at;
  const unread = Boolean(newest && (!seenAt || newest > seenAt));

  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {/* The bar spans the window; the destinations stay in the content column. */}
      <View style={styles.row}>
        {order.map((name) => (
          <TabItem
            key={name}
            destination={destinations[name]}
            focused={active === name}
            unread={name === 'me/activity' && unread}
            onPress={() => {
              haptics.select();
              router.navigate(hrefs[name]);
            }}
          />
        ))}
      </View>
    </View>
  );
}

function TabItem({
  destination,
  focused,
  unread,
  onPress,
}: {
  destination: Destination;
  focused: boolean;
  unread: boolean;
  onPress: () => void;
}) {
  const lift = useSharedValue(focused ? 1 : 0);
  const press = useSharedValue(1);

  useEffect(() => {
    lift.value = withSpring(focused ? 1 : 0, motion.spring);
  }, [focused, lift]);

  const capsule = useAnimatedStyle(() => ({
    opacity: lift.value,
    transform: [{ scale: 0.86 + lift.value * 0.14 }],
  }));
  const shell = useAnimatedStyle(() => ({ transform: [{ scale: press.value }] }));

  const tint = focused ? colors.accent : colors.mutedDim;

  return (
    <Animated.View style={[styles.itemShell, shell]}>
      <Pressable
        accessibilityRole="tab"
        // react-native-web 0.21 no longer reads `accessibilityState`; only the
        // `aria-*` form reaches the DOM, and it maps back to the native state.
        aria-selected={focused}
        accessibilityLabel={destination.label}
        onPress={onPress}
        onPressIn={() => {
          press.value = withSpring(focused ? 1 : 0.92, motion.spring);
        }}
        onPressOut={() => {
          press.value = withSpring(1, motion.spring);
        }}
        style={styles.item}
      >
        <View style={styles.glyphSlot}>
          <Animated.View pointerEvents="none" style={[styles.capsule, capsule]} />
          <Icon name={focused ? destination.glyphActive : destination.glyph} size={22} color={tint} />
          {/* The dot is the only unread signal the bar carries: it disappears the
              moment Activity is opened, so nothing has to be dismissed. */}
          {unread && !focused ? <View style={styles.dot} /> : null}
        </View>
        <Text variant="caption" style={[styles.label, { color: tint, fontWeight: focused ? '600' : '500' }]}>
          {destination.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  bar: {
    backgroundColor: colors.glass,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.hairline,
    ...Platform.select({ web: { backdropFilter: 'blur(18px)' }, default: {} }),
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    alignSelf: 'center',
    width: '100%',
    maxWidth: maxContentWidth,
    paddingTop: space.sm,
    paddingHorizontal: space.sm,
  },
  itemShell: { flex: 1 },
  item: { alignItems: 'center', gap: 3, paddingVertical: 2 },
  glyphSlot: { width: 62, height: 32, alignItems: 'center', justifyContent: 'center' },
  dot: {
    position: 'absolute',
    top: 3,
    right: 15,
    width: 7,
    height: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  capsule: {
    position: 'absolute',
    width: 62,
    height: 32,
    borderRadius: radius.pill,
    backgroundColor: colors.wash,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.22)',
  },
  label: { fontSize: 11, lineHeight: 14 },
});
