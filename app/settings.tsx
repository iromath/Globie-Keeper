import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform, StyleSheet, Switch, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon, icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, radius, space } from '@/components/ui/theme';
import { hasPushTarget, pushSupported, registerForPush, type PushOutcome } from '@/lib/push';
import {
    queryKeys,
    useMyProfile,
    useNotificationSettings,
    useUpdateNotificationChannel,
    useUpdatePaypalEmail,
    useUpdatePaypalMerchantId,
    type NotificationChannel,
} from '@/lib/queries';

/** One sentence per channel, written from the member's side of the nudge. */
const COPY: Record<NotificationChannel, { title: string; body: string }> = {
  in_app: {
    title: 'In the app',
    body: 'A card in Activity, on every device you sign in to.',
  },
  push: {
    title: 'Push to this phone',
    body: 'A banner on the lock screen, even with the app closed.',
  },
  email: {
    title: 'Email',
    body: 'A message to the address on your account.',
  },
  whatsapp: {
    title: 'WhatsApp',
    body: 'A message from the Globie Keeper number.',
  },
};

function pushNotice(outcome: PushOutcome): string {
  switch (outcome.status) {
    case 'registered':
      return 'This phone will get Globie reminders.';
    case 'unsupported':
      return 'This browser gets in-app reminders and email. Push needs the mobile app.';
    case 'denied':
      return 'Globie Keeper is not allowed to notify on this device. Allow it in system settings, then try again.';
    case 'unconfigured':
      return 'Push is not configured for this build yet.';
    case 'failed':
      return outcome.message;
  }
}

