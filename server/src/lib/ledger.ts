import type { Db } from '../db/pool.js';

export type LedgerInput = {
  groupId: string | null;
  agreementId?: string | null;
  shareId?: string | null;
  memberId?: string | null;
  eventType: string;
  amountMinor?: number;
  currency?: string | null;
  actor: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

/**
 * Append to the event history that powers the chat-style group timeline.
 * Callers pass their transaction client so the event lands with the change.
 */
export async function recordEvent(db: Db, input: LedgerInput): Promise<void> {
  await db.query(
    `insert into ledger_events
       (group_id, agreement_id, share_id, member_id, event_type, amount_minor, currency, metadata)
     values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      input.groupId,
      input.agreementId ?? null,
      input.shareId ?? null,
      input.memberId ?? null,
      input.eventType,
      input.amountMinor ?? 0,
      input.currency ?? null,
      JSON.stringify({
        actor: input.actor,
        summary: input.summary,
        ...input.metadata,
      }),
    ],
  );
}
