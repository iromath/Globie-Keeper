/**
 * Reminder sweep and in-app delivery against a real database (DEV_PLAN §2.13).
 *
 * Remote channels are forced off here: this file covers the queue itself —
 * stage selection, idempotency, the ledger event, and the claim/retry
 * bookkeeping — so a red test can never be blamed on a provider.
 *
 * `config` is frozen when `lib/config.ts` is first imported, so the environment
 * is set before the dynamic imports below.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

process.env.NOTIFY_IN_APP = 'true';
process.env.NOTIFY_PUSH = 'false';
process.env.NOTIFY_EMAIL = 'false';
process.env.NOTIFY_WHATSAPP = 'false';

const { closePool, query } = await import('../db/pool.js');
const { guard, seed } = await import('./notifications.fixtures.js');
const { sweep } = await import('./reminders.js');
const { deliverDue } = await import('./outbox.js');

/** 23:00 in Bangkok, 16:00 in UTC — the evening the fixture clock starts on. */
const NOW = new Date('2026-03-10T16:00:00Z');
const HOUR = 3600_000;
const DAY = 24 * HOUR;

const skip = await guard();

after(async () => {
  if (!skip) await closePool();
});

describe('in-app reminder sweep', { skip }, () => {
  it('queues exactly one reminder per share, for the stage the clock reached', async () => {
    await seed(NOW, [
      { email: 'alice@x.test', name: 'Alice Chen', tz: 'UTC', dueOffsetMs: 7 * HOUR },
      { email: 'bob@x.test', name: 'Bob Diaz', tz: 'UTC', dueOffsetMs: -2 * HOUR },
      { email: 'carol@x.test', name: 'Carol Wu', tz: 'UTC', dueOffsetMs: -30 * HOUR },
      { email: 'dave@x.test', name: 'Dave Kim', tz: 'UTC', dueOffsetMs: -5 * DAY },
      { email: 'erin@x.test', name: 'Erin Fox', tz: 'UTC', dueOffsetMs: -20 * DAY },
      { email: 'frank@x.test', name: 'Frank Li', tz: 'UTC', dueOffsetMs: -2 * HOUR, status: 'paid' },
      { email: 'gina@x.test', name: 'Gina Ray', tz: 'UTC', dueOffsetMs: 30 * DAY },
    ]);

    // A paid share and one that is not due for a month must both be skipped.
    assert.equal(await sweep(NOW), 5);

    const stages = await query<{ stage: string; n: number }>(
      `select regexp_replace(idempotency_key, '^reminder:[^:]+:(.*):[a-z_]+$', '\\1') as stage,
              count(*)::int as n
         from reminders group by 1 order by 1`,
    );
    assert.deepEqual(stages.rows, [
      { stage: 'due', n: 1 },
      { stage: 'due-24h', n: 1 },
      { stage: 'late-24h', n: 1 },
      { stage: 'late-72h', n: 1 },
      { stage: 'weekly:2', n: 1 },
    ]);
  });

  it('writes only in-app reminders while the remote channels are off', async () => {
    const channels = await query<{ channel: string; n: number }>(
      `select channel, count(*)::int as n from reminders group by 1`,
    );
    assert.deepEqual(channels.rows, [{ channel: 'in_app', n: 5 }]);

    const outbox = await query<{ status: string; n: number }>(
      `select status, count(*)::int as n from notification_outbox group by 1`,
    );
    assert.deepEqual(outbox.rows, [{ status: 'queued', n: 5 }]);

    const ledger = await query<{ event_type: string; n: number }>(
      `select event_type, count(*)::int as n from ledger_events group by 1`,
    );
    assert.deepEqual(ledger.rows, [{ event_type: 'reminder.sent', n: 5 }]);
  });

  it('is idempotent across re-sweeps of the same stage', async () => {
    assert.equal(await sweep(NOW), 0);
    assert.equal(await sweep(new Date(NOW.getTime() + 6 * HOUR)), 0);

    const reminders = await query<{ n: number }>(`select count(*)::int as n from reminders`);
    assert.equal(reminders.rows[0]!.n, 5);
  });

  it('delivers every queued in-app row and marks the reminders sent', async () => {
    assert.equal(await deliverDue(50, NOW), 5);

    const sent = await query<{ n: number }>(
      `select count(*)::int as n from notification_outbox where status = 'sent'`,
    );
    assert.equal(sent.rows[0]!.n, 5);

    const reminders = await query<{ n: number }>(
      `select count(*)::int as n from reminders where status = 'sent' and sent_at is not null`,
    );
    assert.equal(reminders.rows[0]!.n, 5);

    const events = await query<{ status: string; n: number }>(
      `select status, count(*)::int as n from notification_events group by 1`,
    );
    assert.deepEqual(events.rows, [{ status: 'sent', n: 5 }]);

    assert.equal(await deliverDue(50, NOW), 0);
  });

  it('promotes only the shares that crossed a stage boundary', async () => {
    // 30 h later alice (due-24h -> due), bob (due -> late-24h) and erin
    // (weekly:2 -> weekly:3) cross a boundary; carol and dave stay inside the
    // stage already written. Erin crosses one day earlier than she used to,
    // because weekly stages are now anchored on the due date rather than on
    // due+3d, so the label "N weeks overdue" is literally true.
    assert.equal(await sweep(new Date(NOW.getTime() + 30 * HOUR)), 3);

    const duplicates = await query<{ n: number }>(
      `select count(*)::int as n
         from (select idempotency_key from reminders group by 1 having count(*) > 1) d`,
    );
    assert.equal(duplicates.rows[0]!.n, 0);
  });

  it('reclaims an outbox row left in sending by a dead worker', async () => {
    // `deliverDue()` flips a row to 'sending' before it calls the provider. If
    // the worker dies mid-send the row used to sit there forever; the claim
    // timestamp now lets the next pass take it back after 15 minutes.
    // Retire the rows the previous sweep queued so only the stranded row is due.
    await query(`update notification_outbox set status = 'sent' where status = 'queued'`);
    const stranded = await query<{ id: string }>(
      `insert into notification_outbox
         (channel, recipient, template, payload, idempotency_key, next_attempt_at,
          status, attempts, created_at)
       values ('in_app', 'x', 'reminder', '{}'::jsonb, 'outbox:stranded:1',
               now() - interval '1 hour', 'sending', 1, now() - interval '1 hour')
       returning id`,
    );

    assert.equal(await deliverDue(50, NOW), 1);

    const row = await query<{ status: string; attempts: number }>(
      `select status, attempts from notification_outbox where id = $1`,
      [stranded.rows[0]!.id],
    );
    assert.deepEqual(row.rows[0], { status: 'sent', attempts: 2 });
  });

  it('leaves a freshly claimed row alone', async () => {
    // Nothing else may be due, otherwise this would count the other rows.
    await query(`update notification_outbox set status = 'sent' where status = 'queued'`);
    const claimed = await query<{ id: string }>(
      `insert into notification_outbox
         (channel, recipient, template, payload, idempotency_key, next_attempt_at,
          status, attempts, created_at, claimed_at)
       values ('in_app', 'y', 'reminder', '{}'::jsonb, 'outbox:inflight:1',
               now() - interval '1 hour', 'sending', 0, now() - interval '1 hour', now())
       returning id`,
    );

    assert.equal(await deliverDue(50, NOW), 0);

    const row = await query<{ status: string }>(
      `select status from notification_outbox where id = $1`,
      [claimed.rows[0]!.id],
    );
    assert.equal(row.rows[0]!.status, 'sending');
  });
});
