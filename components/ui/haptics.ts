import * as Haptics from 'expo-haptics';

/**
 * Haptics, as fire-and-forget side effects.
 *
 * iOS gets the Taptic engine, Android the vibrator, and web the Vibration API —
 * which most desktops lack and some browsers refuse outside a live gesture. The
 * promise is thrown away on purpose: a missing vibration must never surface as
 * an unhandled rejection or block the tap that caused it.
 */
const fire = (run: () => Promise<void>) => {
  run().catch(() => undefined);
};

export const haptics = {
  /** A button press. */
  tap: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  /** Choosing between options — a tab, a member chip, a segmented control. */
  select: () => fire(() => Haptics.selectionAsync()),
  /** The thing worked. */
  success: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  /** Accepted, but worth a second look. */
  warn: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  /** The thing failed. */
  error: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
