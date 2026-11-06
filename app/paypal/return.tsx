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
import { useCaptureShare, useCaptureTip } from '@/lib/queries';
import type { SettledRate } from '@/lib/types';

type CaptureResult = {
  kind: 'share' | 'tip';
  points: number;
  rank: number | null;
  settled: boolean;
  settledRate: SettledRate | null;
};

/**
 * PayPal sends the member here after approval (the server adds `share` or `tip`
 * to the return URL, DEV_PLAN §2.18). The page captures the order so settlement
 * does not depend on the webhook arriving first; a failure is retryable.
 */
export default function PayPalReturnScreen() {
  const params = useLocalSearchParams<{
    share?: string;
    tip?: string;
    cancelled?: string;
  }>();
  const shareId = typeof params.share === 'string' ? params.share : '';
  const tipId = typeof params.tip === 'string' ? params.tip : '';
  const cancelled = params.cancelled === '1';

  const captureShare = useCaptureShare();
  const captureTip = useCaptureTip();
  const notify = useMascotToast();
  const started = useRef(false);
  const [result, setResult] = useState<CaptureResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run() {
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
    if (cancelled || started.current || (!shareId && !tipId)) return;
    started.current = true;
    run();
    // `run` closes over the two mutations; the ref makes a re-run a no-op.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareId, tipId, cancelled]);

  function retry() {
    setError(null);
    run();
  }

  const back = () =>
    result?.kind === 'tip' ? router.replace('/') : router.replace('/me/shares');

  if (cancelled) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.close}
          title="Payment cancelled"
          body={
            tipId
              ? 'Nothing was charged. Your share is untouched.'
              : 'Nothing was charged. Your share is still open whenever you are ready.'
          }
          action={<Button icon={icon.chevronBack} title="Back" onPress={back} />}
        />
      </Screen>
    );
  }

  if (!shareId && !tipId) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.warning}
          title="Nothing to confirm"
          body="This link has no payment attached. Open it from the bill or from My shares instead."
          action={
            <Button icon={icon.chevronBack} title="Back to my shares" onPress={back} />
          }
        />
      </Screen>
    );
  }

  if (error) {
    return (
      <Screen scroll={false}>
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
                loading={captureShare.isPending || captureTip.isPending}
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
    return (
      <Screen scroll={false}>
        <Card tone="accent">
          <SuccessPulse
            title={
              tip
                ? 'Tip sent. Kae Na is proud of you.'
                : result.settled
                  ? 'Bill settled. Everyone is square.'
                  : 'Paid.'
            }
            body={
              tip
                ? `+${result.points} Globie · the tip goes straight to the fronter.`
                : result.rank
                  ? `+${result.points} Globie · you were #${result.rank} to pay.`
                  : `+${result.points} Globie`
            }
          />
          {result.settledRate ? (
            <Text variant="caption" tone="dim" style={styles.rate}>
              PayPal converted at 1 {result.settledRate.fromCurrency} ={' '}
              {formatRate(result.settledRate.rate)} {result.settledRate.toCurrency}
            </Text>
          ) : null}
          <Button
            icon={icon.chevronBack}
            title={tip ? 'Back to home' : 'Back to my shares'}
            onPress={back}
            style={styles.action}
          />
        </Card>
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
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
