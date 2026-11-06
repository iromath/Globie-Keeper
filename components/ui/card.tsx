import type { ReactNode } from 'react';
import { StyleSheet, type ViewStyle } from 'react-native';
import Animated from 'react-native-reanimated';

import { colors, radius, shadow, space } from './theme';
import { stagger } from './transitions';

type Props = {
  children: ReactNode;
  style?: ViewStyle;
  tone?: 'surface' | 'alt' | 'accent' | 'plain';
  /**
   * Position in its group. Cards rise into place on mount, offset by index so a
   * screen fills top-to-bottom instead of snapping in all at once. Pass `false`
   * to opt a card out (anything that re-mounts often, like a chat bubble).
   */
  enter?: number | false;
};

export function Card({ children, style, tone = 'surface', enter = 0 }: Props) {
  return (
    <Animated.View
      entering={enter === false ? undefined : stagger(enter)}
      style={[styles.card, toneStyles[tone], style]}
    >
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    padding: space.lg,
    gap: space.sm,
    ...shadow.card,
  },
});

const toneStyles: Record<NonNullable<Props['tone']>, ViewStyle> = {
  surface: { backgroundColor: colors.surface },
  // nested: no second rim, the surface steps up instead
  alt: { backgroundColor: colors.surfaceAlt, borderColor: 'transparent' },
  accent: { backgroundColor: colors.wash, borderColor: 'rgba(110, 240, 190, 0.32)' },
  plain: { backgroundColor: 'transparent', borderColor: 'transparent', shadowOpacity: 0 },
};
