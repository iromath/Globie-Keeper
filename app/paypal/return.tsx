import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { EmptyState } from '@/components/ui/empty-state';
import { icon } from '@/components/ui/icon';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { space } from '@/components/ui/theme';
import { formatRate } from '@/lib/fx';
import { useCaptureDonation, useCaptureShare, useCaptureTip } from '@/lib/queries';
import type { Donation, SettledRate } from '@/lib/types';

type CaptureResult = {
  kind: 'share' | 'tip' | 'donation';
  points: number;
  rank: number | null;
  settled: boolean;
  settledRate: SettledRate | null;
  donation?: Donation;
};

/**
 * PayPal sends the member here after approval (the server adds `share`, `tip`
 * or `donation` to the return URL). The page captures the order so settlement
 * does not depend on the webhook arriving first; a failure is retryable.
 */
export default function PayPalReturnScreen() {
  const params = useLocalSearchParams<{
    share?: string;
    tip?: string;
    donation?: string;
    cancelled?: string;
  }>();
  const shareId = typeof params.share === 'string' ? params.share : '';
  const tipId = typeof params.tip === 'string' ? params.tip : '';
  const donationId = typeof params.donation === 'string' ? params.donation : '';
  const cancelled = params.cancelled === '1';

  const captureShare = useCaptureShare();
  const captureTip = useCaptureTip();
  const captureDonation = useCaptureDonation();
  const notify = useMascotToast();
  const started = useRef(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
    if (donationId) {
      captureDonation.mutate(
        { donationId },
        {
          onSuccess: (value) => {
            setResult({
              kind: 'donation',
              points: 0,
              rank: null,
              settled: true,
              settledRate: null,
              donation: value.donation,
            });
            const trees = `${value.donation.quantity} ${
              value.donation.quantity === 1 ? 'tree' : 'trees'
            }`;
            notify({
              title: value.donation.mcpStatus === 'adopted' ? 'Tree adopted' : 'Gift recorded',
              body: `${trees} · ${value.donation.speciesName ?? value.donation.speciesId}`,
            });
          },
          onError: (cause) =>
            setError(cause instanceof Error ? cause.message : 'Could not confirm the donation'),
        }
      );
      return;
    }

    if (tipId) {
      captureTip.mutate(
        { tipId },
        {
          onSuccess: (value) => {
            setResult({
              kind: 'tip',
              points: value.pointsAwarded,
              rank: null,
              settled: false,
              settledRate: value.settledRate,
            });
            notify({
              title: 'Tip sent',
              body: 'Kae Na says thanks.',
              points: value.pointsAwarded,
            });
          },
          onError: (cause) =>
            setError(cause instanceof Error ? cause.message : 'Could not confirm the tip'),
        }
      );
      return;
    }

    captureShare.mutate(
      { shareId },
      {
        onSuccess: (value) => {
          setResult({
            kind: 'share',
            points: value.pointsAwarded,
            rank: value.rank,
            settled: value.billSettled,
            settledRate: value.settledRate,
          });
          notify({
            title: value.billSettled ? 'Bill settled' : 'Paid',
            body: value.rank
              ? `You were #${value.rank} to pay.`
              : 'Globie logged your payment.',
            points: value.pointsAwarded,
          });
        },
        onError: (cause) =>
          setError(cause instanceof Error ? cause.message : 'Could not confirm the payment'),
      }
    );
  }

  useEffect(() => {
    if (cancelled || started.current || (!shareId && !tipId && !donationId)) return;
    started.current = true;
    run();
    // `run` closes over the three mutations; the ref makes a re-run a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId, tipId, donationId, cancelled]);

  function retry() {
    setError(null);
    run();
  }

  const back = () => {
    if (result?.kind === 'tip') return router.replace('/');
    if (!shareId && !tipId && donationId) return router.replace('/donate');
    return router.replace('/me/shares');
  };

  // One header for every state: this page replaces rather than pops, so the back
  // control goes through `back` instead of the stack.
  const header = {
    title: 'Payment',
    subtitle: 'Back from PayPal.',
    back: true,
    onBack: back,
  };

  if (cancelled) {
    return (
      <Screen scroll={false} header={header}>
        <EmptyState
          icon={icon.close}
          title="Payment cancelled"
          body={
            donationId
              ? 'Nothing was charged. The tree is still waiting for you at the fund.'
              : tipId
                ? 'Nothing was charged. Your share is untouched.'
                : 'Nothing was charged. Your share is still open whenever you are ready.'
          }
        />
      </Screen>
    );
  }

  if (!shareId && !tipId && !donationId) {
    return (
      <Screen scroll={false} header={header}>
        <EmptyState
          icon={icon.warning}
          title="Nothing to confirm"
          body="This link has no payment attached. Open it from the bill, the fund, or from My shares instead."
        />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen scroll={false} header={header}>
        <EmptyState
          icon={icon.warning}
          title="The payment needs one more check"
          body={error}
          action={
            <View style={styles.stack}>
              <Button
                icon={icon.refresh}
                title="Try again"
                onPress={retry}
                loading={
                  captureShare.isPending || captureTip.isPending || captureDonation.isPending
                }
              />
              <Button
                variant="secondary"
                icon={icon.chevronBack}
                title="Back"
                onPress={back}
              />
            </View>
          }
        />
      </Screen>
    );
  }

  if (result) {
    const tip = result.kind === 'tip';
    const donation = result.kind === 'donation' ? result.donation : undefined;
    const trees = donation
      ? `${donation.quantity} ${donation.quantity === 1 ? 'tree' : 'trees'}`
      : '';
    return (
      <Screen scroll={false} header={header}>
        <Card tone="accent">
          <SuccessPulse
            title={
              donation
                ? donation.mcpStatus === 'adopted'
                  ? 'Tree adopted.'
                  : 'Gift recorded.'
                : tip
                  ? 'Tip sent. Kae Na is proud of you.'
                  : result.settled
                    ? 'Bill settled. Everyone is square.'
                    : 'Paid.'
            }
            body={
              donation
                ? donation.deedNo
                  ? `Deed ${donation.deedNo} · ${trees}`
                  : `${trees} adopted. The deed lands shortly.`
                : tip
                  ? `+${result.points} Globie · the tip goes straight to the fronter.`
                  : result.rank
                    ? `+${result.points} Globie · you were #${result.rank} to pay.`
                    : `+${result.points} Globie`
            }
          />
          {donation && donation.pointsSpent > 0 ? (
            <Text variant="caption" tone="dim" style={styles.rate}>
              {donation.pointsSpent.toLocaleString()} Globie redeemed
            </Text>
          ) : null}
          {result.settledRate ? (
            <Text variant="caption" tone="dim" style={styles.rate}>
              PayPal converted at 1 {result.settledRate.fromCurrency} ={' '}
              {formatRate(result.settledRate.rate)} {result.settledRate.toCurrency}
            </Text>
          ) : null}
          <Button
            icon={icon.chevronBack}
            title={donation ? 'Back to the fund' : tip ? 'Back to home' : 'Back to my shares'}
            onPress={back}
            style={styles.action}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen scroll={false} header={header}>
      <Card>
        <SectionHeading
          glyph={icon.scan}
          title="Confirming your payment"
          hint="Talking to PayPal. This takes a moment."
        />
        <Skeleton height={20} width="64%" />
        <Skeleton height={20} width="40%" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  action: { alignSelf: 'center' },
  rate: { alignSelf: 'center', textAlign: 'center' },
  stack: { gap: space.sm, alignSelf: 'stretch' },
});
