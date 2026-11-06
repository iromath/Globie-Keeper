/**
 * Push delivery, retry backoff and dead-token fallback (DEV_PLAN §2.13).
 *
 * The push adapter is exercised against a local HTTP server that speaks the
 * Expo push protocol, so the real `fetch`, the real ticket parsing and the
 * real retry policy run end to end. Email is enabled only because a dead
 * token is supposed to queue an email fallback; nothing ever connects to the
 * SMTP host.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import type { SeededGroup } from './notifications.fixtures.js';

process.env.NOTIFY_IN_APP = 'true';
process.env.NOTIFY_PUSH = 'true';
process.env.NOTIFY_EMAIL = 'true';
process.env.NOTIFY_WHATSAPP = 'false';
process.env.SMTP_URL = 'smtp://globie:globie@127.0.0.1:1025';

const hits: Record<string, number> = {};

const expo = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const message = (JSON.parse(body) as { to: string }[])[0]!;
    hits[message.to] = (hits[message.to] ?? 0) + 1;
    res.setHeader('content-type', 'application/json');
    if (message.to === 'ExponentPushToken[dead]') {
      res.end(
        JSON.stringify({
          data: [
            {
              status: 'error',
              details: { error: 'DeviceNotRegistered' },
              message: 'not registered',
            },
          ],
        }),
      );
    } else if (message.to === 'ExponentPushToken[flaky]') {
      res.statusCode = 500;
      res.end('{"error":"boom"}');
    } else {
      res.end(JSON.stringify({ data: [{ status: 'ok', id: `ticket-${hits[message.to]}` }] }));
    }
  });
});

await new Promise<void>((resolve) => expo.listen(0, '127.0.0.1', resolve));
process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;

const { closePool, query } = await import('../db/pool.js');
const { guard, seed } = await import('./notifications.fixtures.js');
const { sweep } = await import('./reminders.js');
const { deliverDue } = await import('./outbox.js');

const NOW = new Date('2026-03-10T16:00:00Z');
/**
 * 20:00 UTC — late evening in UTC, but 03:00 in Bangkok, so the member whose
 * push was deferred at sweep time is still asleep when delivery runs.
 */
const AWAKE = new Date('2026-03-10T20:00:00Z');
/** Midnight in Bangkok, 17:00 UTC the day before. */
const BKK_MIDNIGHT = new Date('2026-03-10T17:00:00Z');

const skip = await guard();
let group: SeededGroup;

after(async () => {
  expo.closeAllConnections();
  expo.close();
  if (!skip) await closePool();
});

