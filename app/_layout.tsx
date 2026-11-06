import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as Font from 'expo-font';
import * as Notifications from 'expo-notifications';
import { Stack, router, usePathname } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SignIn } from '@/components/sign-in';
import { MascotToastProvider } from '@/components/ui/mascot-toast';
import { Screen } from '@/components/ui/screen';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { colors, space } from '@/components/ui/theme';
import { MoneyProvider } from '@/lib/money-context';
import { SessionProvider, useSession } from '@/lib/session-context';

// A push that arrives with the app open is still a notification (§2.13): the
// handler only decides how it presents, and only a device build can present.
if (Platform.OS !== 'web') {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

export default function RootLayout() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { retry: 1, staleTime: 10_000, refetchOnWindowFocus: false },
        },
      })
  );

  // The icon font is bundled by the config plugin on device builds; on web the
  // family has to be declared before anything renders a glyph.
  useEffect(() => {
    Font.loadAsync({
      Ionicons: require('@react-native-vector-icons/ionicons/fonts/Ionicons.ttf'),
    }).catch(() => undefined);
  }, []);

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <SessionProvider>
            <StatusBar style="light" />
            <MoneyProvider>
              <MascotToastProvider>
                <Gate />
              </MascotToastProvider>
            </MoneyProvider>
          </SessionProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/**
 * A tap on a reminder lands on the table it is about: the payload carries the
 * bill and its group, so the member does not have to hunt for it (§2.13).
 */
function useNotificationTaps(enabled: boolean) {
  useEffect(() => {
    if (!enabled || Platform.OS === 'web') return;

    function open(notification: Notifications.Notification) {
      const data = notification.request.content.data ?? {};
      const groupId = typeof data.groupId === 'string' ? data.groupId : null;
      const billId = typeof data.billId === 'string' ? data.billId : null;

      if (groupId && billId) {
        router.push({ pathname: '/groups/[id]/bill', params: { id: groupId, billId } });
      } else if (groupId) {
        router.push({ pathname: '/groups/[id]', params: { id: groupId } });
      } else {
        router.push('/me/shares');
      }
      Notifications.clearLastNotificationResponse();
    }

    // The tap that launched the app is not delivered to a listener, so read it
    // once on mount; the listener covers every tap after that.
    const last = Notifications.getLastNotificationResponse();
    if (last?.notification) open(last.notification);

    const subscription = Notifications.addNotificationResponseReceivedListener((response) =>
      open(response.notification)
    );
    return () => subscription.remove();
  }, [enabled]);
}

function Gate() {
  const { ready, session } = useSession();
  const pathname = usePathname();

  useNotificationTaps(Boolean(session));

  if (!ready) {
    // The gate is a data region too: it holds the shape of the shell it becomes.
    return (
      <Screen scroll={false} style={styles.gate}>
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={styles.gateStack}
        >
          <Skeleton height={28} width="45%" />
          <Skeleton height={96} />
          <Skeleton height={96} />
        </View>
        <Text variant="caption" tone="muted" accessibilityLiveRegion="polite">
          Opening your session
        </Text>
      </Screen>
    );
  }

  // The PayPal return lands here with no session yet; that page is the thing
  // that creates one, so it has to render inside a navigator of its own (§2.17).
  if (!session) {
    if (pathname.endsWith('/paypal/login')) {
      return (
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: colors.ink },
          }}
        >
          <Stack.Screen name="paypal/login" />
        </Stack>
      );
    }
    return <SignIn />;
  }

  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.ink },
        // On a wide page the header title reads better centred over the column.
        headerTitleAlign: Platform.OS === 'web' ? 'center' : 'left',
        headerTintColor: colors.text,
        headerTitleStyle: { fontWeight: '600' },
        headerShadowVisible: false,
        headerBackButtonDisplayMode: 'minimal',
        contentStyle: { backgroundColor: colors.ink },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="join" options={{ title: 'Join a group' }} />
      <Stack.Screen name="scan" options={{ title: 'Scan invite' }} />
      <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      <Stack.Screen name="groups/[id]/index" options={{ title: 'Group' }} />
      <Stack.Screen name="groups/[id]/bill" options={{ title: 'Bill' }} />
      <Stack.Screen name="groups/[id]/leaderboard" options={{ title: 'Leaderboard' }} />
      <Stack.Screen name="paypal/return" options={{ title: 'Payment' }} />
    </Stack>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.ink },
  gate: { justifyContent: 'center', gap: space.xl },
  gateStack: { gap: space.md },
});
