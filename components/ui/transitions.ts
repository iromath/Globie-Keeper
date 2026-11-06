import { FadeIn, FadeInDown, FadeInRight, FadeInUp, ZoomIn } from 'react-native-reanimated';

import { motion } from './theme';

/**
 * Shared entrance presets. Reanimated's `entering` props only fire on mount, so
 * these read as "this arrived" — a pushed screen, a card that just appeared, a
 * list that populated. Exits are deliberately absent: content that unmounts is
 * being replaced, and animating it out would stall the replacement.
 */
export const enter = {
  /** A tab screen becoming visible. */
  screen: FadeIn.duration(motion.base),
  /** A screen pushed over the current one. */
  push: FadeInRight.duration(motion.slow),
  /** A card inside a screen. */
  card: FadeInDown.duration(motion.base),
  /** Something that comes up from below, like a sheet. */
  sheet: FadeInUp.duration(motion.slow),
  /** A badge, a chip, a check — anything that should pop. */
  pop: ZoomIn.duration(motion.base),
  /** A bar or header settling into place. */
  bar: FadeInUp.duration(motion.base),
} as const;

/** Staggered list entrance. Capped so a long list never feels slow to arrive. */
export function stagger(index: number, step = 45, cap = 6) {
  return FadeInDown.duration(motion.base).delay(Math.min(index, cap) * step);
}
