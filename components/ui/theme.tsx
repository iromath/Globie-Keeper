/* Hallmark · shape: app screen · genre: native-dark · theme: aurora · paper: graphite ground #05070B · accent: aurora-mint 162 · display: system grotesk · body: system sans · posture: committed
 * nav: custom tab bar + collapsing large title · signature: the Hero rank chip · states: loading, empty, error, full
 * axes: graphite/system-grotesk/aurora-mint · contrast: pass · v3.0.0 */

/* Hallmark · redesign: restyle · layout and navigation rebuilt as a native shell — tab bar, large titles, spring press states, one centred column that widens on the web
 * Hallmark · answered 26a · React Native's Pressable state callback carries only `pressed`, so hover and focus are held in local state and composed into the style array
 * Hallmark · answered 26b · `CursorValue` is "auto" | "pointer" only, so Disabled is carried by opacity, the native disabled prop and accessibilityState, and a field error is a visible message with accessibilityLiveRegion plus a danger rim, because aria-invalid does not exist in RN 0.88, never colour alone */

import { Platform } from 'react-native';

/** Cool graphite ladder: five steps from the ground up, each legible against the last. */
export const colors = {
  /** The app ground — behind every screen. */
  ink: '#05070B',
  /** Cards and sheets sit one step up from the ground. */
  surface: '#111823',
  surfaceAlt: '#18202C',
  surfaceHi: '#212B3A',
  /** A translucent accent tint, for selected rows and nested accent surfaces. */
  wash: 'rgba(110, 240, 190, 0.08)',

  text: '#F1F6FA',
  muted: '#93A3B4',
  mutedDim: '#68798B',

  /** Decorative separators, and the control rim that must clear 3:1 on a nested surface. */
  hairline: 'rgba(255, 255, 255, 0.07)',
  border: '#1F2A38',
  borderStrong: '#3A4A5E',

  /** One brand colour. Aurora mint is the fill; accentText is the same hue as type. */
  accent: '#6EF0BE',
  accentHover: '#8AF6CB',
  accentDeep: '#33C795',
  accentText: '#6EF0BE',
  accentInk: '#04241A',
  focus: '#6EF0BE',

  // semantic, text-only
  hero: '#F3C74F',
  warn: '#F0A868',
  danger: '#FF6B6B',
  info: '#6FB4FF',
  dangerWash: 'rgba(255, 107, 107, 0.12)',
  warnWash: 'rgba(240, 168, 104, 0.12)',
  heroWash: 'rgba(243, 199, 79, 0.12)',

  /** PayPal's brand pair, used only by the identity button (DEV_PLAN §2.17). */
  paypal: '#FFC439',
  paypalInk: '#003087',

  /** Bars that float over scrolling content. Opaque here: blur is a native nicety, not a dependency. */
  glass: 'rgba(9, 13, 19, 0.86)',
  scrim: 'rgba(2, 4, 7, 0.62)',
} as const;

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

/** Continuous corners: nothing below 10, the way iOS rounds a grouped inset. */
export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 26,
  pill: 999,
} as const;

// 12 > 14 > 17 > 20 > 30. iOS's own body is 17; the display step carries the hero figures.
export const font = {
  display: 30,
  title: 20,
  body: 17,
  label: 14,
  caption: 12,
} as const;

export const type = {
  sans: Platform.select({ default: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif' }),
  mono: Platform.select({
    ios: 'Menlo',
    android: 'monospace',
    default: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  }),
} as const;

/**
 * Depth without a blur dependency: a soft drop for cards and a lift for anything
 * that floats. `elevation` only lands on Android; iOS and web read the shadow.
 */
export const shadow = {
  card: {
    shadowColor: '#000',
    shadowOpacity: 0.45,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
  },
  float: {
    shadowColor: '#000',
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 14 },
  },
  glow: {
    shadowColor: colors.accent,
    shadowOpacity: 0.28,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
  },
} as const;

/** Motion tokens. Durations are short on purpose: a tap must feel answered, not decorated. */
export const motion = {
  fast: 150,
  base: 240,
  slow: 380,
  /** Critically damped-ish spring: settles without a wobble. */
  spring: { damping: 18, stiffness: 220, mass: 0.9 },
  /** For things that pop: the celebration check, the tab indicator. */
  bouncy: { damping: 12, stiffness: 200, mass: 0.8 },
} as const;

/**
 * The widest a single reading column may get. On a phone the window is narrower
 * than both values, so this only bites on tablets and on the web, where the app
 * fills the browser and the column needs a real desktop measure.
 */
export const maxContentWidth = Platform.OS === 'web' ? 960 : 720;