export default function SettingsScreen() {
  const settings = useNotificationSettings();
  const update = useUpdateNotificationChannel();
  const profile = useMyProfile();
  const updatePaypal = useUpdatePaypalEmail();
  const updateMerchant = useUpdatePaypalMerchantId();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paypalDraft, setPaypalDraft] = useState<string | null>(null);
  const [merchantDraft, setMerchantDraft] = useState<string | null>(null);

  const savedPaypal = profile.data?.paypalEmail ?? '';
  const paypalValue = paypalDraft ?? savedPaypal;
  const paypalDirty = paypalDraft !== null && paypalDraft.trim() !== savedPaypal;

  const savedMerchant = profile.data?.paypalMerchantId ?? '';
  const merchantValue = merchantDraft ?? savedMerchant;
  const merchantDirty = merchantDraft !== null && merchantDraft.trim() !== savedMerchant;

  async function savePaypal() {
    const next = (paypalDraft ?? '').trim();
    try {
      await updatePaypal.mutateAsync(next === '' ? null : next);
      setPaypalDraft(null);
    } catch {
      // The mutation error renders under the field; keep the draft for a retry.
    }
  }

  async function saveMerchant() {
    const next = (merchantDraft ?? '').trim();
    try {
      await updateMerchant.mutateAsync(next === '' ? null : next);
      setMerchantDraft(null);
    } catch {
      // Same as above: the error stays attached to the field.
    }
  }

  async function enablePush() {
    setAsking(true);
    setNotice(null);
    const outcome = await registerForPush();
    setAsking(false);
    if (outcome.status === 'registered') {
      await client.invalidateQueries({ queryKey: queryKeys.myNotifications });
    }
    setNotice(pushNotice(outcome));
  }

  return (
    <Screen
      header={{
        title: 'Settings',
        subtitle: 'Where you get paid, and where Globie nudges you.',
        back: true,
      }}
      bottomInset={space.xl}
    >
      <Card>
        <SectionHeading
          glyph={icon.paypal}
          title="Getting paid"
          hint="Reimbursements only land in a PayPal Business account that can receive payments. Add that account's email, plus its merchant ID if you have one."
        />
        {profile.isLoading ? (
          <Skeleton height={76} />
        ) : (
          <>
            <Field
              label="PayPal email"
              hint={
                savedPaypal
                  ? 'Must belong to a PayPal Business account that accepts payments. Globie never holds the money.'
                  : 'Members cannot reimburse you until a Business PayPal account is set.'
              }
              value={paypalValue}
              onChangeText={setPaypalDraft}
              placeholder="you@example.com"
              inputMode="email"
              keyboardType="email-address"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (paypalDirty) void savePaypal();
              }}
              editable={!updatePaypal.isPending}
              error={updatePaypal.error ? updatePaypal.error.message : undefined}
            />
            <Button
              title="Save PayPal email"
              icon={icon.check}
              variant="secondary"
              compact
              onPress={() => void savePaypal()}
              loading={updatePaypal.isPending}
              disabled={!paypalDirty}
              style={styles.inline}
            />
            <Field
              label="PayPal merchant ID"
              hint="Optional. When set, payments address this account directly instead of the email."
              value={merchantValue}
              onChangeText={setMerchantDraft}
              placeholder="Merchant account ID"
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={() => {
                if (merchantDirty) void saveMerchant();
              }}
              editable={!updateMerchant.isPending}
              error={updateMerchant.error ? updateMerchant.error.message : undefined}
            />
            <Button
              title="Save merchant ID"
              icon={icon.check}
              variant="secondary"
              compact
              onPress={() => void saveMerchant()}
              loading={updateMerchant.isPending}
              disabled={!merchantDirty}
              style={styles.inline}
            />
          </>
        )}
      </Card>

      {settings.isLoading ? (
        <View style={styles.list} accessibilityElementsHidden>
          <Skeleton height={72} />
          <Skeleton height={72} />
        </View>
      ) : settings.error ? (
        <Card>
          <Text variant="title">Could not load your reminders</Text>
          <Text variant="body" tone="muted">
            {settings.error.message}
          </Text>
          <Button
            variant="secondary"
            compact
            icon={icon.refresh}
            title="Try again"
            onPress={() => settings.refetch()}
            style={styles.inline}
          />
        </Card>
      ) : (
        <Card>
          <SectionHeading
            glyph={icon.bell}
            title="Where to reach me"
            hint="Quiet hours are 22:00 to 08:00, wherever you are."
          />
          <View style={styles.rows}>
            {(settings.data?.channels ?? []).map((row) => {
              const copy = COPY[row.channel];
              return (
                <View key={row.channel} style={styles.row}>
                  <View style={styles.copy}>
                    <Text variant="label">{copy.title}</Text>
                    <Text variant="caption" tone="dim">
                      {row.available ? copy.body : 'Not set up on this server yet.'}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={copy.title}
                    value={row.enabled && row.available}
                    disabled={!row.available || update.isPending}
                    onValueChange={(next) => update.mutate({ channel: row.channel, enabled: next })}
                    trackColor={{ false: colors.surfaceHi, true: colors.accentDeep }}
                    thumbColor={row.enabled ? colors.accent : colors.mutedDim}
                  />
                </View>
              );
            })}
          </View>
          {update.error ? (
            <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
              {update.error.message}
            </Text>
          ) : null}
        </Card>
      )}

      <Card>
        <SectionHeading
          glyph={icon.phone}
          title="This device"
          hint={
            Platform.OS === 'web'
              ? 'Browsers cannot receive push; the in-app feed covers it.'
              : 'One handset, one account.'
          }
        />
        {settings.data?.pushRegistered ? (
          <View style={styles.status}>
            <Icon name={icon.checkCircle} size={16} color={colors.accent} />
            <Text variant="body" tone="accent" style={styles.flex}>
              Push is on for this device.
            </Text>
          </View>
        ) : (
          <Button
            title="Turn on push"
            icon={icon.bell}
            variant="secondary"
            onPress={enablePush}
            loading={asking}
            disabled={!pushSupported() || !hasPushTarget()}
          />
        )}
        {notice ? (
          <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
            {notice}
          </Text>
        ) : null}
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  list: { gap: space.sm },
  rows: { gap: space.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  copy: { flex: 1, gap: 2 },
  status: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: 'rgba(110, 240, 190, 0.28)',
    backgroundColor: colors.wash,
  },
  flex: { flex: 1 },
  inline: { alignSelf: 'flex-start' },
});
