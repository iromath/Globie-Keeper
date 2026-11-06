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

import { useMoney } from '@/lib/money-context';
import { haptics } from './haptics';
import { Icon, icon } from './icon';
import { Text } from './text';
import { colors, font, radius, shadow, space } from './theme';

/**
 * Group-currency picker. A free-text field let a typo (or a lowercase code)
 * through, so the group could be opened in a currency nothing else understands.
 *
 * The rate table carries ~180 quote codes, including non-tradable ones (XDR,
 * CLF, ZWL) that nobody splits a dinner in, so the sheet offers a curated set
 * and intersects it with the table. `FALLBACK_CURRENCIES` covers the FX feed
 * being unreachable.
 */
const GROUP_CURRENCIES = [
  'AUD', 'BRL', 'CAD', 'CHF', 'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'HKD',
  'HUF', 'IDR', 'ILS', 'INR', 'JPY', 'KRW', 'MXN', 'MYR', 'NOK', 'NZD',
  'PHP', 'PLN', 'SEK', 'SGD', 'THB', 'TRY', 'TWD', 'USD', 'VND', 'ZAR',
];

type Props = {
  label: string;
  value: string;
  onChange: (code: string) => void;
  hint?: string;
  error?: string;
};

export function CurrencySelect({ label, value, onChange, hint, error }: Props) {
  const { currencies } = useMoney();
  const [open, setOpen] = useState(false);

  const codes = useMemo(() => {
    const supported = currencies.filter((code) => GROUP_CURRENCIES.includes(code));
    return supported.length > 0 ? supported : GROUP_CURRENCIES;
  }, [currencies]);

  return (
    <View style={styles.wrapper}>
      <Text variant="label" tone="muted">
        {label}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}: ${value}`}
        accessibilityState={{ expanded: open }}
        onPress={() => {
          haptics.tap();
          setOpen(true);
        }}
        style={({ pressed }) => [
          styles.control,
          pressed && styles.controlPressed,
          !!error && styles.invalid,
        ]}
      >
        <Text variant="body">{value}</Text>
        <Icon name={icon.chevronDown} size={16} color={colors.muted} />
      </Pressable>
      {error ? (
        <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
          {error}
        </Text>
      ) : hint ? (
        <Text variant="caption" tone="muted">
          {hint}
        </Text>
      ) : null}
      <CurrencySheet
        open={open}
        selected={value}
        codes={codes}
        onClose={() => setOpen(false)}
        onPick={(code) => {
          onChange(code);
          setOpen(false);
        }}
      />
    </View>
  );
}

function CurrencySheet({
  open,
  selected,
  codes,
  onClose,
  onPick,
}: {
  open: boolean;
  selected: string;
  codes: string[];
  onClose: () => void;
  onPick: (code: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const needle = query.trim().toUpperCase();
    return codes.filter((code) => (needle ? code.includes(needle) : true));
  }, [codes, query]);

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
              <Text variant="title">Group currency</Text>
              <Text variant="caption" tone="muted">
                Everyone is reimbursed in this currency. Pick it once — it is fixed for the table.
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
            {options.map((code) => {
              const isSelected = code === selected;
              return (
                <Pressable
                  key={code}
                  accessibilityRole="button"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => {
                    haptics.tap();
                    onPick(code);
                  }}
                  style={({ pressed }) => [
                    styles.option,
                    isSelected && styles.optionSelected,
                    pressed && styles.optionPressed,
                  ]}
                >
                  <Text variant="label" tone={isSelected ? 'accent' : 'default'} style={styles.optionCode}>
                    {code}
                  </Text>
                  {isSelected ? <Icon name={icon.check} size={18} color={colors.accent} /> : null}
                </Pressable>
              );
            })}
            {options.length === 0 ? (
              <Text variant="caption" tone="muted" style={styles.empty}>
                No currency matches “{query.trim()}”.
              </Text>
            ) : null}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  wrapper: { gap: space.xs },
  control: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: space.md,
    borderRadius: radius.sm,
    // matches Field: the rim clears 3:1 on the card surface
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surfaceAlt,
  },
  controlPressed: {
    borderColor: colors.focus,
    backgroundColor: colors.surfaceHi,
  },
  invalid: { borderColor: colors.danger, backgroundColor: colors.dangerWash },
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
    fontSize: font.body,
    outlineWidth: 0,
  },
  listScroll: { flexGrow: 0 },
  list: { gap: space.xs, paddingBottom: space.sm },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.md,
  },
  optionSelected: { backgroundColor: colors.wash },
  optionPressed: { backgroundColor: colors.surfaceHi },
  optionCode: { flex: 1 },
  empty: { paddingVertical: space.lg },
});
