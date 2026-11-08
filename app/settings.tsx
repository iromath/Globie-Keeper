import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Platform, Pressable, StyleSheet, Switch, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Field } from '@/components/ui/field';
import { Icon, icon, type IconName } from '@/components/ui/icon';
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
    useUpdateCoverPaypalFee,
    useUpdateNotificationChannel,
    useUpdatePaypalEmail,
    useUpdatePaypalMeHandle,
    useUpdatePaypalMerchantId,
    useUpdatePaypalMode,
    type NotificationChannel
} from '@/lib/queries';
import type { PaymentMode } from '@/lib/types';

/**
 * The two ways a fronter can collect. They are genuinely different plumbing:
 * an order names the account as payee and Globie can confirm the capture, while
 * a PayPal.Me link asks the payer to send the money and tell us they did.
 */
const PAYMENT_MODES: { value: PaymentMode; title: string; body: string; glyph: IconName }[] = [
  {
    value: 'payee_direct',
    title: 'PayPal order',
    body: 'Business or merchant account. Members approve a PayPal order and Globie confirms it for you.',
    glyph: icon.card,
  },
  {
    value: 'paypal_me',
    title: 'PayPal.Me link',
    body: 'Any personal account. Members open your link, pay, then tap “I’ve paid” — you confirm with them.',
    glyph: icon.link,
  },
];

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

/**
 * Why a promised channel cannot fire for this member, in the member's terms.
 * `available` means the server can deliver at all; push also needs a device and
 * an Expo project, so a browser can never satisfy it.
 */
function channelBody(channel: NotificationChannel, available: boolean): string {
  if (available) return COPY[channel].body;
  switch (channel) {
    case 'push':
      return pushSupported()
        ? 'This build is not linked to an Expo project yet, so push cannot be delivered.'
        : 'Browsers cannot receive push. Your reminders wait in Activity.';
    case 'email':
      return 'Globie is not sending email yet. Your reminders wait in Activity.';
    case 'whatsapp':
      return 'Globie is not sending WhatsApp yet. Your reminders wait in Activity.';
    case 'in_app':
      return 'In-app reminders are switched off on this server.';
  }
}

