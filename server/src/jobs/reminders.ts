/**
 * Reminder sweep (DEV_PLAN §2.13).
 *
 * Every few minutes pg-boss wakes this worker, which looks at shares with a due
 * date and queues the stage the clock has reached: T-24h, due date, +24h, +72h,
 * then weekly. Each stage is written once — the `reminders.idempotency_key`
 * unique index is the guard — and delivery is left to `jobs/outbox.ts`, so a
 * quiet-hours hold or a provider outage never loses a nudge.
 */

import type { PgBoss } from 'pg-boss';

import { query, withTransaction } from '../db/pool.js';
import { config } from '../lib/config.js';
import { recordEvent } from '../lib/ledger.js';
import {
    type Channel,
    pickRemoteChannel,
    quietHoursEnd,
    reminderMessage,
    reminderStage,
    type ReminderStage,
} from '../lib/notify.js';
import { formatAmount } from '../lib/paypal.js';
import { markWorkerHeartbeat } from './boss.js';

export const REMINDER_SWEEP = 'reminders-sweep';

type Candidate = {
  share_id: string;
  bill_id: string;
  agreement_id: string;
  group_id: string;
  group_name: string;
  member_id: string;
  member_name: string;
  email: string | null;
  push_token: string | null;
  whatsapp_number: string | null;
  timezone: string;
  amount: number;
  currency: string;
  due_at: Date;
};

type ReminderPayload = {
  shareId: string;
  billId: string;
  groupId: string;
  stage: string;
  label: string;
  tone: string;
  message: string;
  amountMinor: number;
  currency: string;
  groupName: string;
};

export async function registerReminderJobs(boss: PgBoss): Promise<void> {
  await boss.schedule(
    REMINDER_SWEEP,
    config.reminderSweepCron,
    {},
    { tz: 'UTC', key: 'sweep', missed: 'once' },
  );

  await boss.work(REMINDER_SWEEP, async (jobs) => {
    for (const job of jobs) {
      const queued = await sweep();
      markWorkerHeartbeat();
      console.log(`[jobs] ${job.name} queued ${queued} reminder(s)`);
    }
  });
}

/** One pass over every unpaid share that has a due date. */
export async function sweep(now = new Date()): Promise<number> {
  const { rows } = await query<Candidate>(
    `select s.id as share_id, s.bill_id, s.amount, s.currency, s.due_at,
            a.id as agreement_id, a.group_id, g.name as group_name,
            s.member_id, u.display_name as member_name, u.email,
            u.push_token, u.whatsapp_number, u.timezone
       from shares s
       join bills b on b.id = s.bill_id
       join agreements a on a.id = b.agreement_id
       join groups g on g.id = a.group_id
       join members m on m.id = s.member_id
       join users u on u.id = m.user_id
      where s.due_at is not null
        and s.status in ('proposed', 'confirmed', 'requested', 'failed')
        and m.status = 'active'
        and b.status in ('FINALIZED', 'COLLECTING')
      order by s.due_at asc
      limit 500`,
  );

  let queued = 0;
  for (const share of rows) {
    const stage = reminderStage(now, share.due_at);
    if (!stage) continue;
    queued += await queueReminder(share, stage, now);
  }
  return queued;
}

