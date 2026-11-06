import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';

import { Icon, type IconName } from './icon';
import { Text } from './text';
import { colors, radius, space } from './theme';

type Props = {
  glyph: IconName;
  title: string;
  hint?: string;
  /** A trailing control, e.g. a "See all" link. */
  action?: ReactNode;
};

/**
 * The head of a region inside a screen. A glyph in a disc leads it so a section
 * is scannable without reading: the same shape always means the same thing.
 */
export function SectionHeading({ glyph, title, hint, action }: Props) {
  return (
    <View style={styles.row}>
      <View style={styles.disc}>
        <Icon name={glyph} size={16} color={colors.accent} />
      </View>
      <View style={styles.copy}>
        <Text variant="title">{title}</Text>
        {hint ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>
      {action}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    marginBottom: space.xs,
  },
  disc: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surfaceAlt,
  },
  copy: { flex: 1, gap: 1 },
});
