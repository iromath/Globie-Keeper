import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { icon } from '@/components/ui/icon';
import { Screen } from '@/components/ui/screen';
import { SectionHeading } from '@/components/ui/section';
import { Skeleton } from '@/components/ui/skeleton';
import { space } from '@/components/ui/theme';
import { payPalErrorMessage, startPayPalLogin } from '@/lib/paypal-login';
import { useSession } from '@/lib/session-context';

/**
 * Where PayPal's server callback sends the web browser (DEV_PLAN §2.17). The URL
 * carries either a 60-second `handoff` code or an `error` code; the code becomes
 * a real session here, out of the address bar, and the gate then shows the app.
 */
export default function PayPalLoginScreen() {
  const params = useLocalSearchParams<{ handoff?: string; error?: string }>();
  const { session, completePayPalLogin } = useSession();
  const handoff = typeof params.handoff === 'string' ? params.handoff : '';
  const errorCode = typeof params.error === 'string' ? params.error : '';

  const started = useRef(false);
  const [error, setError] = useState<string | null>(
    errorCode ? payPalErrorMessage(errorCode) : null
  );
  const [retrying, setRetrying] = useState(false);

  useEffect(() => {
    if (!handoff || errorCode || started.current) return;
    started.current = true;
    completePayPalLogin(handoff)
      .then(() => router.replace('/'))
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : payPalErrorMessage(null))
      );
  }, [handoff, errorCode, completePayPalLogin]);

  // The session already landed; the replace above is what moves the URL back.
  if (session) return null;

  const back = () => router.replace('/');

  async function retry() {
    setRetrying(true);
    setError(null);
    const outcome = await startPayPalLogin();
    if (outcome.status === 'error') setError(outcome.message);
    setRetrying(false);
  }

  if (error) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.warning}
          title="PayPal did not complete the sign-in"
          body={error}
          action={
            <View style={styles.stack}>
              <Button
                title="Try PayPal again"
                variant="paypal"
                icon={icon.paypal}
                onPress={retry}
                loading={retrying}
              />
              <Button
                variant="secondary"
                icon={icon.chevronBack}
                title="Use email instead"
                onPress={back}
              />
            </View>
          }
        />
      </Screen>
    );
  }

  if (!handoff) {
    return (
      <Screen scroll={false}>
        <EmptyState
          icon={icon.warning}
          title="Nothing to confirm"
          body="This link has no sign-in attached. Start again from the sign-in screen."
          action={<Button icon={icon.chevronBack} title="Back to sign in" onPress={back} />}
        />
      </Screen>
    );
  }

  return (
    <Screen scroll={false}>
      <Card>
        <SectionHeading
          glyph={icon.paypal}
          title="Signing you in"
          hint="PayPal confirmed you. Opening your Globie."
        />
        <Skeleton height={20} width="64%" />
        <Skeleton height={20} width="40%" />
      </Card>
    </Screen>
  );
}

const styles = StyleSheet.create({
  stack: { gap: space.sm, alignSelf: 'stretch' },
});
