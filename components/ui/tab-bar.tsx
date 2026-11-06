/* A Reanimated shared value is mutable by contract — the press handlers below write
   to `.value` to drive the spring. The React Compiler's immutability rule cannot see
   that intent, so it is off for this file rather than silenced line by line. */
/* eslint-disable react-hooks/immutability */
import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { useEffect } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import Animated, {
    useAnimatedStyle,
    useSharedValue,
    withSpring,
} from 'react-native-reanimated';

import { haptics } from './haptics';
import { Icon, icon, type IconName } from './icon';
import { Text } from './text';
import { colors, maxContentWidth, motion, radius, space } from './theme';

type Destination = { label: string; glyph: IconName; glyphActive: IconName };

/** Three destinations, one meaning each — the bar never grows a fourth by accident. */
const destinations: Record<string, Destination> = {
  index: { label: 'Home', glyph: icon.homeOutline, glyphActive: icon.home },
  'me/shares': { label: 'Shares', glyph: icon.sharesOutline, glyphActive: icon.shares },
  'me/activity': { label: 'Activity', glyph: icon.activityOutline, glyphActive: icon.activity },
};

/**
 * The bottom bar. The focused capsule is the state; the icon swap (outline to
 * filled) carries the same message without colour, so the bar still reads in
 * greyscale. Navigation goes through `navigateToTab` — this navigator hands the
 * bar a route key rather than a navigation object.
 */
export function AppTabBar({ state, descriptors, navigateToTab, insets, badges }: BottomTabBarProps & { badges?: Record<string, boolean> }) {
  return (
    <View style={[styles.bar, { paddingBottom: Math.max(insets.bottom, space.sm) }]}>
      {/* The bar spans the window; the destinations stay in the content column. */}
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const destination =
            destinations[route.name] ??
            ({
              label: String(descriptors[route.key]?.options?.title ?? route.name),
              glyph: icon.homeOutline,
              glyphActive: icon.home,
            } satisfies Destination);

          return (
            <TabItem
              key={route.key}
              destination={destination}
              focused={state.index === index}
              unread={badges?.[route.name] ?? false}
              onPress={() => {
                haptics.select();
                navigateToTab(route.key);
              }}
            />
          );
        })}
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
