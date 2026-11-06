import type { BottomTabBarProps } from 'expo-router/js-tabs';
import { Tabs } from 'expo-router/js-tabs';

import { AppTabBar } from '@/components/ui/tab-bar';
import { useActivitySeenAt } from '@/lib/activity-seen';
import { useMyActivity } from '@/lib/queries';

/**
 * The four places a member lives. Everything else — a bill, the Hero board —
 * is pushed on top of these, which is why this layout owns the bar and the
 * root stack screens do not. Groups earns a destination of its own: it is the
 * only stable way back into a table after the app is reopened.
 */
export default function TabsLayout() {
  return (
    <Tabs
      tabBar={(props) => <Bar {...props} />}
      screenOptions={{ headerShown: false, animation: 'shift', lazy: false }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups' }} />
      <Tabs.Screen name="me/shares" options={{ title: 'Shares' }} />
      <Tabs.Screen name="me/activity" options={{ title: 'Activity' }} />
    </Tabs>
  );
}

/**
 * Activity is the notification centre for every member (§2.13), so the dot
 * lives here: compared against this device's "seen" watermark rather than a
 * server-side unread flag, which the web build has no way to maintain.
 */
function Bar(props: BottomTabBarProps) {
  const activity = useMyActivity();
  const seenAt = useActivitySeenAt();
  const newest = activity.data?.events[0]?.at;
  const unread = Boolean(newest && (!seenAt || newest > seenAt));

  return <AppTabBar {...props} badges={{ 'me/activity': unread }} />;
}
