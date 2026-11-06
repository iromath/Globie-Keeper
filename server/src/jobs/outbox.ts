/**
 * Outbox delivery (DEV_PLAN §2.13).
 *
 * pg-boss wakes this worker every minute; it drains `notification_outbox` and
 * hands each row to its channel adapter. Failures are retried with exponential
 * backoff inside the row itself, so a long provider outage never turns into a
 * hot loop, and a dead Expo token falls back to email.
 *
 * Every attempt is logged to `notification_events`.
 */

import { createTransport, type Transporter } from 'nodemailer';
import type { PgBoss } from 'pg-boss';

import { type Db, query, withTransaction } from '../db/pool.js';
import { config } from '../lib/config.js';
import { type Channel, quietHoursEnd } from '../lib/notify.js';

export const OUTBOX_QUEUE = 'notifications-deliver';

const MAX_ATTEMPTS = 5;
const BASE_DELAY_SECONDS = 30;
const MAX_DELAY_SECONDS = 60 * 60;
const PROVIDER_TIMEOUT_MS = 15_000;
/**
 * A claimed row is handed back to the queue if it is still 'sending' after this
 * long, so a worker that died mid-send never strands a notification. It is
 * comfortably longer than a full batch of provider calls (25 × 15 s).
 */
const CLAIM_TIMEOUT_SECONDS = 15 * 60;

type OutboxRow = {
  id: string;
  channel: string;
  recipient: string;
  template: string;
  payload: Record<string, unknown>;
  idempotency_key: string;
  attempts: number;
  member_id: string | null;
  group_id: string | null;
};