/** The reason the "Turn on push" button cannot be pressed here. */
function pushBlockedReason(): string | null {
  if (!pushSupported()) {
    return 'This is the web build, which cannot receive push. Globie keeps your reminders in Activity.';
  }
  if (!hasPushTarget()) {
    return 'This build is not linked to an Expo project yet, so it cannot register for push.';
  }
  return null;
}

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
  const updateMode = useUpdatePaypalMode();
  const updateHandle = useUpdatePaypalMeHandle();
  const updateCover = useUpdateCoverPaypalFee();
  const client = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [paypalDraft, setPaypalDraft] = useState<string | null>(null);
  const [merchantDraft, setMerchantDraft] = useState<string | null>(null);
  const [handleDraft, setHandleDraft] = useState<string | null>(null);

  const savedPaypal = profile.data?.paypalEmail ?? '';
  const paypalValue = paypalDraft ?? savedPaypal;
  const paypalDirty = paypalDraft !== null && paypalDraft.trim() !== savedPaypal;

  const savedMerchant = profile.data?.paypalMerchantId ?? '';
  const merchantValue = merchantDraft ?? savedMerchant;
  const merchantDirty = merchantDraft !== null && merchantDraft.trim() !== savedMerchant;

  const mode = profile.data?.paypalMode ?? 'payee_direct';
  const coverFee = profile.data?.coverPaypalFee ?? false;
  const savedHandle = profile.data?.paypalMeHandle ?? '';
  const handleValue = handleDraft ?? savedHandle;
  // The server strips a leading "@", so the draft is compared the same way.
  const handleDirty =
    handleDraft !== null && handleDraft.trim().replace(/^@/, '') !== savedHandle;
  const handlePreview = handleValue.trim().replace(/^@/, '');

  const canPush = pushSupported() && hasPushTarget();
  const blockedPush = pushBlockedReason();

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

  async function saveHandle() {
    const next = (handleDraft ?? '').trim().replace(/^@/, '');
    try {
      await updateHandle.mutateAsync(next === '' ? null : next);
      setHandleDraft(null);
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
          hint="Choose how members reimburse you. The money moves from them straight to you — Globie never holds it."
        />
        {profile.isLoading ? (
          <Skeleton height={76} />
        ) : (
          <>
            <View style={styles.rows} accessibilityRole="radiogroup">
              {PAYMENT_MODES.map((option) => {
                const selected = mode === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="radio"
                    aria-checked={selected}
                    aria-disabled={updateMode.isPending}
                    accessibilityLabel={`${option.title}. ${option.body}`}
                    disabled={updateMode.isPending}
                    onPress={() => {
                      if (!selected) updateMode.mutate(option.value);
                    }}
                    style={({ pressed }) => [
                      styles.choice,
                      selected && styles.choiceSelected,
                      pressed && styles.choicePressed,
                    ]}
                  >
                    <View style={[styles.choiceDisc, selected && styles.choiceDiscSelected]}>
                      <Icon
                        name={option.glyph}
                        size={16}
                        color={selected ? colors.accent : colors.muted}
                      />
                    </View>
                    <View style={styles.copy}>
                      <Text variant="label" tone={selected ? 'accent' : 'default'}>
                        {option.title}
                      </Text>
                      <Text variant="caption" tone="dim">
                        {option.body}
                      </Text>
                    </View>
                    {selected ? <Icon name={icon.checkCircle} size={18} color={colors.accent} /> : null}
                  </Pressable>
                );
              })}
            </View>
            {updateMode.error ? (
              <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
                {updateMode.error.message}
              </Text>
            ) : null}

            {mode === 'paypal_me' ? (
              <>
                <Field
                  label="PayPal.Me handle"
                  hint={
                    handlePreview
                      ? `Members will be sent paypal.me/${handlePreview} with the amount filled in.`
                      : 'The part after paypal.me/ in your profile link. Any personal account has one.'
                  }
                  value={handleValue}
                  onChangeText={setHandleDraft}
                  placeholder="your-handle"
                  autoCapitalize="none"
                  autoCorrect={false}
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    if (handleDirty) void saveHandle();
                  }}
                  editable={!updateHandle.isPending}
                  error={updateHandle.error ? updateHandle.error.message : undefined}
                />
                <Button
                  title="Save handle"
                  icon={icon.check}
                  variant="secondary"
                  compact
                  onPress={() => void saveHandle()}
                  loading={updateHandle.isPending}
                  disabled={!handleDirty}
                  style={styles.inline}
                />
                {!savedHandle ? (
                  <Text variant="caption" tone="warn">
                    Members cannot reimburse you until a PayPal.Me handle is saved.
                  </Text>
                ) : null}
              </>
            ) : (
              <>
                <Field
                  label="PayPal email"
                  hint={
                    savedPaypal
                      ? 'Must belong to a PayPal account that can accept payments. Globie never holds the money.'
                      : 'Members cannot reimburse you until a PayPal email is set.'
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

            {/*
              Opt-in fee coverage (DEV_PLAN §2.20). Deliberately off by default
              and worded as covering a fee rather than passing one on.
            */}
            <View style={styles.row}>
              <View style={styles.copy}>
                <Text variant="label">Covers the PayPal fee</Text>
                <Text variant="caption" tone="dim">
                  On: a ฿1,300.00 share asks the member for ฿1,341.00, so ฿1,300.00
                  lands with you. Off: you receive the share minus PayPal&apos;s fee.
                  Estimate only — PayPal sets the final fee by country and currency.
                </Text>
              </View>
              <Switch
                accessibilityLabel="Covers the PayPal fee"
                value={coverFee}
                disabled={updateCover.isPending}
                onValueChange={(next) => updateCover.mutate(next)}
              />
            </View>
            {updateCover.error ? (
              <Text variant="caption" tone="danger" accessibilityLiveRegion="polite">
                {updateCover.error.message}
              </Text>
            ) : null}
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
                      {channelBody(row.channel, row.available)}
                    </Text>
                  </View>
                  <Switch
                    accessibilityLabel={copy.title}
                    value={row.enabled && row.available}
                    disabled={!row.available || update.isPending}
                    onValueChange={(next) => update.mutate({ channel: row.channel, enabled: next })}
                    trackColor={{ false: colors.surfaceHi, true: colors.accentDeep }}
                    thumbColor={row.enabled && row.available ? colors.accent : colors.mutedDim}
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
          <>
            <Button
              title="Turn on push"
              icon={icon.bell}
              variant="secondary"
              onPress={enablePush}
              loading={asking}
              disabled={!canPush}
            />
            {blockedPush ? (
              <Text variant="caption" tone="dim">
                {blockedPush}
              </Text>
            ) : null}
          </>
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
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceAlt,
  },
  choiceSelected: { borderColor: colors.accentDeep, backgroundColor: colors.wash },
  choicePressed: { backgroundColor: colors.surfaceHi },
  choiceDisc: {
    width: 34,
    height: 34,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  choiceDiscSelected: { borderColor: 'rgba(110, 240, 190, 0.4)' },
});
