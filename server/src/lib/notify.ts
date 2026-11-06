/**
 * Reminder cadence, quiet hours and channel choice (DEV_PLAN §2.13).
 *
 * Shared by the scheduled sweep in `jobs/reminders.ts` and by the agent's
 * `send_reminder` tool so both produce the same copy.
 */

import { config } from './config.js';

export type Channel = 'in_app' | 'push' | 'email' | 'whatsapp';
export type ReminderTone = 'friendly' | 'firm' | 'final';

/** Fallback order from the plan: cheapest and quietest first. */
export const FALLBACK_ORDER: Channel[] = ['in_app', 'push', 'email', 'whatsapp'];

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const QUIET_START = 22;
const QUIET_END = 8;

export type ReminderStage = {
  /** Stable id used in idempotency keys: `due-24h`, `late-72h`, `weekly:2`. */
  key: string;
  tone: ReminderTone;
  /** Human phrasing for the ledger summary. */
  label: string;
};

/**
 * How many complete weeks past due we keep nudging. The ladder used to be
 * unbounded, so an abandoned share drifted into the feed as "28 weeks overdue"
 * — and wrote a fresh `reminders` row every week forever.
 */
const MAX_WEEKLY_STAGES = 4;

/**
 * The stage that is due right now: T-24h, the due date, 1–3 days late, 3–7 days
 * late, then a weekly nudge anchored on the due date. The ladder stops after
 * `MAX_WEEKLY_STAGES` complete weeks so a forgotten share goes quiet.
 *
 * Only the latest crossed boundary is returned, so a worker that was down for a
 * week sends one urgent nudge instead of replaying five stale ones.
 */
export function reminderStage(now: Date, dueAt: Date): ReminderStage | null {
  const t = now.getTime();
  const due = dueAt.getTime();

  if (t < due - DAY) return null;
  if (t < due) return { key: 'due-24h', tone: 'friendly', label: 'due tomorrow' };
  if (t < due + DAY) return { key: 'due', tone: 'friendly', label: 'due today' };

  const daysLate = Math.floor((t - due) / DAY);
  if (daysLate < 3) return { key: 'late-24h', tone: 'firm', label: 'overdue' };

  // Anchored on the due date: "N weeks overdue" means N complete weeks. The old
  // ladder counted from due+3d, so `weekly:1` first fired on day 10 and the
  // label under-reported how late the share actually was.
  const week = Math.floor(daysLate / 7);
  if (week === 0) return { key: 'late-72h', tone: 'final', label: `${daysLate} days overdue` };
  if (week > MAX_WEEKLY_STAGES) return null;

  return {
    key: `weekly:${week}`,
    tone: 'final',
    label: `${week} week${week === 1 ? '' : 's'} overdue`,
  };
}

const clockFormatters = new Map<string, Intl.DateTimeFormat>();

/** Seconds since local midnight, so the quiet-hours boundary is exact. */
function secondsIntoDay(now: Date, timeZone: string): number {
  let formatter = clockFormatters.get(timeZone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    } catch {
      formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'UTC',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      });
    }
    clockFormatters.set(timeZone, formatter);
  }

  const parts = formatter.formatToParts(now);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number.parseInt(parts.find((part) => part.type === type)?.value ?? '0', 10) || 0;
  return read('hour') * 3600 + read('minute') * 60 + read('second');
}

/**
 * Quiet hours are 22:00–08:00 in the member's timezone. Returns the instant
 * sending may resume, or `null` when it is already allowed.
 *
 * The boundary is exact, so a reminder held overnight lands at 08:00 local
 * rather than drifting by however long the sweep has been running. A DST change
 * inside the window can still shift it by an hour — harmless for a nudge.
 */
export function quietHoursEnd(now: Date, timeZone: string): Date | null {
  const elapsed = secondsIntoDay(now, timeZone);
  const hour = Math.floor(elapsed / 3600);
  if (hour >= QUIET_END && hour < QUIET_START) return null;

  const target = QUIET_END * 3600;
  const wait = target - elapsed + (target <= elapsed ? 24 * 3600 : 0);
  return new Date(now.getTime() + wait * 1000);
}

/** Whether the deployment can deliver on this channel at all. */
export function channelEnabled(channel: Channel): boolean {
  switch (channel) {
    case 'in_app':
      return config.notifyInApp;
    case 'push':
      return config.notifyPush;
    case 'email':
      return config.notifyEmail && Boolean(config.smtpUrl);
    case 'whatsapp':
      return config.notifyWhatsapp && Boolean(config.whatsappToken && config.whatsappPhoneId);
  }
}

export type ReminderRecipient = {
  memberId: string;
  email: string | null;
  pushToken: string | null;
  whatsappNumber: string | null;
};

/**
 * One remote channel per reminder — the best one this member actually has.
 * In-app is queued separately, so web-only members end up with in-app + email.
 */
export function pickRemoteChannel(
  member: ReminderRecipient,
  disabled: ReadonlySet<Channel>,
): { channel: Channel; recipient: string } | null {
  for (const channel of ['push', 'email', 'whatsapp'] as const) {
    if (disabled.has(channel) || !channelEnabled(channel)) continue;
    const recipient =
      channel === 'push'
        ? member.pushToken
        : channel === 'email'
          ? member.email
          : member.whatsappNumber;
    if (recipient) return { channel, recipient };
  }
  return null;
}

export function reminderMessage(input: {
  firstName: string;
  amount: string;
  currency: string;
  groupName: string;
  tone: string;
}): string {
  const { firstName, amount, currency, groupName, tone } = input;
  const sum = `${amount} ${currency}`;
  if (tone === 'firm') {
    return `${firstName}, your ${sum} share for ${groupName} is still open. Please pay it today so the group can close this bill.`;
  }
  if (tone === 'final') {
    return `${firstName}, final reminder: the ${sum} share for ${groupName} is still outstanding. The group cannot close this bill until it is paid.`;
  }
  return `${firstName}, a gentle nudge — your ${sum} share for ${groupName} is still open. Pay it in the app when you get a moment.`;
}
