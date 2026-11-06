import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { haptics } from './haptics';
import { Icon } from './icon';
import { BabyKaeNa } from './mascot';
import { Text } from './text';
import { colors, motion, radius, space } from './theme';

type Props = {
  title: string;
  body?: string;
  /** The figure to celebrate, if the moment has one. */
  amount?: string;
};

const MASCOT = 124;

/**
 * The settle moment: Baby Kae Na springs in with her halo already escaping, and
 * a check badges the corner so the win still reads at a glance. One pop, one
 * haptic — a reward is a single beat, not a fireworks show.
 */
export function SuccessPulse({ title, body, amount }: Props) {
  const pop = useSharedValue(0.6);

  useEffect(() => {
    pop.value = withSpring(1, motion.bouncy);
    haptics.success();
  }, [pop]);

  const core = useAnimatedStyle(() => ({ transform: [{ scale: pop.value }] }));

  return (
    <View style={styles.wrap}>
      <View style={styles.stage}>
        <Animated.View style={core}>
          <BabyKaeNa size={MASCOT} mood="cheer" halo label={null} />
        </Animated.View>
        <Animated.View style={[styles.badge, core]}>
          <Icon name="checkmark" size={16} color={colors.accentInk} />
        </Animated.View>
      </View>
      {amount ? (
        <Text variant="figure" tone="accent">
          {amount}
        </Text>
      ) : null}
      <Text variant="title" style={styles.centered}>
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" style={styles.centered}>
          {body}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: space.sm },
  stage: {
    width: MASCOT,
    height: Math.round(MASCOT * 1.1),
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  badge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  centered: { textAlign: 'center' },
});