/** Failure that carries a machine-readable reason for the retry policy. */
class DeliveryError extends Error {
  constructor(
    message: string,
    readonly code?: 'device_not_registered' | 'not_configured',
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

export async function registerOutboxJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(
    OUTBOX_QUEUE,
    config.outboxSweepCron,
    {},
    { tz: 'UTC', key: 'sweep', missed: 'skip' },
  );

  await boss.work(OUTBOX_QUEUE, async (jobs) => {
    for (const job of jobs) {
      const delivered = await deliverDue();
      if (delivered > 0) console.log(`[jobs] ${job.name} delivered ${delivered} notification(s)`);
    }
  });
}

/** Claims and delivers every due row, returning how many succeeded. */
export async function deliverDue(limit = 25, now = new Date()): Promise<number> {
  const { rows } = await query<OutboxRow>(
    `update notification_outbox
        set status = 'sending', claimed_at = now()
      where id in (
        select id from notification_outbox
         where (status = 'queued' and next_attempt_at <= now())
            or (status = 'sending'
                and coalesce(claimed_at, created_at) < now() - make_interval(secs => $2))
         order by next_attempt_at asc
         limit $1
         for update skip locked
      )
      returning id, channel, recipient, template, payload, idempotency_key,
                attempts, member_id, group_id`,
    [limit, CLAIM_TIMEOUT_SECONDS],
  );

  if (rows.length === 0) return 0;

  // A retry can land in the middle of the night just like a first attempt, so
  // every remote row is checked against the member's clock before sending.
  const timezones = await memberTimezones(rows);

  let delivered = 0;
  for (const row of rows) {
    if (row.channel !== 'in_app') {
      const resumeAt = quietHoursEnd(now, timezones.get(row.member_id ?? '') ?? 'UTC');
      if (resumeAt) {
        // Held without spending an attempt: quiet hours are not a failure.
        await deferUntil(row, resumeAt);
        continue;
      }
    }

    try {
      const result = await send(row);
      await markSent(row, result.providerRef);
      delivered += 1;
    } catch (error) {
      await markFailed(row, error);
    }
  }
  return delivered;
}

/** Member id -> IANA timezone, for the rows claimed in this pass. */
async function memberTimezones(rows: OutboxRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(rows.map((row) => row.member_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();

  const { rows: profiles } = await query<{ id: string; timezone: string }>(
    `select m.id, u.timezone
       from members m
       join users u on u.id = m.user_id
      where m.id = any($1::uuid[])`,
    [ids],
  );
  return new Map(profiles.map((profile) => [profile.id, profile.timezone]));
}

async function deferUntil(row: OutboxRow, resumeAt: Date): Promise<void> {
  await query(
    `update notification_outbox
        set status = 'queued', next_attempt_at = $2, claimed_at = null
      where id = $1 and status = 'sending'`,
    [row.id, resumeAt],
  );
}

async function send(row: OutboxRow): Promise<{ providerRef: string | null }> {
  switch (row.channel as Channel) {
    case 'in_app':
      // The producer already wrote the ledger event the timeline renders; this
      // row exists so the send is logged like every other channel.
      return { providerRef: null };
    case 'push':
      return sendPush(row);
    case 'email':
      return sendEmail(row);
    case 'whatsapp':
      return sendWhatsapp(row);
    default:
      throw new DeliveryError(`unknown channel ${row.channel}`);
  }
}

// --- adapters --------------------------------------------------------------

async function sendPush(row: OutboxRow): Promise<{ providerRef: string | null }> {
  const response = await fetch(config.expoPushUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify([
      {
        to: row.recipient,
        title: 'Globie Keeper',
        body: messageOf(row),
        // `groupId` is what lets a tap land on the right table; the Android
        // handset also needs the channel that was created for the prompt.
        data: {
          shareId: row.payload.shareId ?? null,
          billId: row.payload.billId ?? null,
          groupId: row.payload.groupId ?? null,
        },
        channelId: 'reminders',
      },
    ]),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DeliveryError(`expo push returned ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: { status?: string; id?: string; message?: string; details?: { error?: string } }[];
  };
  const ticket = body.data?.[0];
  if (ticket?.status === 'error') {
    if (ticket.details?.error === 'DeviceNotRegistered') {
      throw new DeliveryError(ticket.message ?? 'push token is no longer registered', 'device_not_registered');
    }
    throw new DeliveryError(ticket.message ?? 'expo push rejected the message');
  }
  return { providerRef: ticket?.id ?? null };
}

let mailer: Transporter | null = null;

/**
 * `SMTP_URL` is `smtp://user:pass@host:587` or `smtps://…:465`. It is expanded
 * here rather than handed to `createTransport` as a string because the
 * second argument is per-message defaults, not transport options — the
 * timeouts have to live on the transport itself.
 */
function transportOptions(url: string) {
  const parsed = new URL(url);
  const secure = parsed.protocol === 'smtps:';
  return {
    host: parsed.hostname,
    port: parsed.port ? Number.parseInt(parsed.port, 10) : secure ? 465 : 587,
    secure,
    ...(parsed.username
      ? { auth: { user: decodeURIComponent(parsed.username), pass: decodeURIComponent(parsed.password) } }
      : {}),
    connectionTimeout: PROVIDER_TIMEOUT_MS,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

function transport(): Transporter {
  if (!config.smtpUrl) throw new DeliveryError('email is not configured', 'not_configured');
  mailer ??= createTransport(transportOptions(config.smtpUrl));
  return mailer;
}

async function sendEmail(row: OutboxRow): Promise<{ providerRef: string | null }> {
  const info = await transport().sendMail({
    from: config.mailFrom,
    to: row.recipient,
    subject: subjectOf(row),
    text: messageOf(row),
  });
  return { providerRef: info.messageId ?? null };
}

async function sendWhatsapp(row: OutboxRow): Promise<{ providerRef: string | null }> {
  if (!config.whatsappToken || !config.whatsappPhoneId) {
    throw new DeliveryError('whatsapp is not configured', 'not_configured');
  }

  // Business-initiated WhatsApp messages normally need an approved template;
  // the demo sends free text inside an open conversation window.
  const response = await fetch(`${config.whatsappApiUrl}/${config.whatsappPhoneId}/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.whatsappToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: row.recipient,
      type: 'text',
      text: { body: messageOf(row) },
    }),
    signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new DeliveryError(`whatsapp returned ${response.status}: ${await response.text()}`);
  }

  const body = (await response.json()) as { messages?: { id?: string }[] };
  return { providerRef: body.messages?.[0]?.id ?? null };
}

// --- bookkeeping -----------------------------------------------------------

function messageOf(row: OutboxRow): string {
  return typeof row.payload.message === 'string' ? row.payload.message : '';
}

function subjectOf(row: OutboxRow): string {
  const group = typeof row.payload.groupName === 'string' ? row.payload.groupName : 'your group';
  const label = typeof row.payload.label === 'string' ? row.payload.label : 'reminder';
  return `Globie Keeper — ${group} share ${label}`;
}

async function markSent(row: OutboxRow, providerRef: string | null): Promise<void> {
  await withTransaction(async (tx) => {
    await tx.query(
      `update notification_outbox
          set status = 'sent', attempts = attempts + 1, last_error = null
        where id = $1`,
      [row.id],
    );
    await logEvent(tx, row, 'sent', providerRef);
    await markReminder(tx, row, 'sent');
  });
}

async function markFailed(row: OutboxRow, error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof DeliveryError ? error.code : undefined;
  const attempts = row.attempts + 1;
  // A dead Expo token will never come back, so retrying it just burns time
  // (and five provider hits) before the email fallback gets its chance.
  const deadToken = code === 'device_not_registered';
  const final = deadToken || attempts >= MAX_ATTEMPTS;

  await withTransaction(async (tx) => {
    if (final) {
      await tx.query(
        `update notification_outbox
            set status = 'failed', attempts = $2, last_error = $3
          where id = $1`,
        [row.id, attempts, message],
      );
      await logEvent(tx, row, 'failed', null);
      await markReminder(tx, row, 'failed');

      // A dead push token is not worth retrying; email is the next viable hop.
      if (deadToken && row.member_id) {
        await tx.query(
          `update users set push_token = null
            where id = (select user_id from members where id = $1)`,
          [row.member_id],
        );
        await queueEmailFallback(tx, row);
      }
      return;
    }

    await tx.query(
      `update notification_outbox
          set status = 'queued', attempts = $2, last_error = $3, claimed_at = null,
              next_attempt_at = now() + make_interval(secs => $4)
        where id = $1`,
      [row.id, attempts, message, Math.min(BASE_DELAY_SECONDS * 2 ** (attempts - 1), MAX_DELAY_SECONDS)],
    );
  });
}

async function logEvent(
  tx: Db,
  row: OutboxRow,
  status: 'sent' | 'failed',
  providerRef: string | null,
): Promise<void> {
  await tx.query(
    `insert into notification_events (channel, template, member_id, status, provider_ref)
     values ($1, $2, $3, $4, $5)`,
    [row.channel, row.template, row.member_id, status, providerRef],
  );
}

async function markReminder(tx: Db, row: OutboxRow, status: 'sent' | 'failed'): Promise<void> {
  const reminderId = typeof row.payload.reminderId === 'string' ? row.payload.reminderId : null;
  if (!reminderId) return;

  if (status === 'sent') {
    await tx.query(
      `update reminders set status = 'sent', sent_at = now()
        where id = $1 and sent_at is null`,
      [reminderId],
    );
    return;
  }
  await tx.query(
    `update reminders set status = 'failed' where id = $1 and status = 'scheduled'`,
    [reminderId],
  );
}

async function queueEmailFallback(tx: Db, row: OutboxRow): Promise<void> {
  if (!config.notifyEmail || !config.smtpUrl || !row.member_id) return;

  const { rows } = await tx.query<{ email: string }>(
    `select u.email from members m join users u on u.id = m.user_id where m.id = $1`,
    [row.member_id],
  );
  const email = rows[0]?.email;
  if (!email) return;

  await tx.query(
    `insert into notification_outbox
       (channel, recipient, template, payload, idempotency_key, member_id, group_id)
     values ('email', $1, $2, $3::jsonb, $4, $5, $6)
     on conflict (idempotency_key) do nothing`,
    [
      email,
      row.template,
      JSON.stringify(row.payload),
      `${row.idempotency_key}:email-fallback`,
      row.member_id,
      row.group_id,
    ],
  );
}
