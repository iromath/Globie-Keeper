import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { Icon, icon } from '@/components/ui/icon';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import type { MyGroup } from '@/lib/queries';

const roleCopy: Record<MyGroup['role'], string> = {
  owner: 'Owner',
  fronter: 'Fronter',
  member: 'Member',
};

/** One table in the member's own list. The whole row is the tap target. */
export function GroupRow({ group, onPress }: { group: MyGroup; onPress?: () => void }) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);

  const members = `${group.memberCount} ${group.memberCount === 1 ? 'member' : 'members'}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${group.name}`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={({ pressed }) => [
        styles.row,
        hovered && styles.hovered,
        pressed && styles.pressed,
        focused && styles.focused,
      ]}
    >
      <View style={styles.disc}>
        <Icon name={icon.people} size={16} color={colors.accent} />
      </View>
      <View style={styles.copy}>
        <Text variant="label" numberOfLines={1}>
          {group.name}
        </Text>
        <Text variant="caption" tone="muted">
          {roleCopy[group.role]} · {members} · {group.defaultCurrency}
        </Text>
      </View>
      <Icon name={icon.chevronRight} size={15} color={colors.mutedDim} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.lg,
    backgroundColor: colors.surfaceAlt,
  },
  hovered: { backgroundColor: colors.surfaceHi },
  pressed: { backgroundColor: colors.surface },
  focused: { outlineWidth: 2, outlineColor: colors.focus, outlineOffset: 1 },
  disc: {
    width: 30,
    height: 30,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  copy: { flex: 1, gap: 1 },
});
