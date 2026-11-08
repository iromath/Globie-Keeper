import { router } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { ShareRow } from '@/components/ledger/share-row';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { SuccessPulse } from '@/components/ui/celebrate';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon, icon } from '@/components/ui/icon';
import { BabyKaeNa } from '@/components/ui/mascot';
import { useMascotToast } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { ApiError } from '@/lib/api';
import { useMoney } from '@/lib/money-context';
import { useCaptureShare, useConfirmSharePaid, useMyPoints, useMyShares } from '@/lib/queries';
import type { Share } from '@/lib/types';

type Notice = { text: string; settled: boolean };

export default function MySharesScreen() {
  const shares = useMyShares();
  const points = useMyPoints();
  const capture = useCaptureShare();
  const confirmPaid = useConfirmSharePaid();
  const notify = useMascotToast();
  const money = useMoney();

  const [paying, setPaying] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // A PayPal.Me share needs two taps: open the link, then confirm the transfer.
  const [openedLinks, setOpenedLinks] = useState<Record<string, boolean>>({});

  const all = shares.data?.shares ?? [];
  const currency = shares.data?.currency ?? 'THB';

  function announce(result: {
    billSettled: boolean;
    pointsAwarded: number;
    rank: number | null;
  }) {
    setNotice(
      result.billSettled
        ? { text: 'Everyone is square. The bill is settled.', settled: true }
        : {
            text: `Paid. +${result.pointsAwarded} Globie${
              result.rank ? `. You were #${result.rank} to pay.` : '.'
            }`,
            settled: false,
          }
    );
    notify(
      result.billSettled
        ? { title: 'Bill settled', body: 'Everyone is square.' }
        : {
            title: 'Paid',
            body: result.rank ? `You were #${result.rank} to pay.` : 'Globie logged your payment.',
            points: result.pointsAwarded,
          }
    );
  }

  /**
   * PayPal approval happens in the system browser. When the member comes back,
   * the API captures the order, so the share settles even if the webhook is slow.
   */
  async function pay(share: Share) {
    if (!share.approveUrl && !share.canFinish) return;
    setPaying(share.id);
    setError(null);
    setNotice(null);
    if (share.approveUrl) {
      try {
        await WebBrowser.openBrowserAsync(share.approveUrl);
      } catch {
        // A dismissed browser is not a failure; the capture decides below.
      }
    }
    try {
      const result = await capture.mutateAsync({ shareId: share.id });
      announce(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not confirm the payment'));
    } finally {
      setPaying(null);
    }
  }

  /**
   * PayPal.Me has no order to capture: the payer sends the money themselves on
   * PayPal's page. The first tap opens that page; the second one records that
   * the transfer happened and settles the share.
   */
  async function payPaypalMe(share: Share) {
    setError(null);
    setNotice(null);

    if (!openedLinks[share.id]) {
      if (!share.approveUrl) return;
      setPaying(share.id);
      try {
        await WebBrowser.openBrowserAsync(share.approveUrl);
        setOpenedLinks((prev) => ({ ...prev, [share.id]: true }));
        setNotice({
          text: 'Send the amount in PayPal, then tap “I’ve paid” here.',
          settled: false,
        });
      } catch {
        setError(new Error('Could not open the PayPal.Me link'));
      } finally {
        setPaying(null);
      }
      return;
    }

    setPaying(share.id);
    try {
      const result = await confirmPaid.mutateAsync({ shareId: share.id });
      announce(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('Could not confirm the payment'));
    } finally {
      setPaying(null);
    }
  }

  return (
    <Screen
      header={{
        title: 'Shares',
        subtitle: `${points.data?.balance ?? 0} Globie earned so far`,
      }}
    >
      <Card tone="accent">
        <View style={styles.heroRow}>
          <View style={styles.heroCopy}>
            <Text variant="label" tone="muted">
              Outstanding
            </Text>
            <Text variant="figure">
              {money.format(shares.data?.outstandingMinor ?? 0, currency)}
            </Text>
            <Text variant="caption" tone="muted">
              {money.approximate(shares.data?.outstandingMinor ?? 0, currency)
                ? `${money.formatOriginal(shares.data?.outstandingMinor ?? 0, currency)} · `
                : ''}
              {all.length} open {all.length === 1 ? 'share' : 'shares'}
            </Text>
          </View>
          <View style={styles.heroGlyph}>
            <BabyKaeNa size={56} variant="face" label={null} />
          </View>
        </View>
      </Card>

      {notice?.settled ? (
        <Card>
          <SuccessPulse title="All settled" body={notice.text} />
        </Card>
      ) : notice ? (
        <View accessibilityLiveRegion="polite" style={styles.notice}>
          <Icon name={icon.sparkles} size={16} color={colors.accent} />
          <Text variant="body" tone="accent" style={styles.flex}>
            {notice.text}
          </Text>
        </View>
      ) : null}

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.warning} size={16} color={colors.danger} />
            <Text variant="label" tone="danger">
              {error instanceof ApiError && error.code === 'network_error'
                ? 'Could not reach Globie Keeper'
                : 'The payment did not go through'}
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error.message}
          </Text>
        </View>
      ) : null}

      {shares.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={68} />
          <Skeleton height={68} />
        </View>
      ) : shares.error ? (
        <Card>
          <Text variant="title">Could not load your shares</Text>
          <Text variant="body" tone="muted">
            {shares.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => shares.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : all.length === 0 ? (
        <EmptyState
          icon={icon.checkCircle}
          title="Nothing owed either way"
          body="Join a group with an invite code, confirm your lines on a bill, and your share shows up here."
        />
      ) : (
        <View style={styles.list}>
          {all.map((share) => {
            const paypalMe = share.paymentMode === 'paypal_me';
            return (
              <ShareRow
                key={share.id}
                share={share}
                paying={paying === share.id}
                payTitle={paypalMe ? (openedLinks[share.id] ? 'I’ve paid' : 'Open link') : undefined}
                onPay={
                  paypalMe
                    ? share.approveUrl
                      ? () => payPaypalMe(share)
                      : undefined
                    : share.approveUrl || share.canFinish
                      ? () => pay(share)
                      : undefined
                }
                onPress={() =>
                  router.push({ pathname: '/groups/[id]', params: { id: share.groupId } })
                }
              />
            );
          })}
        </View>
      )}
    </Screen>
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
  list: { gap: space.sm },
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
