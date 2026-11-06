import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { request } from './api';

/** Must match the channel the server's payload targets (§2.13). */
export const REMINDER_CHANNEL = 'reminders';

export type PushOutcome =
  | { status: 'registered'; token: string }
  | { status: 'unsupported' }
  | { status: 'denied' }
  | { status: 'unconfigured' }
  | { status: 'failed'; message: string };

/**
 * The browser has no Expo Push Service — web members get in-app and email
 * (§2.13), so registration is a no-op there. A simulator is not a device
 * either: it has no push credentials, so asking would only earn an error.
 */
export function pushSupported(): boolean {
  return Platform.OS !== 'web' && Device.isDevice;
}

export function hasPushTarget(): boolean {
  return Boolean(projectId());
}

function projectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

/**
 * Android 13 only shows the permission prompt once a channel exists, so this
 * runs before the token request; creating the same channel twice is harmless.
 */
export async function prepareChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(REMINDER_CHANNEL, {
    name: 'Bill reminders',
    description: 'A nudge before a share is due, and the moment one is paid.',
    importance: Notifications.AndroidImportance.DEFAULT,
    lightColor: '#6EF0BE',
  });
}

/** Ask for permission, mint the Expo token, and hand it to the API. */
export async function registerForPush(): Promise<PushOutcome> {
  if (!pushSupported()) return { status: 'unsupported' };

  try {
    await prepareChannel();

    const existing = await Notifications.getPermissionsAsync();
    const granted =
      existing.granted ||
      (existing.canAskAgain && (await Notifications.requestPermissionsAsync()).granted);
    if (!granted) return { status: 'denied' };

    const id = projectId();
    // Push needs an EAS project; until `eas init` has run, reminders stay on the
    // in-app and email channels rather than failing in a loop.
    if (!id) return { status: 'unconfigured' };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId: id });
    await request('/me/push-token', { body: { token } });
    return { status: 'registered', token };
  } catch (cause) {
    return {
      status: 'failed',
      message: cause instanceof Error ? cause.message : 'Could not set up push.',
    };
  }
}

/** Sign-out hands the handset back, so it must stop receiving this account's pushes. */
export async function unregisterPush(): Promise<void> {
  if (!pushSupported()) return;
  try {
    await request('/me/push-token', { method: 'DELETE' });
  } catch {
    // A dead network at sign-out must never trap the member in the app.
  }
}
