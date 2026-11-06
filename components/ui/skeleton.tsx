import { useEffect } from 'react';
import { StyleSheet, type DimensionValue, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { colors, radius } from './theme';

type Props = {
  height?: number;
  width?: DimensionValue;
  style?: ViewStyle;
};

/**
 * A loading placeholder that holds the shape of the thing it stands in for.
 * It breathes rather than shimmers: a sweep needs a gradient to read as light
 * moving across a surface, and a pulse says "working" without that costume.
 */
export function Skeleton({ height = 16, width = '100%', style }: Props) {
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, { duration: 850 }), -1, true);
  }, [pulse]);

  const breathe = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <Animated.View
      accessibilityLabel="Loading"
      accessibilityRole="progressbar"
      style={[styles.block, { height, width }, breathe, style]}
    />
  );
}

const styles = StyleSheet.create({
  block: {
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.border,
  },
});
