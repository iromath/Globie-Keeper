import Constants from 'expo-constants';
import { Platform } from 'react-native';

const FALLBACK_ORIGIN = 'http://localhost:3001';
const FALLBACK_WEB_ORIGIN = 'http://localhost:8081';

const PRODUCTION_ORIGIN = 'https://keeperapi.globie.ai';
const PRODUCTION_WEB_ORIGIN = 'https://keeper.globie.ai';

/**
 * Origin the API lives behind — keeperapi.globie.ai in production, the local
 * Fastify port in development. EXPO_PUBLIC_API_URL overrides both.
 */
const envOrigin = process.env.EXPO_PUBLIC_API_URL?.trim();

export const API_ORIGIN = (
  (envOrigin || undefined) ??
  (Constants.expoConfig?.extra?.apiOrigin as string | undefined) ??
  (process.env.NODE_ENV === 'production' ? PRODUCTION_ORIGIN : FALLBACK_ORIGIN)
).replace(/\/$/, '');

export const API_BASE = `${API_ORIGIN}/api`;

/**
 * Public origin of the web app, where invite links land. The API and the SPA are
 * separate hostnames in production, so this cannot derive from API_ORIGIN; set
 * EXPO_PUBLIC_WEB_URL to override.
 */
export const WEB_ORIGIN = (
  process.env.EXPO_PUBLIC_WEB_URL?.trim() ||
  (process.env.NODE_ENV === 'production' ? PRODUCTION_WEB_ORIGIN : FALLBACK_WEB_ORIGIN)
).replace(/\/$/, '');

export const IS_WEB = Platform.OS === 'web';
export const IS_NATIVE = Platform.OS !== 'web';
