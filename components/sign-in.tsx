import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { useSession } from '@/lib/session-context';
import { HelpManual } from './help/manual';
import { Button } from './ui/button';
import { Card } from './ui/card';
import { Field } from './ui/field';
import { Icon, icon } from './ui/icon';
import { BabyKaeNa } from './ui/mascot';
import { Screen } from './ui/screen';
import { Text } from './ui/text';
import { colors, radius, space } from './ui/theme';
import { enter } from './ui/transitions';

/** Mirrors PASSWORD_MIN_LENGTH in server/src/lib/password.ts. */
const MIN_PASSWORD = 8;

type Mode = 'signin' | 'signup';

export function SignIn() {
  const { signIn, signInWithPayPal } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [paypalBusy, setPaypalBusy] = useState(false);
  // Signed out there is no navigator to push a route into, so the manual
  // renders in place and its back button returns here (§2.22).
  const [showHelp, setShowHelp] = useState(false);

  const canSubmit =
    email.includes('@') &&
    password.length >= MIN_PASSWORD &&
    (mode === 'signin' || name.trim().length > 1) &&
    !busy &&
    !paypalBusy;

  function switchMode(next: Mode) {
    if (next === mode) return;
    setMode(next);
    setError(null);
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      // The name is what tells the API to create the account; signing in only
      // needs the address and the password.
      await signIn(email.trim().toLowerCase(), password, mode === 'signup' ? name.trim() : undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function paypal() {
    if (busy || paypalBusy) return;
    setPaypalBusy(true);
    setError(null);
    try {
      // On web this navigates away; on device it resolves once PayPal comes back.
      const outcome = await signInWithPayPal();
      if (outcome.status === 'error') setError(outcome.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not reach PayPal');
    } finally {
      setPaypalBusy(false);
    }
  }

  if (showHelp) return <HelpManual onClose={() => setShowHelp(false)} />;

  return (
    <Screen style={styles.screen}>
      <Animated.View entering={enter.card} style={styles.hero}>
        <BabyKaeNa size={116} halo style={styles.mark} />
        <Text variant="display" style={styles.centered}>
          Globie Keeper
        </Text>
        <Text variant="body" tone="muted" style={styles.centered}>
          Someone fronts the cash. Everyone taps once to agree, once to settle.
        </Text>
      </Animated.View>

      {error ? (
        <View accessibilityLiveRegion="polite" style={styles.errorBox}>
          <View style={styles.errorHead}>
            <Icon name={icon.alert} size={15} color={colors.danger} />
            <Text variant="label" tone="danger">
              {mode === 'signup' ? 'That did not create your account' : 'That did not sign you in'}
            </Text>
          </View>
          <Text variant="caption" tone="danger">
            {error}
          </Text>
        </View>
      ) : null}

      <Button
        title="Continue with PayPal"
        variant="paypal"
        icon={icon.paypal}
        onPress={paypal}
        loading={paypalBusy}
        disabled={busy}
      />

      <View style={styles.divider}>
        <View style={styles.rule} />
        <Text variant="caption" tone="dim">
          or use email
        </Text>
        <View style={styles.rule} />
      </View>

      <Card style={styles.card}>
        {mode === 'signup' ? (
          <Field
            label="Your name"
            value={name}
            onChangeText={setName}
            placeholder="Nok"
            autoCapitalize="words"
            autoComplete="name"
            returnKeyType="next"
          />
        ) : null}
        <Field
          label="Email"
          value={email}
          onChangeText={setEmail}
          placeholder="nok@example.com"
          autoCapitalize="none"
          autoComplete="email"
          keyboardType="email-address"
          returnKeyType="next"
        />
        <Field
          label="Password"
          value={password}
          onChangeText={setPassword}
          placeholder="••••••••"
          autoCapitalize="none"
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          secureTextEntry
          returnKeyType="go"
          onSubmitEditing={submit}
          hint={mode === 'signup' ? 'At least 8 characters.' : undefined}
        />
        <Button
          title={mode === 'signup' ? 'Create account' : 'Sign in'}
          variant="secondary"
          icon={icon.arrowForward}
          iconSide="right"
          onPress={submit}
          loading={busy}
          disabled={!canSubmit}
        />
        <Button
          title={mode === 'signup' ? 'I already have an account' : 'New here? Create an account'}
          variant="ghost"
          compact
          onPress={() => switchMode(mode === 'signup' ? 'signin' : 'signup')}
          disabled={busy || paypalBusy}
        />
      </Card>

      <Button
        title="Not sure yet? Read the manual"
        variant="ghost"
        compact
        icon={icon.helpOutline}
        onPress={() => setShowHelp(true)}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // Sign-in is a form, not a feed: it keeps its own narrow measure in a wide browser.
  screen: { justifyContent: 'center', gap: space.lg, maxWidth: 440 },
  hero: { gap: space.sm, alignItems: 'center', marginBottom: space.sm },
  // the wordmark: Baby Kae Na, the Globie Keeper mascot, leading the sign-in
  mark: { marginBottom: space.xs },
  centered: { textAlign: 'center' },
  card: { gap: space.md },
  divider: { flexDirection: 'row', alignItems: 'center', gap: space.md },
  rule: { flex: 1, height: 1, backgroundColor: colors.border },
  errorBox: {
    gap: space.xs,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.danger,
    backgroundColor: colors.dangerWash,
  },
  errorHead: { flexDirection: 'row', alignItems: 'center', gap: space.sm },
});
