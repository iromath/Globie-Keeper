import { useRouter } from 'expo-router';
import type { ReactNode } from 'react';
import { Platform, StyleSheet, View, type ViewStyle } from 'react-native';
import Animated, {
    Extrapolation,
    interpolate,
    useAnimatedScrollHandler,
    useAnimatedStyle,
    useSharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { IconButton } from './button';
import { icon } from './icon';
import { Text } from './text';
import { colors, maxContentWidth, space } from './theme';
import { enter } from './transitions';

type Header = {
  /** The large title, in the same column as the content: how iOS leads a screen. */
  title: string;
  subtitle?: string;
  /** A control that rides beside the large title — a sign-out, a filter. */
  action?: ReactNode;
  /**
   * A pushed screen carries its own way back: the shell draws no stack header,
   * so every screen leads with one title and one back affordance.
   */
  back?: boolean;
  /** Where back goes when popping the stack is not the right exit — a callback page. */
  onBack?: () => void;
};

type Props = {
  children: ReactNode;
  scroll?: boolean;
  padded?: boolean;
  style?: ViewStyle;
  bottomInset?: number;
  header?: Header;
  /** Refreshes the scroll surface, e.g. pull-to-refresh. */
  refreshControl?: React.ReactElement;
};

/**
 * The one scroll surface. A `header` renders as a large title inside the column;
 * once it scrolls away a compact title fades in over the content, so the screen
 * always names itself. The compact bar is inert on purpose — actions live in the
 * large title, where they are reachable before anything moves.
 */
export function Screen({
  children,
  scroll = true,
  padded = true,
  style,
  bottomInset = 0,
  header,
  refreshControl,
}: Props) {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const scrollY = useSharedValue(0);

  const onScroll = useAnimatedScrollHandler((event) => {
    scrollY.value = event.contentOffset.y;
  });

  const barStyle = useAnimatedStyle(() => ({
    opacity: interpolate(scrollY.value, [8, 52], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateY: interpolate(scrollY.value, [8, 52], [-10, 0], Extrapolation.CLAMP) },
    ],
  }));

  const content = (
    <>
      {header ? (
        <Animated.View entering={enter.card} style={styles.titleBlock}>
          {/* The way back sits on its own row, so the large title keeps the same
              left edge as every card under it — the column never shifts. */}
          {header.back ? (
            <IconButton
              name={icon.chevronBack}
              label="Back"
              onPress={header.onBack ?? (() => router.back())}
              style={styles.back}
            />
          ) : null}
          <View style={styles.titleRow}>
            <View style={styles.titleCopy}>
              <Text variant="display">{header.title}</Text>
              {header.subtitle ? (
                <Text variant="body" tone="muted">
                  {header.subtitle}
                </Text>
              ) : null}
            </View>
            {header.action}
          </View>
        </Animated.View>
      ) : null}
      {children}
    </>
  );

  // The shell draws no stack header, so the status bar's height is ours to keep
  // clear. A browser has no status bar and keeps its own, taller gutter.
  const top = (Platform.OS === 'web' ? space.xxl : space.lg) + insets.top;

  const column = (
    <View
      style={[
        styles.content,
        padded && styles.padded,
        padded && { paddingTop: top },
        { paddingBottom: insets.bottom + space.xl + bottomInset },
        style,
      ]}
    >
      {content}
    </View>
  );

  return (
    <View style={styles.root}>
      <Animated.ScrollView
        style={styles.fill}
        contentContainerStyle={styles.grow}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        scrollEnabled={scroll}
        onScroll={onScroll}
        scrollEventThrottle={16}
        refreshControl={refreshControl}
      >
        {column}
      </Animated.ScrollView>

      {header && scroll ? (
        <Animated.View
          pointerEvents="none"
          style={[styles.bar, { height: 46 + insets.top, paddingTop: insets.top }, barStyle]}
        >
          <Text variant="label" numberOfLines={1} style={styles.barTitle}>
            {header.title}
          </Text>
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  fill: { flex: 1 },
  grow: { flexGrow: 1, alignItems: 'center' },
  // one capped, centred container: a desktop measure in a browser, the full width of a phone
  content: {
    flexGrow: 1,
    gap: space.lg,
    width: '100%',
    maxWidth: maxContentWidth,
    alignSelf: 'center',
  },
  // A browser has no status bar above the content, so the web keeps its own gutter.
  padded: {
    paddingHorizontal: Platform.OS === 'web' ? space.xl : space.lg,
  },
  titleBlock: { gap: space.xs, paddingTop: space.sm, paddingBottom: space.xs },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: space.md,
  },
  titleCopy: { flex: 1, gap: space.xs },
  back: { alignSelf: 'flex-start', marginLeft: -space.sm },
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 46,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.glass,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.hairline,
  },
  barTitle: { maxWidth: maxContentWidth - space.xl * 2 },
});
