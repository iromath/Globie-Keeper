import { Text as RNText, type TextProps as RNTextProps, type TextStyle } from 'react-native';

import { colors, font, type } from './theme';

type Variant = 'display' | 'title' | 'body' | 'label' | 'caption' | 'mono' | 'figure';

// 12 > 14 > 17 > 20 > 24, adjacent steps 1.17 / 1.21 / 1.18 / 1.2. No tracked caps anywhere.
const variants: Record<Variant, TextStyle> = {
  display: { fontSize: font.display, lineHeight: 28, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: font.title, lineHeight: 26, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: font.body, lineHeight: 25, fontWeight: '400' },
  label: { fontSize: font.label, lineHeight: 20, fontWeight: '600' },
  caption: { fontSize: font.caption, lineHeight: 18, fontWeight: '400' },
  mono: {
    fontSize: font.body,
    lineHeight: 25,
    fontFamily: type.mono,
    fontVariant: ['tabular-nums'],
  },
  figure: {
    fontSize: font.display,
    lineHeight: 28,
    fontWeight: '500',
    letterSpacing: -0.4,
    fontFamily: type.mono,
    fontVariant: ['tabular-nums'],
  },
};

type Props = RNTextProps & {
  variant?: Variant;
  tone?: 'default' | 'muted' | 'dim' | 'accent' | 'hero' | 'warn' | 'danger' | 'info' | 'ink';
};

const toneColor = {
  default: colors.text,
  muted: colors.muted,
  dim: colors.mutedDim,
  accent: colors.accentText,
  hero: colors.hero,
  warn: colors.warn,
  danger: colors.danger,
  info: colors.info,
  ink: colors.accentInk,
} as const;

export function Text({ variant = 'body', tone = 'default', style, ...rest }: Props) {
  return <RNText {...rest} style={[variants[variant], { color: toneColor[tone] }, style]} />;
}
