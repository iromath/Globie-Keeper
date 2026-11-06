import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { Icon, type IconName } from './icon';
import { BabyKaeNa } from './mascot';
import { Text } from './text';
import { colors, radius, space } from './theme';
import { enter } from './transitions';

type Props = {
  icon: IconName;
  title: string;
  body?: string;
  /** The one thing to do next, if there is one. */
  action?: ReactNode;
};

/** What a region says when it has nothing to show: a face, a reason, a way out. */
export function EmptyState({ icon, title, body, action }: Props) {
  return (
    <Animated.View entering={enter.card} style={styles.wrap}>
      <View style={styles.face}>
        <BabyKaeNa size={80} variant="face" label={null} />
        <View style={styles.badge}>
          <Icon name={icon} size={14} color={colors.accent} />
        </View>
      </View>
      <Text variant="title" style={styles.centered}>
        {title}
      </Text>
      {body ? (
        <Text variant="body" tone="muted" style={styles.centered}>
          {body}
        </Text>
      ) : null}
      {action ? <View style={styles.action}>{action}</View> : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.xl,
    paddingHorizontal: space.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
    backgroundColor: 'rgba(24, 32, 44, 0.5)',
  },
  face: {
    width: 88,
    height: 88,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: space.xs,
  },
  // the icon still names the state; it rides the mascot like a status pin
  badge: {
    position: 'absolute',
    right: 0,
    bottom: 4,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceHi,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.34)',
  },
  centered: { textAlign: 'center' },
  action: { marginTop: space.sm },
});
