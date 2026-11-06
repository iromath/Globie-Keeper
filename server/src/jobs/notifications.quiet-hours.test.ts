/**
 * Quiet hours across a stage boundary (DEV_PLAN §2.13).
 *
 * The stage is chosen when a row is enqueued, but the row is delivered after
 * quiet hours. If the share advances in the meantime the old row is stale: the
 * member would get "due tomorrow" and "due today" in the same pass. The sweep
 * supersedes it instead, and this file proves that against a real database.
 */

import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, describe, it } from 'node:test';

import type { SeededGroup } from './notifications.fixtures.js';

process.env.NOTIFY_IN_APP = 'true';
process.env.NOTIFY_PUSH = 'true';
process.env.NOTIFY_EMAIL = 'false';
process.env.NOTIFY_WHATSAPP = 'false';

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
    res.end(JSON.stringify({ data: [{ status: 'ok', id: `ticket-${hits[message.to]}` }] }));
  });
});

await new Promise<void>((resolve) => expo.listen(0, '127.0.0.1', resolve));
process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(expo.address() as AddressInfo).port}`;

const { closePool, query } = await import('../db/pool.js');
const { guard, seed } = await import('./notifications.fixtures.js');
const { sweep } = await import('./reminders.js');
const { deliverDue } = await import('./outbox.js');

/** 23:00 in Bangkok. */
const NOW = new Date('2026-03-10T16:00:00Z');
/** 09:00 the next morning in Bangkok — the share is now overdue. */
const MORNING = new Date(NOW.getTime() + 10 * 3600_000);

const skip = await guard();
let group: SeededGroup;
let shareId: string;

after(async () => {
  expo.closeAllConnections();
  expo.close();
  if (!skip) await closePool();
});

describe('quiet hours across a stage boundary', { skip }, () => {
  it('writes the in-app nudge now and holds the push until 08:00 local', async () => {
    group = await seed(NOW, [
      {
        email: 'bkk@x.test',
        name: 'Bkk Member',
        tz: 'Asia/Bangkok',
        push: 'ExponentPushToken[bkk]',
        dueOffsetMs: 7 * 3600_000,
      },
    ]);
    shareId = group.members[0]!.shareId;

    assert.equal(await sweep(NOW), 2);

    const push = await query<{ status: string; next_attempt_at: Date }>(
      `select status, next_attempt_at from notification_outbox
        where channel = 'push' and payload ->> 'shareId' = $1`,
      [shareId],
    );
    assert.equal(push.rows.length, 1);
    assert.equal(push.rows[0]!.status, 'queued');
    assert.equal(push.rows[0]!.next_attempt_at.toISOString(), '2026-03-11T01:00:00.000Z');
  });

  it('sends the in-app nudge at night but leaves the push alone', async () => {
    assert.equal(await deliverDue(50, NOW), 1);

    const rows = await query<{ channel: string; status: string }>(
      `select channel, status from notification_outbox
        where payload ->> 'shareId' = $1 order by channel`,
      [shareId],
    );
    assert.deepEqual(rows.rows, [
      { channel: 'in_app', status: 'sent' },
      { channel: 'push', status: 'queued' },
    ]);
  });

  it('supersedes the held nudge when the share moves to the next stage', async () => {
    assert.equal(await sweep(MORNING), 2);

    // The "due tomorrow" push was still waiting for 08:00; it must not survive
    // next to the "due today" one.
    const pushes = await query<{ stage: string; status: string }>(
      `select payload ->> 'stage' as stage, status from notification_outbox
        where channel = 'push' and payload ->> 'shareId' = $1 order by stage`,
      [shareId],
    );
    assert.deepEqual(pushes.rows, [
      { stage: 'due', status: 'queued' },
      { stage: 'due-24h', status: 'dropped' },
    ]);

    const cancelled = await query<{ status: string }>(
      `select status from reminders
        where share_id = $1 and channel = 'push' and idempotency_key like '%:due-24h:push'`,
      [shareId],
    );
    assert.equal(cancelled.rows[0]!.status, 'cancelled');
  });

  it('delivers exactly one push for the share, with the current copy', async () => {
    assert.equal(await deliverDue(50, MORNING), 2);
    assert.equal(hits['ExponentPushToken[bkk]'], 1);

    const rows = await query<{ channel: string; status: string }>(
      `select channel, status from notification_outbox
        where payload ->> 'shareId' = $1 order by channel, status`,
      [shareId],
    );
    assert.deepEqual(rows.rows, [
      { channel: 'in_app', status: 'sent' },
      { channel: 'in_app', status: 'sent' },
      { channel: 'push', status: 'dropped' },
      { channel: 'push', status: 'sent' },
    ]);

    const stale = await query<{ label: string }>(
      `select payload ->> 'label' as label from notification_outbox
        where idempotency_key like '%:due-24h:push' and payload ->> 'shareId' = $1`,
      [shareId],
    );
    assert.equal(stale.rows[0]!.label, 'due tomorrow');

    const current = await query<{ label: string }>(
      `select payload ->> 'label' as label from notification_outbox
        where status = 'sent' and channel = 'push' and payload ->> 'shareId' = $1`,
      [shareId],
    );
    assert.equal(current.rows[0]!.label, 'due today');
  });
});
