import { useMemo, useState } from 'react';
import {
    Modal,
    Pressable,
    ScrollView,
    StyleSheet,
    TextInput,
    View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { crossRate, formatRate } from '@/lib/fx';
import { useMoney } from '@/lib/money-context';
import { haptics } from './haptics';
import { Icon, icon } from './icon';
import { Text } from './text';
import { colors, radius, shadow, space } from './theme';

/**
 * The display-currency switch (DEV_PLAN §2.19). It only changes how amounts are
 * rendered — the canonical group currency is still what gets stored and charged,
 * so the sheet says so before anything is picked.
 */
export function CurrencyPill() {
  const { displayCurrency, ratesBase } = useMoney();
  const [open, setOpen] = useState(false);

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Display currency: ${displayCurrency ?? 'group currency'}`}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        style={({ pressed }) => [styles.pill, pressed && styles.pillPressed]}
      >
        <Icon name={icon.globe} size={15} color={colors.muted} />
        <Text variant="caption" tone={displayCurrency ? 'default' : 'muted'}>
          {displayCurrency ?? 'Group'}
        </Text>
        <Icon name="chevron-down" size={13} color={colors.mutedDim} />
      </Pressable>
      <CurrencySheet open={open} onClose={() => setOpen(false)} base={ratesBase} />
    </>
  );
}

function CurrencySheet({
  open,
  onClose,
  base,
}: {
  open: boolean;
  onClose: () => void;
  base: string | null;
}) {
  const insets = useSafeAreaInsets();
  const { displayCurrency, currencies, rates, ratesAsOf, ratesStale, setDisplayCurrency } =
    useMoney();
  const [query, setQuery] = useState('');
  const [saving, setSaving] = useState(false);

  const options = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return currencies.filter((code) => (needle ? code.includes(needle) : true));
  }, [currencies, query]);

  async function pick(code: string | null) {
    if (saving) return;
    haptics.tap();
    setSaving(true);
    try {
      await setDisplayCurrency(code);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const asOf = ratesAsOf ? new Date(ratesAsOf).toLocaleString() : null;

  return (
    <Modal
      visible={open}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel="Close currency picker"
          onPress={onClose}
          style={StyleSheet.absoluteFill}
        />
        <View style={[styles.sheet, { paddingBottom: insets.bottom + space.lg }]}>
          <View style={styles.sheetHead}>
            <View style={styles.sheetTitle}>
              <Text variant="title">Show amounts in</Text>
              <Text variant="caption" tone="muted">
                Indicative rate — PayPal sets the final rate at checkout.
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              hitSlop={space.sm}
              style={styles.close}
            >
              <Icon name={icon.close} size={18} color={colors.muted} />
            </Pressable>
          </View>

          <View style={styles.search}>
            <Icon name="search" size={16} color={colors.mutedDim} />
            <TextInput
              accessibilityLabel="Search currencies"
              autoFocus
              onChangeText={setQuery}
              placeholder="Search a currency code, e.g. EUR"
              placeholderTextColor={colors.mutedDim}
              autoCapitalize="characters"
              autoCorrect={false}
              value={query}
              style={styles.searchInput}
            />
          </View>

          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={styles.list}
            style={styles.listScroll}
          >
            <Option
              label="Group currency"
              hint="No conversion — show the original amount."
              selected={displayCurrency === null}
              onPress={() => pick(null)}
            />
            {options.map((code) => {
              const rate = base ? crossRate(rates, base, code) : null;
              return (
                <Option
                  key={code}
                  label={code}
                  hint={rate && base ? `1 ${base} = ${formatRate(rate)} ${code}` : undefined}
                  selected={displayCurrency === code}
                  onPress={() => pick(code)}
                />
              );
            })}
            {options.length === 0 ? (
              <Text variant="caption" tone="muted" style={styles.empty}>
                No currency matches “{query.trim()}”.
              </Text>
            ) : null}
          </ScrollView>

          {ratesStale ? (
            <Text variant="caption" tone="warn">
              Rates are the last known good ones — the live feed is unreachable.
            </Text>
          ) : asOf ? (
            <Text variant="caption" tone="dim">
              Market rate updated {asOf}
            </Text>
          ) : null}
        </View>
      </View>
    </Modal>
  );
}

function Option({
  label,
  hint,
  selected,
  onPress,
}: {
  label: string;
  hint?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.option,
        selected && styles.optionSelected,
        pressed && styles.optionPressed,
      ]}
    >
      <View style={styles.optionCopy}>
        <Text variant="label" tone={selected ? 'accent' : 'default'}>
          {label}
        </Text>
        {hint ? (
          <Text variant="caption" tone="muted">
            {hint}
          </Text>
        ) : null}
      </View>
      {selected ? <Icon name={icon.check} size={18} color={colors.accent} /> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    minHeight: 32,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  pillPressed: { backgroundColor: colors.surfaceHi },
  scrim: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    backgroundColor: colors.scrim,
  },
  sheet: {
    width: '100%',
    maxWidth: 520,
    maxHeight: '82%',
    gap: space.md,
    paddingTop: space.lg,
    paddingHorizontal: space.lg,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    ...shadow.float,
  },
  sheetHead: { flexDirection: 'row', alignItems: 'flex-start', gap: space.md },
  sheetTitle: { flex: 1, gap: space.xs },
  close: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceAlt,
  },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  searchInput: {
    flex: 1,
    minHeight: 42,
    color: colors.text,
    fontSize: 17,
    outlineWidth: 0,
  },
  listScroll: { flexGrow: 0 },
  list: { gap: space.xs, paddingBottom: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  optionSelected: { backgroundColor: colors.wash },
  optionPressed: { backgroundColor: colors.surfaceHi },
  optionCopy: { flex: 1, gap: 2 },
  empty: { paddingVertical: space.lg },
});
