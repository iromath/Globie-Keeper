import { useState } from 'react';
import {
    ActivityIndicator,
    Pressable,
    StyleSheet,
    type GestureResponderEvent,
    type PressableProps,
    type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { haptics } from './haptics';
import { Icon, type IconName } from './icon';
import { Text } from './text';
import { colors, motion, radius, shadow, space } from './theme';

/* A Reanimated shared value is mutable by contract — the press handlers below write
   to `.value` to drive the spring. The React Compiler's immutability rule cannot see
   that intent, so it is off for this file rather than silenced line by line. */
/* eslint-disable react-hooks/immutability */

type Props = Omit<PressableProps, 'children'> & {
  title: string;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'paypal';
  loading?: boolean;
  compact?: boolean;
  icon?: IconName;
  /** Where the icon sits relative to the label. */
  iconSide?: 'left' | 'right';
  style?: ViewStyle;
};

export function Button({
  title,
  variant = 'primary',
  loading = false,
  compact = false,
  icon: iconName,
  iconSide = 'left',
  disabled,
  style,
  onPress,
  onPressIn,
  onPressOut,
  ...rest
}: Props) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isDisabled = disabled || loading;
  const spinnerColor = spinnerColors[variant];

  // A press answers with a spring, not a colour change: the control leans in and
  // springs back. One shared value drives the whole shell, so the label, the icon
  // and the spinner all move together.
  const scale = useSharedValue(1);
  const shell = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const labelTone = labelTones[variant];
  const glyph = iconName ? (
    <Icon
      name={iconName}
      size={compact ? 15 : 17}
      color={iconColors[variant]}
    />
  ) : null;

  function press(event: GestureResponderEvent) {
    if (isDisabled) return;
    haptics.tap();
    onPress?.(event);
  }

  return (
    <Animated.View style={[styles.shell, shell, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        // react-native-web 0.21 dropped `accessibilityState`; `disabled` plus the
        // `aria-*` props are what actually reach the DOM.
        aria-busy={loading}
        disabled={isDisabled}
        hitSlop={compact ? space.xs : undefined}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={press}
        onPressIn={(event) => {
          if (!isDisabled) scale.value = withSpring(0.97, motion.spring);
          onPressIn?.(event);
        }}
        onPressOut={(event) => {
          scale.value = withSpring(1, motion.spring);
          onPressOut?.(event);
        }}
        style={[
          styles.base,
          compact && styles.compact,
          variantStyles[variant],
          hovered && !isDisabled && hoverStyles[variant],
          focused && styles.focused,
          isDisabled && styles.disabled,
        ]}
        {...rest}
      >
        {loading ? (
          <ActivityIndicator size="small" color={spinnerColor} style={styles.spinner} />
        ) : iconSide === 'left' ? (
          glyph
        ) : null}
        <Text variant="label" tone={labelTone}>
          {title}
        </Text>
        {!loading && iconSide === 'right' ? glyph : null}
      </Pressable>
    </Animated.View>
  );
}

type IconButtonProps = Omit<PressableProps, 'children'> & {
  name: IconName;
  label: string;
  tone?: 'default' | 'accent' | 'muted' | 'danger';
  size?: number;
  loading?: boolean;
  style?: ViewStyle;
};

/** A single glyph in a touch target: header actions, close buttons, quick actions. */
export function IconButton({
  name,
  label,
  tone = 'default',
  size = 20,
  loading = false,
  disabled,
  style,
  onPress,
  ...rest
}: IconButtonProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const isDisabled = disabled || loading;
  const scale = useSharedValue(1);
  const shell = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  return (
    <Animated.View style={[shell, style]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        aria-busy={loading}
        disabled={isDisabled}
        onHoverIn={() => setHovered(true)}
        onHoverOut={() => setHovered(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onPress={(event) => {
          if (isDisabled) return;
          haptics.tap();
          onPress?.(event);
        }}
        onPressIn={() => {
          if (!isDisabled) scale.value = withSpring(0.9, motion.spring);
        }}
        onPressOut={() => {
          scale.value = withSpring(1, motion.spring);
        }}
        style={[
          styles.iconBase,
          hovered && !isDisabled && styles.iconHovered,
          focused && styles.focused,
          isDisabled && styles.disabled,
        ]}
        {...rest}
      >
        {loading ? (
          <ActivityIndicator size="small" color={iconColors[tone === 'danger' ? 'danger' : 'secondary']} />
        ) : (
          <Icon name={name} size={size} color={iconColors[tone]} />
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  shell: { borderRadius: radius.pill },
  base: {
    minHeight: 50,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
  },
  compact: { minHeight: 38, paddingHorizontal: space.lg, gap: space.xs },
  spinner: { marginLeft: -2 },
  focused: { outlineWidth: 2, outlineColor: colors.focus, outlineOffset: 2 },
  disabled: { opacity: 0.4 },
  iconBase: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  iconHovered: { backgroundColor: colors.surfaceHi },
});

const variantStyles: Record<NonNullable<Props['variant']>, ViewStyle> = {
  primary: { backgroundColor: colors.accent, ...shadow.glow },
  secondary: {
    backgroundColor: colors.surfaceAlt,
    borderWidth: 1,
    borderColor: colors.borderStrong,
  },
  ghost: { backgroundColor: 'transparent' },
  danger: { backgroundColor: colors.dangerWash, borderWidth: 1, borderColor: colors.danger },
  // the official gold, so the identity button is recognisable before it is read (§2.17)
  paypal: { backgroundColor: colors.paypal },
};

const hoverStyles: Record<NonNullable<Props['variant']>, ViewStyle> = {
  primary: { backgroundColor: colors.accentHover },
  secondary: { backgroundColor: colors.surfaceHi },
  ghost: { backgroundColor: colors.wash },
  danger: { backgroundColor: 'rgba(255, 107, 107, 0.2)' },
  paypal: { backgroundColor: '#FFD166' },
};

const spinnerColors: Record<NonNullable<Props['variant']>, string> = {
  primary: colors.accentInk,
  secondary: colors.text,
  ghost: colors.accent,
  danger: colors.danger,
  paypal: colors.paypalInk,
};

const labelTones = {
  primary: 'ink',
  secondary: 'default',
  ghost: 'accent',
  danger: 'danger',
  paypal: 'ink',
} as const;

const iconColors = {
  primary: colors.accentInk,
  secondary: colors.text,
  ghost: colors.accent,
  danger: colors.danger,
  paypal: colors.paypalInk,
  default: colors.text,
  accent: colors.accent,
  muted: colors.muted,
} as const;