describe('push delivery', { skip }, () => {
  it('queues in-app plus push and defers the member who is asleep', async () => {
    group = await seed(NOW, [
      { email: 'ok@x.test', name: 'Ok Member', tz: 'UTC', push: 'ExponentPushToken[ok]', dueOffsetMs: -2 * 3600_000 },
      { email: 'dead@x.test', name: 'Dead Member', tz: 'UTC', push: 'ExponentPushToken[dead]', dueOffsetMs: -2 * 3600_000 },
      { email: 'flaky@x.test', name: 'Flaky Member', tz: 'UTC', push: 'ExponentPushToken[flaky]', dueOffsetMs: -2 * 3600_000 },
      { email: 'bkk@x.test', name: 'Bkk Member', tz: 'Asia/Bangkok', push: 'ExponentPushToken[bkk]', dueOffsetMs: -2 * 3600_000 },
    ]);

    assert.equal(await sweep(NOW), 8);

    const pushes = await query<{ recipient: string; next_attempt_at: Date }>(
      `select recipient, next_attempt_at from notification_outbox
        where channel = 'push' order by recipient`,
    );
    assert.deepEqual(
      pushes.rows.map((row) => row.recipient),
      [
        'ExponentPushToken[bkk]',
        'ExponentPushToken[dead]',
        'ExponentPushToken[flaky]',
        'ExponentPushToken[ok]',
      ],
    );

    const byToken = (token: string) => pushes.rows.find((row) => row.recipient === `ExponentPushToken[${token}]`)!;
    // 23:00 in Bangkok: the nudge waits until 08:00 local, the next morning.
    assert.equal(byToken('bkk').next_attempt_at.toISOString(), '2026-03-11T01:00:00.000Z');
    // 16:00 in UTC is awake, so the row is due immediately.
    assert.equal(byToken('ok').next_attempt_at.toISOString(), NOW.toISOString());
  });

  it('delivers awake members and requeues the two failures', async () => {
    // 4 in-app nudges + the ok push. Dead and flaky throw (not counted) and
    // the Bangkok row is claimed but held, because it is 03:00 for that member.
    assert.equal(await deliverDue(50, AWAKE), 5);

    const rows = await query<{ recipient: string; status: string; attempts: number; last_error: string | null }>(
      `select recipient, status, attempts, last_error from notification_outbox
        where channel = 'push'`,
    );
    const byToken = (token: string) => rows.rows.find((row) => row.recipient === `ExponentPushToken[${token}]`)!;

    assert.deepEqual(
      { status: byToken('ok').status, attempts: byToken('ok').attempts },
      { status: 'sent', attempts: 1 },
    );
    assert.match(byToken('flaky').last_error ?? '', /500/);
    assert.match(byToken('dead').last_error ?? '', /not registered/);
    assert.equal(byToken('flaky').status, 'queued');
    assert.equal(byToken('flaky').attempts, 1);
  });

  it('fails a dead token immediately, clears it and queues an email fallback', async () => {
    // A token Expo says is gone will never come back, so retrying it burns
    // five provider hits before the email fallback gets its chance.
    const dead = await query<{ status: string; attempts: number }>(
      `select status, attempts from notification_outbox where recipient = 'ExponentPushToken[dead]'`,
    );
    assert.deepEqual(dead.rows[0], { status: 'failed', attempts: 1 });
    assert.equal(hits['ExponentPushToken[dead]'], 1);

    const token = await query<{ push_token: string | null }>(
      `select u.push_token from users u where u.email = 'dead@x.test'`,
    );
    assert.equal(token.rows[0]!.push_token, null);

    const fallback = await query<{
      channel: string;
      recipient: string;
      status: string;
      idempotency_key: string;
    }>(
      `select channel, recipient, status, idempotency_key from notification_outbox
        where idempotency_key like '%:email-fallback'`,
    );
    assert.equal(fallback.rows.length, 1);
    assert.equal(fallback.rows[0]!.recipient, 'dead@x.test');
    assert.ok(fallback.rows[0]!.idempotency_key.startsWith('outbox:reminder:'));
    assert.ok(fallback.rows[0]!.idempotency_key.endsWith(':push:email-fallback'));

    // No SMTP server is running here, so take the fallback out of the queue
    // before the backoff loop below starts claiming rows.
    await query(`update notification_outbox set status = 'dropped'
                  where idempotency_key like '%:email-fallback'`);
  });

  it('backs off exponentially and gives up after five attempts', async () => {
    const gaps: number[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await query(`update notification_outbox set next_attempt_at = now() - interval '1 second'
                    where channel = 'push' and status = 'queued'`);
      const before = Date.now();
      await deliverDue(50, AWAKE);

      const row = await query<{ status: string; next_attempt_at: Date }>(
        `select status, next_attempt_at from notification_outbox
          where recipient = 'ExponentPushToken[flaky]'`,
      );
      if (row.rows[0]!.status === 'queued') {
        gaps.push(Math.round((row.rows[0]!.next_attempt_at.getTime() - before) / 1000));
      }
    }

    // The 30 s delay after the first failure is not in this window: each gap is
    // measured after a later failure, so the visible sequence is 60/120/240.
    assert.equal(gaps.length, 3);
    assert.ok(Math.abs(gaps[0]! - 60) <= 3, `first gap was ${gaps[0]}s`);
    assert.ok(Math.abs(gaps[1]! - 120) <= 3, `second gap was ${gaps[1]}s`);
    assert.ok(Math.abs(gaps[2]! - 240) <= 3, `third gap was ${gaps[2]}s`);

    const final = await query<{ recipient: string; status: string; attempts: number }>(
      `select recipient, status, attempts from notification_outbox
        where channel = 'push' and recipient in ('ExponentPushToken[dead]', 'ExponentPushToken[flaky]')
        order by recipient`,
    );
    assert.deepEqual(final.rows, [
      { recipient: 'ExponentPushToken[dead]', status: 'failed', attempts: 1 },
      { recipient: 'ExponentPushToken[flaky]', status: 'failed', attempts: 5 },
    ]);
    assert.equal(hits['ExponentPushToken[flaky]'], 5);
  });

  it('keeps the in-app ledger independent of push failures', async () => {
    const inApp = await query<{ n: number }>(
      `select count(*)::int as n from notification_outbox
        where channel = 'in_app' and status = 'sent'`,
    );
    assert.equal(inApp.rows[0]!.n, 4);

    const failedReminders = await query<{ n: number }>(
      `select count(*)::int as n from reminders where channel = 'push' and status = 'failed'`,
    );
    assert.equal(failedReminders.rows[0]!.n, 2);

    // `markFailed()` only writes a `failed` event on the terminal attempt, so the
    // ledger has one row per push that ultimately failed (dead on its 1st attempt,
    // flaky on its 5th) rather than one per provider hit.
    const events = await query<{ n: number }>(
      `select count(*)::int as n from notification_events
        where channel = 'push' and status = 'failed'`,
    );
    assert.equal(events.rows[0]!.n, 2);
  });

  it('holds a retry that lands inside the member quiet hours', async () => {
    const bkk = group.members.find((member) => member.email === 'bkk@x.test')!;
    const queued = await query<{ id: string }>(
      `insert into notification_outbox
         (channel, recipient, template, payload, idempotency_key, member_id,
          next_attempt_at, status, attempts)
       values ('push', 'ExponentPushToken[bkk]', 'reminder',
               '{"message":"night nudge"}'::jsonb, 'outbox:quietretry:1', $1,
               now() - interval '1 minute', 'queued', 0)
       returning id`,
      [bkk.memberId],
    );

    // Midnight in Bangkok. The row is due, but the member is asleep.
    assert.equal(await deliverDue(50, BKK_MIDNIGHT), 0);

    const row = await query<{ status: string; attempts: number; next_attempt_at: Date; claimed_at: Date | null }>(
      `select status, attempts, next_attempt_at, claimed_at from notification_outbox where id = $1`,
      [queued.rows[0]!.id],
    );
    assert.equal(row.rows[0]!.status, 'queued');
    // Being asleep is not a delivery failure: no attempt is spent.
    assert.equal(row.rows[0]!.attempts, 0);
    assert.equal(row.rows[0]!.next_attempt_at.toISOString(), '2026-03-11T01:00:00.000Z');
    assert.equal(row.rows[0]!.claimed_at, null);
  });
});
