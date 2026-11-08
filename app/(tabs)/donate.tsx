import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { EmptyState } from '@/components/ui/empty-state';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError } from '@/lib/api';
import { useMoney } from '@/lib/money-context';
import {
    useCaptureDonation,
    useCreateDonation,
    useDonations,
    useDonationSpecies,
    useRetryAdoption,
} from '@/lib/queries';
import type { Donation, DonationSpecies } from '@/lib/types';

/** US$5 / 10 / 25 / 50, in minor units — the four gifts most people pick. */
const PRESETS = [500, 1000, 2500, 5000];

const TREES_PER_GIFT_MAX = 1000;

/**
 * The Globie Fund (DEV_PLAN §2.21). One screen, two rails: a PayPal donation
 * paid into the fund account, or Globie points at 1000 = US$1. Both end the
 * same way — a deed in the sanctuary through `mcp.globie.earth`.
 */
export default function DonateScreen() {
  const species = useDonationSpecies();
  const donations = useDonations();
  const createDonation = useCreateDonation();
  const captureDonation = useCaptureDonation();
  const retryAdoption = useRetryAdoption();
  const notify = useMascotToast();
  const money = useMoney();

  const [pickedId, setPickedId] = useState<string | null>(null);
  const [amountText, setAmountText] = useState('10');
  const [quantity, setQuantity] = useState(1);
  const [busy, setBusy] = useState<'paypal' | 'points' | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [success, setSuccess] = useState<Donation | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const catalogue = species.data?.species ?? [];
  const fundCurrency = species.data?.currency ?? 'USD';
  const pointsPerUsd = species.data?.pointsPerUsd ?? 1000;
  const minMinor = species.data?.minMinor ?? 100;
  const maxMinor = species.data?.maxMinor ?? 1_000_000;
  const balance = donations.data?.pointsBalance ?? 0;

  // A tap wins over the default; otherwise the sanctuary's first need is shown.
  const selected: DonationSpecies | undefined =
    catalogue.find((entry) => entry.id === pickedId) ?? catalogue[0];

  const parsed = Number.parseFloat(amountText);
  const amountMinor = Number.isFinite(parsed) ? Math.round(parsed * 100) : 0;
  const amountValid =
    !!selected && amountMinor >= minMinor && amountMinor <= maxMinor && balance >= 0;
  const amountError =
    amountText.length > 0 && !amountValid
      ? `Give between ${money.formatOriginal(minMinor, fundCurrency)} and ${money.formatOriginal(
          maxMinor,
          fundCurrency
        )}`
      : undefined;

  // 1000 points = US$1, so one cent is ten points: the peg only lands on whole
  // cents in steps of ten, and the server refuses anything else.
  const pointsForAmount = Math.ceil((amountMinor * pointsPerUsd) / 100 / 10) * 10;
  const canUsePoints = fundCurrency === 'USD' && pointsForAmount > 0;
  const pointsAffordable = canUsePoints && balance >= pointsForAmount;

  function changeAmount(next: string) {
    const cleaned = next.replace(/[^0-9.]/g, '');
    const [whole, ...rest] = cleaned.split('.');
    setAmountText(rest.length > 0 ? `${whole}.${rest.join('').slice(0, 2)}` : whole);
  }

  function resetNotices() {
    setError(null);
    setNotice(null);
    setSuccess(null);
  }

  function celebrate(donation: Donation) {
    setSuccess(donation);
    const trees = `${donation.quantity} ${donation.quantity === 1 ? 'tree' : 'trees'}`;
    notify({
      title: donation.mcpStatus === 'adopted' ? 'Tree adopted' : 'Gift recorded',
      body: `${trees} · ${donation.speciesName ?? donation.speciesId}`,
    });
  }

  function handleFailure(cause: unknown, fallback: string) {
    // A PayPal page the payer closed is not an error worth an alarm: the server
    // already marked the checkout dead and nothing was charged.
    if (cause instanceof ApiError && cause.code === 'donation_checkout_incomplete') {
      setNotice('Nothing was charged — PayPal did not complete the gift.');
      return;
    }
    setError(cause instanceof Error ? cause : new Error(fallback));
  }

  /** Same shape as a share: open PayPal, then capture so the deed never waits. */
  async function donateWithPayPal() {
    if (!selected || !amountValid) return;
    setBusy('paypal');
    resetNotices();
    try {
      const created = await createDonation.mutateAsync({
        method: 'paypal',
        speciesId: selected.id,
        speciesName: selected.name,
        quantity,
        amountMinor,
      });
      if (created.approveUrl) {
        try {
          await WebBrowser.openBrowserAsync(created.approveUrl);
        } catch {
          // A dismissed browser is not a failure; the capture decides below.
        }
      }
      const captured = await captureDonation.mutateAsync({ donationId: created.donation.id });
      celebrate(captured.donation);
    } catch (cause) {
      handleFailure(cause, 'PayPal did not finish this gift');
    } finally {
      setBusy(null);
    }
  }

  /** The points rail settles in one step: the server debits and adopts at once. */
  async function donateWithPoints() {
    if (!selected || !amountValid || !pointsAffordable) return;
    setBusy('points');
    resetNotices();
    try {
      const created = await createDonation.mutateAsync({
        method: 'points',
        speciesId: selected.id,
        speciesName: selected.name,
        quantity,
        points: pointsForAmount,
      });
      celebrate(created.donation);
    } catch (cause) {
      handleFailure(cause, 'Could not use your Globie');
    } finally {
      setBusy(null);
    }
  }

  async function retry(donation: Donation) {
    setRetrying(donation.id);
    setError(null);
    try {
      const result = await retryAdoption.mutateAsync({ donationId: donation.id });
      notify({ title: 'Deed written', body: result.donation.deedNo ?? 'The tree is in the ground.' });
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not reach the sanctuary'));
    } finally {
      setRetrying(null);
    }
  }

  const errorTitle =
    error instanceof ApiError
      ? error.code === 'network_error'
        ? 'Could not reach Globie Keeper'
        : error.code === 'insufficient_points'
          ? 'Not enough Globie'
          : error.code === 'paypal_not_configured'
            ? 'PayPal is not set up yet'
            : 'The gift did not go through'
      : 'The gift did not go through';

  return (
    <Screen
      header={{
        title: 'Globie Fund',
        subtitle: 'Adopt a tree in the Isaan sanctuary.',
      }}
    >
      <Card tone="accent">
        <View style={styles.heroRow}>
          <View style={styles.heroCopy}>
            <Text variant="label" tone="muted">
              Given to the sanctuary
            </Text>
            <Text variant="figure">
              {money.formatOriginal(donations.data?.totalMinor ?? 0, fundCurrency)}
            </Text>
            <Text variant="caption" tone="muted">
              {donations.data?.treesAdopted ?? 0}{' '}
              {(donations.data?.treesAdopted ?? 0) === 1 ? 'tree' : 'trees'} adopted ·{' '}
              {(donations.data?.donations.length ?? 0) === 1
                ? '1 gift'
                : `${donations.data?.donations.length ?? 0} gifts`}
            </Text>
          </View>
          <View style={styles.heroGlyph}>
            <BabyKaeNa size={54} variant="badge" mood="cheer" label={null} />
          </View>
        </View>
      </Card>

      {success ? (
        <Card tone="accent">
          <SuccessPulse
            title={success.mcpStatus === 'adopted' ? 'Tree adopted' : 'Gift recorded'}
            body={
              success.deedNo
                ? `Deed ${success.deedNo} · ${success.quantity} ${
                    success.quantity === 1 ? 'tree' : 'trees'
                  }`
                : `${success.quantity} ${
                    success.quantity === 1 ? 'tree' : 'trees'
                  } adopted. The deed lands shortly.`
            }
          />
          <Button
            variant="secondary"
            compact
            icon={icon.leaf}
            title="Adopt another tree"
            onPress={() => setSuccess(null)}
            style={styles.inline}
          />
        </Card>
      ) : null}

      {notice ? (
        <View accessibilityLiveRegion="polite" style={styles.notice}>
          <Icon name={icon.information} size={16} color={colors.accent} />
          <Text variant="body" tone="accent" style={styles.flex}>
            {notice}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.warning} size={16} color={colors.danger} />
            <Text variant="label" tone="danger">
              {errorTitle}
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error.message}
          </Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <SectionHeading
          glyph={icon.leaf}
          title="Who to adopt"
          hint="Live from the sanctuary."
        />
        {species.isLoading ? (
          <Skeleton height={96} />
        ) : species.error ? (
          <Card>
            <Text variant="label" tone="danger">
              Could not load the sanctuary
            </Text>
            <Text variant="caption" tone="muted">
              {species.error.message}
            </Text>
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => species.refetch()}
              style={styles.inline}
            />
          </Card>
        ) : catalogue.length === 0 ? (
          <EmptyState
            icon={icon.leaf}
            title="No trees are listed right now"
            body="The sanctuary will publish its next species soon. Your Globie is safe until then."
            action={
              <Button
                variant="secondary"
                compact
                icon={icon.refresh}
                title="Check again"
                onPress={() => species.refetch()}
              />
            }
          />
        ) : (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={styles.speciesRow}
            accessibilityRole="radiogroup"
            accessibilityLabel="Tree to adopt"
          >
            {catalogue.map((entry) => {
              const active = entry.id === selected?.id;
              const pinColor = entry.status === 'critical' ? colors.warn : colors.hero;
              return (
                <Pressable
                  key={entry.id}
                  accessibilityRole="radio"
                  aria-checked={active}
                  accessibilityLabel={`${entry.name}${entry.latin ? `, ${entry.latin}` : ''}${
                    entry.status === 'critical'
                      ? ', critical need'
                      : entry.status === 'urgent'
                        ? ', urgent'
                        : ''
                  }`}
                  onPress={() => setPickedId(entry.id)}
                  style={({ pressed }) => [
                    styles.species,
                    active && styles.speciesActive,
                    pressed && styles.pressed,
                  ]}
                >
                  <View style={styles.speciesTop}>
                    <Text variant="title" tone={active ? 'accent' : 'default'} numberOfLines={1}>
                      {entry.name}
                    </Text>
                    {active ? <Icon name={icon.checkCircle} size={16} color={colors.accent} /> : null}
                  </View>
                  {entry.latin ? (
                    <Text variant="caption" tone="dim" numberOfLines={1}>
                      {entry.latin}
                    </Text>
                  ) : null}
                  {entry.status ? (
                    <View style={styles.pin}>
                      <View style={[styles.pinDot, { backgroundColor: pinColor }]} />
                      <Text variant="caption" tone={entry.status === 'critical' ? 'warn' : 'hero'}>
                        {entry.status === 'critical' ? 'Critical need' : 'Urgent'}
                      </Text>
                    </View>
                  ) : null}
                  <Text variant="caption" tone="muted" numberOfLines={3}>
                    {entry.blurb}
                  </Text>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      <Card>
        <SectionHeading glyph={icon.cash} title="Your gift" hint="Every gift plants real trees." />

        <View style={styles.chips}>
          {PRESETS.map((preset) => {
            const active = amountMinor === preset;
            return (
              <Pressable
                key={preset}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                onPress={() => setAmountText(String(preset / 100))}
                style={({ pressed }) => [
                  styles.chip,
                  active && styles.chipActive,
                  pressed && styles.pressed,
                ]}
              >
                <Text variant="label" tone={active ? 'accent' : 'muted'}>
                  {money.formatOriginal(preset, fundCurrency)}
                </Text>
              </Pressable>
            );
          })}
        </View>

        <Field
          label={`Amount in ${fundCurrency}`}
          value={amountText}
          onChangeText={changeAmount}
          keyboardType="decimal-pad"
          inputMode="decimal"
          placeholder="10"
          hint={
            money.approximate(amountMinor, fundCurrency)
              ? `${money.formatOriginal(amountMinor, fundCurrency)} ${
                  money.approximate(amountMinor, fundCurrency) ?? ''
                }`
              : undefined
          }
          error={amountError}
        />

        <View style={styles.stepperRow}>
          <View style={styles.stepperCopy}>
            <Text variant="label">Trees</Text>
            <Text variant="caption" tone="dim">
              {selected ? `You'll adopt ${quantity} × ${selected.name}` : 'Pick a tree first'}
            </Text>
          </View>
          <View style={styles.stepper}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="One tree fewer"
              accessibilityState={{ disabled: quantity <= 1 }}
              disabled={quantity <= 1}
              onPress={() => setQuantity((value) => Math.max(1, value - 1))}
              style={({ pressed }) => [
                styles.step,
                quantity <= 1 && styles.stepOff,
                pressed && styles.pressed,
              ]}
            >
              <Text variant="title">−</Text>
            </Pressable>
            <Text variant="title" style={styles.stepValue}>
              {quantity}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="One tree more"
              accessibilityState={{ disabled: quantity >= TREES_PER_GIFT_MAX }}
              disabled={quantity >= TREES_PER_GIFT_MAX}
              onPress={() => setQuantity((value) => Math.min(TREES_PER_GIFT_MAX, value + 1))}
              style={({ pressed }) => [
                styles.step,
                quantity >= TREES_PER_GIFT_MAX && styles.stepOff,
                pressed && styles.pressed,
              ]}
            >
              <Text variant="title">+</Text>
            </Pressable>
          </View>
        </View>

        <Button
          variant="paypal"
          icon={icon.paypal}
          title={`Donate ${money.formatOriginal(amountMinor, fundCurrency)} with PayPal`}
          onPress={donateWithPayPal}
          loading={busy === 'paypal'}
          disabled={!amountValid || busy !== null}
        />
        <Text variant="caption" tone="dim" style={styles.centered}>
          Paid into the Globie Fund&apos;s PayPal account. The deed is written the moment it clears.
        </Text>

        <View style={styles.divider} />

        <View style={styles.pointsRow}>
          <View style={styles.pointsGlyph}>
            <Icon name={icon.sparkles} size={18} color={colors.accent} />
          </View>
          <View style={styles.pointsCopy}>
            <Text variant="label">
              or give {pointsForAmount.toLocaleString()} Globie
            </Text>
            <Text variant="caption" tone="dim">
              {canUsePoints
                ? pointsAffordable
                  ? `You have ${balance.toLocaleString()} Globie · 1,000 = ${money.formatOriginal(
                      100,
                      fundCurrency
                    )}`
                  : `Need ${pointsForAmount.toLocaleString()}, you have ${balance.toLocaleString()}`
                : 'Globie points convert to US dollars only.'}
            </Text>
          </View>
          <Button
            variant="secondary"
            compact
            title={pointsAffordable ? 'Redeem' : 'Not enough'}
            onPress={donateWithPoints}
            loading={busy === 'points'}
            disabled={!amountValid || !pointsAffordable || busy !== null}
          />
        </View>
      </Card>

      <View style={styles.section}>
        <SectionHeading
          glyph={icon.receipt}
          title="Your giving"
          hint={`${balance.toLocaleString()} Globie available`}
        />
        {donations.isLoading ? (
          <View style={styles.list} accessibilityElementsHidden>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </View>
        ) : donations.error ? (
          <Card>
            <Text variant="label" tone="danger">
              Could not load your gifts
            </Text>
            <Text variant="caption" tone="muted">
              {donations.error.message}
            </Text>
            <Button
              variant="secondary"
              compact
              icon={icon.refresh}
              title="Try again"
              onPress={() => donations.refetch()}
              style={styles.inline}
            />
          </Card>
        ) : (donations.data?.donations.length ?? 0) === 0 ? (
          <EmptyState
            icon={icon.leaf}
            title="No trees yet"
            body="The first one is yours. Pick a species above and the sanctuary does the rest."
          />
        ) : (
          <View style={styles.list}>
            {donations.data?.donations.map((donation) => (
              <GivingRow
                key={donation.id}
                donation={donation}
                retrying={retrying === donation.id}
                onRetry={() => retry(donation)}
              />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}

function GivingRow({
  donation,
  retrying,
  onRetry,
}: {
  donation: Donation;
  retrying: boolean;
  onRetry: () => void;
}) {
  const money = useMoney();
  const pointsRail = donation.method === 'points';
  const failed = donation.mcpStatus === 'failed';
  const pending = donation.mcpStatus === 'pending' || failed;

  const when = new Date(donation.paidAt ?? donation.createdAt).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const deed = donation.deedNo
    ? `Deed ${donation.deedNo}`
    : pending
      ? failed
        ? 'Deed not written yet'
        : 'Writing the deed…'
      : 'Deed pending';

  return (
    <View style={styles.row}>
      <View style={styles.rowGlyph}>
        <Icon name={pointsRail ? icon.sparkles : icon.paypal} size={18} color={colors.accent} />
      </View>
      <View style={styles.rowCopy}>
        <Text variant="label" numberOfLines={1}>
          {donation.quantity} × {donation.speciesName ?? donation.speciesId}
        </Text>
        <Text variant="caption" tone="dim" numberOfLines={1}>
          {when} · {deed}
        </Text>
      </View>
      <View style={styles.rowRight}>
        <Text variant="label" tone="accent">
          {money.formatOriginal(donation.amountMinor, donation.currency)}
        </Text>
        <Text variant="caption" tone="dim">
          {pointsRail ? `${donation.pointsSpent.toLocaleString()} Globie` : 'PayPal'}
        </Text>
      </View>
      {failed ? (
        <Button
          variant="ghost"
          compact
          icon={icon.refresh}
          title="Write deed"
          onPress={onRetry}
          loading={retrying}
          style={styles.rowAction}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  heroRow: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  heroCopy: { flex: 1, gap: space.xs },
  heroGlyph: {
    width: 58,
    height: 58,
    alignItems: 'center',
    justifyContent: 'center',
  },
  section: { gap: space.md },
  speciesRow: { gap: space.sm, paddingRight: space.lg },
  species: {
    width: 208,
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  speciesActive: {
    borderColor: colors.accent,
    backgroundColor: colors.wash,
  },
  speciesTop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.sm,
  },
  pin: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  pinDot: { width: 6, height: 6, borderRadius: 3 },
  pressed: { opacity: 0.85 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: space.sm },
  chip: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  chipActive: { borderColor: colors.accent, backgroundColor: colors.wash },
  stepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.md,
  },
  stepperCopy: { flex: 1, gap: space.xs },
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
    padding: space.xs,
  },
  step: {
    width: 44,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.pill,
  },
  stepOff: { opacity: 0.35 },
  stepValue: { minWidth: 32, textAlign: 'center' },
  centered: { textAlign: 'center' },
  divider: { height: 1, backgroundColor: colors.hairline, marginVertical: space.xs },
  pointsRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  pointsGlyph: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
  },
  pointsCopy: { flex: 1, gap: space.xs },
  list: { gap: space.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  rowGlyph: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.wash,
  },
  rowCopy: { flex: 1, gap: space.xs },
  rowRight: { alignItems: 'flex-end', gap: space.xs },
  rowAction: { marginLeft: space.xs },
  notice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.28)',
    backgroundColor: colors.wash,
  },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
});
