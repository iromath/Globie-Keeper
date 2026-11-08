/**
 * Fixed-window counters for endpoints that guess secrets (DEV_PLAN §2.17).
 *
 * `/auth/session` tests passwords and `/groups/join` tests 6-character invite
 * codes; both need a ceiling on attempts. The API runs as a single container,
 * so an in-memory map is enough — if it is ever scaled out, move this to Redis.
 */

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
/** Bound the map so a flood of distinct keys cannot grow without limit. */
const MAX_KEYS = 10_000;

function prune(now: number): void {
  if (buckets.size <= MAX_KEYS) return;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
  if (buckets.size > MAX_KEYS) buckets.clear();
}

/** Count one attempt; returns false once the window is spent. */
export function consume(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  prune(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  bucket.count = Math.min(bucket.count + 1, limit + 1);
  return bucket.count <= limit;
}

/** Clear a bucket after a success, so one typo does not count toward the cap. */
export function forget(key: string): void {
  buckets.delete(key);
}
