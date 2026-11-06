/**
 * Fixtures for the notification integration tests.
 *
 * `sweep()` and `deliverDue()` are almost entirely SQL: stage selection,
 * idempotency keys, `for update skip locked` and the member timezone join only
 * exist inside PostgreSQL. Mocking the pool would test the mocks, so these
 * suites run against a real database instead.
 *
 * Every helper truncates the tables it touches. `guard()` therefore refuses to
 * do anything unless `DATABASE_URL` names a database ending in `_test`, which
 * keeps a stray `.env` from wiping a developer's data.
 */

import { query } from '../db/pool.js';

export type SeedMember = {
  email: string;
  name: string;
  tz: string;
  push?: string | null;
  whatsapp?: string | null;
  /** Offset from the fixture clock; negative means the share is already due. */
  dueOffsetMs: number;
  amount?: number;
  status?: string;
};

export type SeededMember = {
  email: string;
  userId: string;
  memberId: string;
  shareId: string;
};

export type SeededGroup = {
  groupId: string;
  billId: string;
  agreementId: string;
  members: SeededMember[];
};

const TRUNCATE = `
truncate table notification_outbox, notification_events, reminders, ledger_events,
  shares, bills, agreements, members, groups, users restart identity cascade`;

/** Returns a skip reason, or `undefined` when the database is safe to use. */
export async function guard(): Promise<string | undefined> {
  try {
    const { rows } = await query<{ name: string }>('select current_database() as name');
    const name = rows[0]?.name ?? '';
    if (!name.endsWith('_test')) {
      return `refusing to truncate database "${name}" — point DATABASE_URL at a database ending in _test`;
    }
    return undefined;
  } catch (error) {
    return `PostgreSQL is not reachable: ${(error as Error).message}`;
  }
}

/**
 * One group, one accepted THB agreement, one finalized bill, and a share per
 * seed member. `now` is the fixture clock the sweep will be given.
 */
export async function seed(now: Date, members: SeedMember[]): Promise<SeededGroup> {
  await query(TRUNCATE);

  const owner = await query<{ id: string }>(
    `insert into users (email, display_name) values ('owner@x.test', 'Owner') returning id`,
  );
  const ownerId = owner.rows[0]!.id;

  const group = await query<{ id: string }>(
    `insert into groups (name, owner_id, invite_token)
     values ('Koh Samet trip', $1, 'inv-1') returning id`,
    [ownerId],
  );
  const groupId = group.rows[0]!.id;

  const ownerMember = await query<{ id: string }>(
    `insert into members (group_id, user_id, role) values ($1, $2, 'owner') returning id`,
    [groupId, ownerId],
  );

  const agreement = await query<{ id: string }>(
    `insert into agreements (group_id, currency, status, created_by)
     values ($1, 'THB', 'accepted', $2) returning id`,
    [groupId, ownerMember.rows[0]!.id],
  );
  const agreementId = agreement.rows[0]!.id;

  const bill = await query<{ id: string }>(
    `insert into bills (agreement_id, merchant, currency, total, status)
     values ($1, 'Secret Pizza', 'THB', 100000, 'FINALIZED') returning id`,
    [agreementId],
  );
  const billId = bill.rows[0]!.id;

  const seeded: SeededMember[] = [];
  for (const [i, member] of members.entries()) {
    const user = await query<{ id: string }>(
      `insert into users (email, display_name, timezone, push_token, whatsapp_number)
       values ($1, $2, $3, $4, $5) returning id`,
      [member.email, member.name, member.tz, member.push ?? null, member.whatsapp ?? null],
    );
    const row = await query<{ id: string }>(
      `insert into members (group_id, user_id) values ($1, $2) returning id`,
      [groupId, user.rows[0]!.id],
    );
    const share = await query<{ id: string }>(
      `insert into shares (bill_id, member_id, amount, currency, status, due_at)
       values ($1, $2, $3, 'THB', $4, $5) returning id`,
      [
        billId,
        row.rows[0]!.id,
        member.amount ?? 41250 + i,
        member.status ?? 'confirmed',
        new Date(now.getTime() + member.dueOffsetMs),
      ],
    );
    seeded.push({
      email: member.email,
      userId: user.rows[0]!.id,
      memberId: row.rows[0]!.id,
      shareId: share.rows[0]!.id,
    });
  }

  return { groupId, billId, agreementId, members: seeded };
}
