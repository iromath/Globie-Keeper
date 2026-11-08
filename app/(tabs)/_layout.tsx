import { Tabs } from 'expo-router/js-tabs';

/**
 * The five places a member lives. The bar itself is drawn by the root shell, so
 * it stays on screen when a bill or the Hero board is pushed on top of a tab;
 * this layout only owns which of the five is showing.
 */
export default function TabsLayout() {
  return (
    <Tabs
      // The shell's footer is the only bar: leave the navigator's own slot empty.
      tabBar={() => null}
      screenOptions={{ headerShown: false, animation: 'shift', lazy: false }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="groups" options={{ title: 'Groups' }} />
      <Tabs.Screen name="donate" options={{ title: 'Donate' }} />
      <Tabs.Screen name="me/shares" options={{ title: 'Shares' }} />
      <Tabs.Screen name="me/activity" options={{ title: 'Activity' }} />
    </Tabs>
  );
}
