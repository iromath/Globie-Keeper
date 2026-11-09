const bool = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) return fallback;
  return value === '1' || value.toLowerCase() === 'true';
};

const int = (value: string | undefined, fallback: number): number => {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

type FeeScheduleConfig = { rate: number; fixedMinor: number };

/**
 * Indicative commercial fees, per currency (DEV_PLAN §2.20). The fixed part is
 * in minor units, so THB 11.00 is `1100`. Only an estimate: the real fee also
 * depends on payer country and whether the payment crosses a border.
 */
const DEFAULT_FEE_SCHEDULES: Record<string, FeeScheduleConfig> = {
  THB: { rate: 0.0349, fixedMinor: 1100 },
  USD: { rate: 0.0349, fixedMinor: 30 },
};

/** `{"THB":{"rate":0.0349,"fixedMinor":1100}}`; malformed entries are dropped. */
const parseFeeSchedules = (
  value: string | undefined,
): Record<string, FeeScheduleConfig> => {
  if (!value?.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object') return {};

  const schedules: Record<string, FeeScheduleConfig> = {};
  for (const [code, entry] of Object.entries(parsed as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object') continue;
    const { rate, fixedMinor } = entry as { rate?: unknown; fixedMinor?: unknown };
    if (
      typeof rate === 'number' &&
      Number.isFinite(rate) &&
      rate >= 0 &&
      rate < 1 &&
      typeof fixedMinor === 'number' &&
      Number.isInteger(fixedMinor) &&
      fixedMinor >= 0
    ) {
      schedules[code.trim().toUpperCase()] = { rate, fixedMinor };
    }
  }
  return schedules;
};

/**
 * The API and the web export are served from different hostnames in
 * production (keeperapi.globie.ai / keeper.globie.ai), so "where the API lives"
 * and "where the browser app lives" cannot share one origin.
 */
const publicOrigin =
  process.env.PUBLIC_ORIGIN ?? 'https://keeperapi.globie.ai';
const webOrigin = process.env.WEB_ORIGIN ?? 'https://keeper.globie.ai';

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.API_HOST ?? '0.0.0.0',
  port: int(process.env.API_PORT, 3001),

  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://globie:globie@localhost:55432/globie',
  databasePoolMax: int(process.env.DATABASE_POOL_MAX, 10),

  /** Public origin that fronts the API in production. */
  publicOrigin,

  /** Public origin that serves the Expo web export. */
  webOrigin,

  /** Where uploaded receipt photos and videos land before frame extraction. */
  mediaDir: process.env.MEDIA_DIR ?? './var/media',

  sessionTtlDays: int(process.env.SESSION_TTL_DAYS, 60),
  autoMigrate: bool(process.env.AUTO_MIGRATE, true),

  /**
   * Guessing ceiling for `/auth/session` (per email) and `/groups/join`
   * (per user). The per-IP ceiling for sign-in is five times this.
   */
  authAttemptLimit: int(process.env.AUTH_ATTEMPT_LIMIT, 20),
  authAttemptWindowMs: int(process.env.AUTH_ATTEMPT_WINDOW_MS, 10 * 60_000),

  /** Comma separated extra origins; the public origin and localhost are always allowed. */
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),

  // --- receipt extraction ---------------------------------------------------
  /**
   * DeepSeek serves an OpenAI-compatible chat endpoint and `deepseek-flash`
   * accepts images. Point VISION_API_URL / VISION_MODEL elsewhere to swap
   * providers; the request shape in lib/receipt.ts stays the same.
   */
  visionApiKey: process.env.VISION_API_KEY ?? '',
  visionApiUrl:
    process.env.VISION_API_URL ?? 'https://api.deepseek.com/chat/completions',
  visionModel: process.env.VISION_MODEL ?? 'deepseek-flash',
  visionTimeoutMs: int(process.env.VISION_TIMEOUT_MS, 45_000),
  /** Video frames sampled per upload before reconciliation. */
  visionMaxFrames: int(process.env.VISION_MAX_FRAMES, 5),

  // --- assistant ------------------------------------------------------------
  /**
   * Free-form conversation (lib/assistant.ts). Same OpenAI-compatible endpoint
   * as the vision model but a text model; falls back to VISION_API_KEY so an
   * existing deployment only has to name a CHAT_MODEL to turn it on.
   */
  chatApiKey: process.env.CHAT_API_KEY ?? process.env.VISION_API_KEY ?? '',
  chatApiUrl:
    process.env.CHAT_API_URL ??
    process.env.VISION_API_URL ??
    'https://api.deepseek.com/chat/completions',
  chatModel: process.env.CHAT_MODEL ?? 'deepseek-chat',
  chatTimeoutMs: int(process.env.CHAT_TIMEOUT_MS, 20_000),
  /** Previous turns replayed with each request; bounds the prompt size. */
  chatHistoryTurns: int(process.env.CHAT_HISTORY_TURNS, 8),

  // --- PayPal ---------------------------------------------------------------
  paypalEnv: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
  paypalClientId: process.env.PAYPAL_CLIENT_ID ?? '',
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET ?? '',
  paypalWebhookId: process.env.PAYPAL_WEBHOOK_ID ?? '',
  /** Where members land after approving in the system browser. */
  paypalReturnUrl:
    process.env.PAYPAL_RETURN_URL ?? `${webOrigin}/paypal/return`,
  paypalCancelUrl:
    process.env.PAYPAL_CANCEL_URL ?? `${webOrigin}/paypal/return?cancelled=1`,
  /**
   * "Log in with PayPal" (DEV_PLAN §2.17): the identity return URL registered in
   * the dashboard, the scopes whose user-info fields are ticked there, and the
   * two places the callback hands the browser back to.
   */
  paypalLoginReturnUrl:
    process.env.PAYPAL_LOGIN_RETURN_URL ?? `${publicOrigin}/api/auth/paypal/callback`,
  paypalLoginScopes: process.env.PAYPAL_LOGIN_SCOPES ?? 'openid profile email',
  /**
   * Locale of PayPal's own hosted pages (checkout, sign-in, consent). Set to
   * English so a Thai-locale browser is not served the Thai checkout. BCP 47
   * form — the legacy `locale.x` query pair is derived from it.
   */
  paypalLocale: process.env.PAYPAL_LOCALE ?? 'en-US',
  paypalLoginWebReturnUrl:
    process.env.PAYPAL_LOGIN_WEB_RETURN_URL ?? `${webOrigin}/paypal/login`,
  paypalLoginNativeReturnUrl:
    process.env.PAYPAL_LOGIN_NATIVE_RETURN_URL ?? 'globiekeeper://auth/return',

  /**
   * Optional fee coverage (DEV_PLAN §2.20). Off by default and hard-blocked in
   * live mode, because charging the payer PayPal's fee is a surcharge under the
   * US (§4.5) and Thai *No Surcharges* clauses. The flag below exists so the
   * demo can show it in sandbox and nothing else.
   */
  paypalFeeSchedules: {
    ...DEFAULT_FEE_SCHEDULES,
    ...parseFeeSchedules(process.env.PAYPAL_FEE_SCHEDULES),
  },
  paypalFeeCoverLiveAllowed: bool(process.env.PAYPAL_FEE_COVER_LIVE_ALLOWED, false),

  // --- globie fund ----------------------------------------------------------
  /**
   * The Globie Fund (DEV_PLAN §2.21) is a PayPal account we do not own from the
   * donor's point of view: a donation is an Orders v2 checkout whose payee is
   * this account. `merchant_id` wins when both are set; the label below is what
   * the approval sheet shows as the recipient.
   */
  globieFundPaypalEmail: process.env.GLOBIE_FUND_PAYPAL_EMAIL ?? '',
  globieFundPaypalMerchantId: process.env.GLOBIE_FUND_PAYPAL_MERCHANT_ID ?? '',
  globieFundName: process.env.GLOBIE_FUND_NAME ?? 'Globie Fund',
  /** Charged currency for the PayPal rail. The points peg is expressed in it. */
  globieFundCurrency: (process.env.GLOBIE_FUND_CURRENCY ?? 'USD').toUpperCase(),
  donationMinMinor: int(process.env.DONATION_MIN_MINOR, 100),
  donationMaxMinor: int(process.env.DONATION_MAX_MINOR, 1_000_000),
  /** 1000 Globie = US$1, so one point is one tenth of a cent. */
  pointsPerUsd: int(process.env.POINTS_PER_USD, 1000),

  // --- globie earth MCP -----------------------------------------------------
  /**
   * Tree catalogue + adoption writes (DEV_PLAN §2.21). The public host 404s on
   * `/`; the working transport is JSON-RPC over `POST /mcp` with an
   * `X-Device-Id` header. An empty token keeps the session anonymous, which is
   * what the endpoint accepts today.
   */
  mcpBaseUrl: process.env.MCP_BASE_URL ?? 'https://mcp.globie.earth/mcp',
  mcpBearerToken: process.env.MCP_BEARER_TOKEN ?? '',
  mcpTimeoutMs: int(process.env.MCP_TIMEOUT_MS, 45_000),

  // --- fx ------------------------------------------------------------------
  /**
   * Indicative display rates (DEV_PLAN §2.19). PayPal has no public rate
   * endpoint, so these come from open.er-api.com and are always labelled `≈`.
   */
  fxBase: (process.env.FX_BASE ?? 'THB').toUpperCase(),
  fxRatesUrl: process.env.FX_RATES_URL ?? 'https://open.er-api.com/v6/latest',
  fxCacheTtlMs: int(process.env.FX_CACHE_TTL_MS, 60 * 60 * 1000),

  // --- agent ----------------------------------------------------------------
  /**
   * HMAC key for the agent's confirmation tokens (DEV_PLAN §2.11). Required in
   * production; development falls back to a local constant so the demo runs.
   */
  agentConfirmSecret: process.env.AGENT_CONFIRMATION_SECRET ?? '',

  // --- jobs -----------------------------------------------------------------
  /** pg-boss workers share this process; turn off for one-shot scripts. */
  jobsEnabled: bool(process.env.JOBS_ENABLED, true),
  reminderSweepCron: process.env.REMINDER_SWEEP_CRON ?? '*/5 * * * *',
  outboxSweepCron: process.env.OUTBOX_SWEEP_CRON ?? '* * * * *',

  // --- notifications --------------------------------------------------------
  /**
   * Channel flags. In-app is always on; the rest stay off until credentials
   * exist, so the demo never fails because a provider is missing.
   */
  notifyInApp: bool(process.env.NOTIFY_IN_APP, true),
  notifyEmail: bool(process.env.NOTIFY_EMAIL, false),
  notifyPush: bool(process.env.NOTIFY_PUSH, false),
  notifyWhatsapp: bool(process.env.NOTIFY_WHATSAPP, false),

  /** `smtp://user:pass@host:587` — empty disables the email channel. */
  smtpUrl: process.env.SMTP_URL ?? '',
  mailFrom: process.env.MAIL_FROM ?? 'Globie <no-reply@globie.local>',

  expoPushUrl: process.env.EXPO_PUSH_URL ?? 'https://exp.host/--/api/v2/push/send',

  whatsappApiUrl: process.env.WHATSAPP_API_URL ?? 'https://graph.facebook.com/v21.0',
  whatsappToken: process.env.WHATSAPP_TOKEN ?? '',
  whatsappPhoneId: process.env.WHATSAPP_PHONE_ID ?? '',
} as const;

export const isProduction = config.nodeEnv === 'production';