async function queueReminder(share: Candidate, stage: ReminderStage, now: Date): Promise<number> {
  const currency = share.currency.trim();
  const message = reminderMessage({
    firstName: share.member_name.split(' ')[0] ?? share.member_name,
    amount: formatAmount(share.amount, currency),
    currency,
    groupName: share.group_name,
    tone: stage.tone,
  });

  const disabled = await disabledChannels(share.member_id);
  const remote = pickRemoteChannel(
    {
      memberId: share.member_id,
      email: share.email,
      pushToken: share.push_token,
      whatsappNumber: share.whatsapp_number,
    },
    disabled,
  );

  // In-app is silent, so it is written now; anything that can buzz a phone waits
  // until the member is out of quiet hours.
  const remoteAt = quietHoursEnd(now, share.timezone) ?? now;

  const payload: ReminderPayload = {
    shareId: share.share_id,
    billId: share.bill_id,
    groupId: share.group_id,
    stage: stage.key,
    label: stage.label,
    tone: stage.tone,
    message,
    amountMinor: share.amount,
    currency,
    groupName: share.group_name,
  };

  let queued = 0;
  await withTransaction(async (tx) => {
    if (!disabled.has('in_app') && config.notifyInApp) {
      const reminderId = await insertReminder(tx, share, stage, 'in_app', message, now);
      if (reminderId) {
        await insertOutbox(tx, {
          channel: 'in_app',
          recipient: share.member_id,
          memberId: share.member_id,
          groupId: share.group_id,
          reminderId,
          idSuffix: 'in_app',
          payload,
          nextAttemptAt: now,
        });
        // The in-app nudge is the ledger event the group timeline renders.
        await recordEvent(tx, {
          groupId: share.group_id,
          agreementId: share.agreement_id,
          shareId: share.share_id,
          memberId: share.member_id,
          eventType: 'reminder.sent',
          amountMinor: share.amount,
          currency,
          actor: 'Globie',
          summary: `Globie nudged ${share.member_name} (${stage.label})`,
          metadata: { source: 'scheduler', stage: stage.key, tone: stage.tone },
        });
        queued += 1;
      }
    }

    if (remote) {
      const reminderId = await insertReminder(tx, share, stage, remote.channel, message, remoteAt);
      if (reminderId) {
        await insertOutbox(tx, {
          channel: remote.channel,
          recipient: remote.recipient,
          memberId: share.member_id,
          groupId: share.group_id,
          reminderId,
          idSuffix: remote.channel,
          payload,
          nextAttemptAt: remoteAt,
        });
        queued += 1;
      }
    }

    // A share that moved on to a later stage must not deliver the nudge that
    // was still waiting for quiet hours to lift — that is how one member got
    // "due tomorrow" and "due today" in the same pass. Only the newest pending
    // row per share survives.
    await supersedeStaleOutbox(tx, share.share_id, stage.key);
  });

  return queued;
}

/**
 * Drops queued outbox rows for an older stage of the same share. `'dropped'`
 * is in the status enum for exactly this: the notification was superseded
 * before it ever left the queue.
 */
async function supersedeStaleOutbox(
  tx: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  shareId: string,
  stageKey: string,
): Promise<void> {
  await tx.query(
    `with stale as (
       update notification_outbox
          set status = 'dropped', claimed_at = null
        where status = 'queued'
          and idempotency_key like 'outbox:reminder:' || $1 || ':%'
          and coalesce(payload ->> 'stage', '') <> $2
        returning nullif(payload ->> 'reminderId', '')::uuid as reminder_id
     )
     update reminders r
        set status = 'cancelled'
       from stale
      where r.id = stale.reminder_id
        and r.status = 'scheduled'`,
    [shareId, stageKey],
  );
}

async function disabledChannels(memberId: string): Promise<Set<Channel>> {
  const { rows } = await query<{ channel: Channel }>(
    `select channel from notification_preferences where member_id = $1 and enabled = false`,
    [memberId],
  );
  return new Set(rows.map((row) => row.channel));
}

async function insertReminder(
  tx: { query: (text: string, values?: unknown[]) => Promise<{ rows: { id: string }[] }> },
  share: Candidate,
  stage: ReminderStage,
  channel: Channel,
  message: string,
  scheduledFor: Date,
): Promise<string | null> {
  const { rows } = await tx.query(
    `insert into reminders
       (share_id, scheduled_for, channel, template, message, idempotency_key, status)
     values ($1, $2, $3, 'reminder', $4, $5, 'scheduled')
     on conflict (idempotency_key) do nothing
     returning id`,
    [
      share.share_id,
      scheduledFor,
      channel,
      message,
      `reminder:${share.share_id}:${stage.key}:${channel}`,
    ],
  );
  return rows[0]?.id ?? null;
}

async function insertOutbox(
  tx: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  input: {
    channel: Channel;
    recipient: string;
    memberId: string;
    groupId: string;
    reminderId: string;
    idSuffix: string;
    payload: ReminderPayload;
    nextAttemptAt: Date;
  },
): Promise<void> {
  await tx.query(
    `insert into notification_outbox
       (channel, recipient, template, payload, idempotency_key, member_id, group_id, next_attempt_at)
     values ($1, $2, 'reminder', $3::jsonb, $4, $5, $6, $7)
     on conflict (idempotency_key) do nothing`,
    [
      input.channel,
      input.recipient,
      JSON.stringify({ reminderId: input.reminderId, ...input.payload }),
      `outbox:reminder:${input.payload.shareId}:${input.payload.stage}:${input.idSuffix}`,
      input.memberId,
      input.groupId,
      input.nextAttemptAt,
    ],
  );
}
