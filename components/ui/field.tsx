import { useState } from 'react';
import { StyleSheet, TextInput, View, type TextInputProps } from 'react-native';

import { Text } from './text';
import { colors, font, radius, space } from './theme';

type Props = TextInputProps & {
  label: string;
  hint?: string;
  error?: string;
};

export function Field({ label, hint, error, style, onFocus, onBlur, ...rest }: Props) {
  const [focused, setFocused] = useState(false);

  return (
    <View style={styles.wrapper}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <TextInput
        accessibilityLabel={error ? `${label}, error` : label}
        placeholderTextColor={colors.mutedDim}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[styles.input, focused && styles.focused, !!error && styles.invalid, style]}
        {...rest}
      />
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: space.xs },
  input: {
    minHeight: 44,
    borderRadius: radius.sm,
    // the rim clears 3:1 on both the ground and the nested surface; the fill alone would not
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
    color: colors.text,
    paddingHorizontal: space.md,
    fontSize: font.body,
    lineHeight: 25,
    // reserved at rest so focus never shifts the layout
    outlineWidth: 2,
    outlineColor: 'transparent',
    outlineOffset: 2,
  },
  focused: {
    borderColor: colors.focus,
    backgroundColor: colors.surfaceHi,
    outlineColor: colors.focus,
  },
  invalid: { borderColor: colors.danger, backgroundColor: colors.dangerWash },
});
