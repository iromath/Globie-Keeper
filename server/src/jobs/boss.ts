/**
 * pg-boss lifecycle (DEV_PLAN §2.14).
 *
 * The workers run inside the API process so a single `docker compose up`
 * brings the whole demo online; `JOBS_ENABLED=false` turns them off for
 * one-shot scripts. Every queue is created explicitly, because pg-boss 12
 * refuses to deliver to a queue that was never declared.
 */

import { PgBoss } from 'pg-boss';

import { config } from '../lib/config.js';
import { OUTBOX_QUEUE, registerOutboxJobs } from './outbox.js';
import { REMINDER_SWEEP, registerReminderJobs } from './reminders.js';

let boss: PgBoss | null = null;
let lastHeartbeatAt: Date | null = null;

/** How long a worker may go without a sweep before `/health` calls it stale. */
const HEARTBEAT_STALE_MS = 15 * 60 * 1000;

export function jobsRunning(): boolean {
  return boss !== null;
}

/** Called by each worker pass, so `/health` can prove the scheduler is alive. */
export function markWorkerHeartbeat(now = new Date()): void {
  lastHeartbeatAt = now;
}

export type WorkerStatus = {
  ok: boolean;
  enabled: boolean;
  running: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
};

export function workerStatus(now = Date.now()): WorkerStatus {
  const last = lastHeartbeatAt;
  const age = last ? now - last.getTime() : null;
  const ok = !config.jobsEnabled || (boss !== null && age !== null && age <= HEARTBEAT_STALE_MS);

  return {
    ok,
    enabled: config.jobsEnabled,
    running: boss !== null,
    lastHeartbeatAt: last ? last.toISOString() : null,
    heartbeatAgeSeconds: age === null ? null : Math.round(age / 1000),
  };
}

export async function startJobs(): Promise<void> {
  if (!config.jobsEnabled || boss) return;

  const instance = new PgBoss({
    connectionString: config.databaseUrl,
    application_name: 'globie-keeper-jobs',
    // One worker per queue in this process, so the pool stays small.
    max: 4,
  });

  instance.on('error', (error) => console.error('[jobs] pg-boss error', error));

  await instance.start();

  await instance.createQueue(REMINDER_SWEEP, { retryLimit: 1, deleteAfterSeconds: 60 * 60 });
  await instance.createQueue(OUTBOX_QUEUE, { retryLimit: 1, deleteAfterSeconds: 60 * 60 });

  await registerReminderJobs(instance);
  await registerOutboxJobs(instance);

  boss = instance;
  markWorkerHeartbeat();
  console.log('[jobs] reminder sweep and outbox delivery started');
}

export async function stopJobs(): Promise<void> {
  const instance = boss;
  boss = null;
  if (!instance) return;
  await instance.stop({ graceful: true, timeout: 5_000 });
  console.log('[jobs] stopped');
}
