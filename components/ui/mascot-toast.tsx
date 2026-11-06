import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useRef,
    useState,
    type ReactNode,
} from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeOutUp, SlideInDown } from 'react-native-reanimated';

import { Icon, icon } from './icon';
import { BabyKaeNa } from './mascot';
import { Text } from './text';
import { colors, radius, shadow, space } from './theme';

/** One thing worth interrupting for: a settle, a join, a Globie award. */
export type MascotNote = {
  title: string;
  body?: string;
  /** Globie points earned in this beat, if any. */
  points?: number;
};

type Notify = (note: MascotNote) => void;

const ToastContext = createContext<Notify | null>(null);

/**
 * The in-app notification voice. Baby Kae Na drops in from the top of the screen
 * with the event, lingers for one breath, and leaves — the same mascot that
 * greets you on the sign-in and celebrates a settle, so announcements read as
 * her talking, not as a system banner.
 */
export function useMascotToast() {
  const notify = useContext(ToastContext);
  if (!notify) throw new Error('useMascotToast must be used inside MascotToastProvider');
  return notify;
}

const LINGER = 3600;

export function MascotToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ key: number; note: MascotNote } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const notify = useCallback<Notify>((note) => {
    if (timer.current) clearTimeout(timer.current);
    setToast({ key: Date.now(), note });
    timer.current = setTimeout(() => setToast(null), LINGER);
  }, []);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  return (
    <ToastContext.Provider value={notify}>
      <View style={styles.fill}>{children}</View>
      <View pointerEvents="box-none" style={styles.host}>
        {toast ? (
          <Animated.View
            key={toast.key}
            entering={SlideInDown.springify().damping(18).stiffness(180)}
            exiting={FadeOutUp.duration(220)}
            accessibilityLiveRegion="polite"
            style={styles.card}
          >
            <BabyKaeNa
              size={44}
              variant="badge"
              mood="cheer"
              sparkles={false}
              label={null}
            />
            <View style={styles.copy}>
              <Text variant="label" tone="accent" numberOfLines={1}>
                {toast.note.title}
              </Text>
              {toast.note.body ? (
                <Text variant="caption" tone="muted" numberOfLines={2}>
                  {toast.note.body}
                </Text>
              ) : null}
            </View>
            {toast.note.points ? (
              <View style={styles.chip}>
                <Icon name={icon.sparkles} size={12} color={colors.hero} />
                <Text variant="label" tone="hero">
                  +{toast.note.points}
                </Text>
              </View>
            ) : null}
          </Animated.View>
        ) : null}
      </View>
    </ToastContext.Provider>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  host: {
    position: 'absolute',
    top: space.sm,
    left: space.md,
    right: space.md,
    zIndex: 40,
    alignItems: 'center',
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    // A banner, not a bar: on a wide browser it stays a readable width.
    width: '100%',
    maxWidth: 460,
    paddingVertical: space.sm,
    paddingHorizontal: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.36)',
    backgroundColor: 'rgba(17, 24, 35, 0.98)',
    ...shadow.float,
  },
  copy: { flex: 1, gap: 1 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: space.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(243, 199, 79, 0.14)',
    borderWidth: 1,
    borderColor: 'rgba(243, 199, 79, 0.34)',
  },
});
