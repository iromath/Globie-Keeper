/**
 * Demo seed (DEV_PLAN §2.14).
 *
 * Explicit command only — `npm run seed` — never part of deploy or boot. It
 * wipes and rebuilds the three demo accounts so running it twice is safe.
 *
 * Everything here obeys the same invariants as the API: money is integer minor
 * units, every bill line is split with `allocate()` so nothing is invented or
 * lost, the shares add up to the bill total, and the paid share carries the
 * `share.paid` ledger event the leaderboard reads.
 */

import { closePool, withTransaction } from '../server/src/db/pool.js';
import { allocate } from '../server/src/lib/money.js';
import { hashPassword } from '../server/src/lib/password.js';

const CURRENCY = 'THB';
const INVITE_TOKEN = 'KHAOSI';
/** Shared password for the three demo accounts; printed at the end of the run. */
const DEMO_PASSWORD = 'globie-demo';

const ACCOUNTS = [
  { key: 'ana', email: 'ana@example.com', name: 'Ana', role: 'owner' },
  { key: 'ben', email: 'ben@example.com', name: 'Ben', role: 'member' },
  { key: 'chai', email: 'chai@example.com', name: 'Chai', role: 'member' },
] as const;

type AccountKey = (typeof ACCOUNTS)[number]['key'];

/**
 * Six lines from one receipt. `split` maps a member to how many units of that
 * line they had; the line total is allocated across those weights.
 */
const ITEMS: Array<{
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
  split: Partial<Record<AccountKey, number>>;
}> = [
  {
    name: 'Khao Soi Gai',
    qty: 2,
    unitPrice: 18_000,
    total: 36_000,
    split: { ana: 1, ben: 1 },
  },
  {
    name: 'Khao Soi Nuea',
    qty: 1,
    unitPrice: 22_000,
    total: 22_000,
    split: { chai: 1 },
  },
  {
    name: 'Sai Ua (northern sausage)',
    qty: 1,
    unitPrice: 15_000,
    total: 15_000,
    split: { ana: 1, ben: 1, chai: 1 },
  },
  {
    name: 'Nam Manao',
    qty: 3,
    unitPrice: 6_000,
    total: 18_000,
    split: { ana: 1, ben: 2 },
  },
  {
    name: 'Khao Niao',
    qty: 2,
    unitPrice: 3_500,
    total: 7_000,
    split: { ana: 1, chai: 1 },
  },
  {
    name: 'Mango Sticky Rice',
    qty: 2,
    unitPrice: 5_000,
    total: 10_000,
    split: { ben: 1, chai: 1 },
  },
];

const DAY = 86_400_000;
const ago = (days: number, hours = 0) => new Date(Date.now() - days * DAY - hours * 3_600_000);
const ahead = (days: number) => new Date(Date.now() + days * DAY);
const money = (minor: number) => (minor / 100).toFixed(2);

type LedgerSeed = {
  at: Date;
  type: string;
  actor: string;
  summary: string;
  amountMinor?: number;
  member?: AccountKey;
  share?: AccountKey;
  metadata?: Record<string, unknown>;
};

async function clearDemo(tx: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
}): Promise<void> {
  const groups = await tx.query(
    `select distinct g.id
       from groups g
       join members m on m.group_id = g.id
       join users u on u.id = m.user_id
      where lower(u.email) = any($1::text[])`,
    [ACCOUNTS.map((account) => account.email)],
  );
  const groupIds = groups.rows.map((row) => row.id as string);

  if (groupIds.length > 0) {
    const members = await tx.query(
      `select id from members where group_id = any($1::uuid[])`,
      [groupIds],
    );
    const memberIds = members.rows.map((row) => row.id as string);

    // Hypertables and outbox rows carry no cascading foreign key, so they go
    // first; deleting the group then takes bills, shares and reminders with it.
    await tx.query(`delete from ledger_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from points_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from agent_events where group_id = any($1::uuid[])`, [groupIds]);
    await tx.query(`delete from notification_events where member_id = any($1::uuid[])`, [
      memberIds,
    ]);
    await tx.query(`delete from notification_outbox where group_id = any($1::uuid[])`, [
      groupIds,
    ]);
    await tx.query(`delete from groups where id = any($1::uuid[])`, [groupIds]);
  }

  await tx.query(`delete from users where lower(email) = any($1::text[])`, [
    ACCOUNTS.map((account) => account.email),
  ]);
}

async function seed(): Promise<void> {
  await withTransaction(async (tx) => {
    await clearDemo(tx);

    const userIds = new Map<AccountKey, string>();
    // Hashing once is fine: all three demo accounts share the same password.
    const passwordHash = await hashPassword(DEMO_PASSWORD);
    for (const account of ACCOUNTS) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into users (email, display_name, timezone, whatsapp_number, password_hash, password_updated_at)
         values ($1, $2, 'Asia/Bangkok', null, $3, now())
         returning id`,
        [account.email, account.name, passwordHash],
      );
      userIds.set(account.key, rows[0]!.id);
    }

    const anaId = userIds.get('ana')!;

    const group = await tx.query<{ id: string }>(
      `insert into groups (name, default_currency, owner_id, invite_token)
       values ('Khao Soi Crew', $1, $2, $3)
       returning id`,
      [CURRENCY, anaId, INVITE_TOKEN],
    );
    const groupId = group.rows[0]!.id;

    const memberIds = new Map<AccountKey, string>();
    for (const [index, account] of ACCOUNTS.entries()) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into members (group_id, user_id, role, paypal_email, status, joined_at)
         values ($1, $2, $3, $4, 'active', $5)
         returning id`,
        [
          groupId,
          userIds.get(account.key),
          account.role,
          account.key === 'ana' ? 'ana@example.com' : null,
          ago(3, -index),
        ],
      );
      memberIds.set(account.key, rows[0]!.id);
    }

    const deadline = ahead(2);
    const agreement = await tx.query<{ id: string }>(
      `insert into agreements
         (group_id, currency, estimated_total, deadline, terms_snapshot, status,
          created_by, fronted_by, created_at)
       values ($1, $2, 120000, $3, $4::jsonb, 'accepted', $5, $5, $6)
       returning id`,
      [
        groupId,
        CURRENCY,
        deadline,
        JSON.stringify({
          version: 'v1',
          rule: 'Everyone accepts the terms before the receipt is uploaded.',
          settle_window: 'Pay your share within 7 days of the bill being locked.',
        }),
        memberIds.get('ana'),
        ago(3),
      ],
    );
    const agreementId = agreement.rows[0]!.id;

    for (const [index, account] of ACCOUNTS.entries()) {
      await tx.query(
        `insert into agreement_acceptances (agreement_id, member_id, accepted_at, consent_version)
         values ($1, $2, $3, 'v1')`,
        [agreementId, memberIds.get(account.key), ago(3, -(3 + index))],
      );
    }

    const billTotal = 120_000;
    const bill = await tx.query<{ id: string }>(
      `insert into bills
         (agreement_id, merchant, currency, subtotal, tax, service_charge, tip, discount,
          total, status, frames_extracted, parsed_at, warnings, created_at)
       values ($1, 'Khao Soi Mae Sai', $2, 108000, 0, 10800, 1200, 0,
               $3, 'COLLECTING', 1, $4, '[]'::jsonb, $5)
       returning id`,
      // $4 is parsed_at, $5 is created_at — upload first, parse a little later.
      [agreementId, CURRENCY, billTotal, ago(2, 4), ago(2, 5)],
    );
    const billId = bill.rows[0]!.id;

    const perMember = new Map<AccountKey, number>();
    for (const item of ITEMS) {
      const { rows } = await tx.query<{ id: string }>(
        `insert into bill_items
           (bill_id, name, qty, unit_price, line_total, confidence, source_frame, created_at)
         values ($1, $2, $3, $4, $5, 0.96, 1, $6)
         returning id`,
        [billId, item.name, item.qty, item.unitPrice, item.total, ago(2, 4)],
      );
      const itemId = rows[0]!.id;

      const holders = Object.keys(item.split) as AccountKey[];
      const parts = allocate(
        item.total,
        holders.map((key) => item.split[key] ?? 0),
      );

      for (const [index, key] of holders.entries()) {
        const amount = parts[index] ?? 0;
        await tx.query(
          `insert into allocations (bill_item_id, member_id, qty, amount, status, created_at)
           values ($1, $2, $3, $4, 'confirmed', $5)`,
          [itemId, memberIds.get(key), item.split[key] ?? 1, amount, ago(2, 3)],
        );
        perMember.set(key, (perMember.get(key) ?? 0) + amount);
      }
    }

    const shares = new Map<AccountKey, { id: string; amount: number }>();

    // Service charge, tax, tip and any unassigned remainder land on the fronter,
    // exactly as `POST /bills/:id/finalize` does, so the shares add to the total.
    const lineTotal = [...perMember.values()].reduce((sum, amount) => sum + amount, 0);
    const gap = billTotal - lineTotal;
    if (gap < 0) {
      throw new Error(`seed split is ${money(-gap)} THB over the bill total`);
    }
    if (gap > 0) {
      perMember.set('ana', (perMember.get('ana') ?? 0) + gap);
    }

    const splitTotal = [...perMember.values()].reduce((sum, amount) => sum + amount, 0);
    if (splitTotal !== billTotal) {
      throw new Error(`seed split adds up to ${splitTotal}, expected ${billTotal}`);
    }

    for (const account of ACCOUNTS) {
      const amount = perMember.get(account.key) ?? 0;
      // Ana paid first, so her share is settled and carries the repayment clock.
      const isPaid = account.key === 'ana';
      // Ana repaid 18 hours after the split locked — the clock the Hero board reads.
      const createdAt = ago(2, 1);
      const { rows } = await tx.query<{ id: string }>(
        `insert into shares
           (bill_id, member_id, amount, currency, status, paypal_order_id,
            paypal_approve_url, due_at, paid_at, created_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         returning id`,
        [
          billId,
          memberIds.get(account.key),
          amount,
          CURRENCY,
          isPaid ? 'paid' : account.key === 'ben' ? 'requested' : 'confirmed',
          isPaid ? null : account.key === 'ben' ? 'DEMO-BEN-ORDER' : null,
          isPaid
            ? null
            : account.key === 'ben'
              ? 'https://www.sandbox.paypal.com/checkoutnow?token=DEMO-BEN-ORDER'
              : null,
          deadline,
          isPaid ? ago(1, 7) : null,
          createdAt,
        ],
      );
      shares.set(account.key, { id: rows[0]!.id, amount });
    }

    await tx.query(
      `insert into payments (share_id, provider, provider_ref, amount, currency, status, raw_payload)
       values ($1, 'paypal', 'DEMO-CAPTURE-ANA', $2, $3, 'completed', $4::jsonb)`,
      [
        shares.get('ana')!.id,
        shares.get('ana')!.amount,
        CURRENCY,
        JSON.stringify({ id: 'DEMO-CAPTURE-ANA', status: 'COMPLETED', demo: true }),
      ],
    );
    await tx.query(
      `insert into payments (share_id, provider, provider_ref, amount, currency, status)
       values ($1, 'paypal', 'DEMO-BEN-ORDER', $2, $3, 'pending')`,
      [shares.get('ben')!.id, shares.get('ben')!.amount, CURRENCY],
    );

    // Ana repaid within 18 hours, which is what the Hero board reads.
    await tx.query(
      `insert into points_awards (agreement_id, member_id, reason, delta, created_at)
       values ($1, $2, 'globie', 10, $3)`,
      [agreementId, memberIds.get('ana'), ago(1, 7)],
    );
    await tx.query(
      `insert into points_events (time, group_id, member_id, delta, reason, agreement_id, share_id)
       values ($1, $2, $3, 10, 'globie', $4, $5)`,
      [
        ago(1, 7),
        groupId,
        memberIds.get('ana'),
        agreementId,
        shares.get('ana')!.id,
      ],
    );

    await tx.query(
      `insert into reminders
         (share_id, scheduled_for, sent_at, channel, template, message, idempotency_key, status)
       values ($1, $2, $2, 'in_app', 'reminder', $3, 'seed:reminder:chai:24h', 'sent')`,
      [
        shares.get('chai')!.id,
        ago(1),
        `Chai, the ${money(shares.get('chai')!.amount)} THB share for Khao Soi Crew is still open — pay when you can.`,
      ],
    );

    const ledger: LedgerSeed[] = [
      {
        at: ago(3),
        type: 'system.group.created',
        actor: 'Ana',
        summary: 'Ana started "Khao Soi Crew"',
        member: 'ana',
      },
      {
        at: ago(3, -1),
        type: 'member.joined',
        actor: 'Ben',
        summary: 'Ben joined the group',
        member: 'ben',
      },
      {
        at: ago(3, -2),
        type: 'member.joined',
        actor: 'Chai',
        summary: 'Chai joined the group',
        member: 'chai',
      },
      {
        at: ago(3, -3),
        type: 'agreement.created',
        actor: 'Ana',
        summary: 'Ana opened an agreement — everyone agrees before anyone pays',
        amountMinor: billTotal,
        member: 'ana',
      },
      {
        at: ago(3, -4),
        type: 'agreement.accepted',
        actor: 'Ben',
        summary: 'Ben accepted the terms',
        member: 'ben',
      },
      {
        at: ago(3, -5),
        type: 'agreement.accepted',
        actor: 'Chai',
        summary: 'Chai accepted the terms',
        member: 'chai',
      },
      {
        at: ago(2, 5),
        type: 'bill.uploaded',
        actor: 'Ana',
        summary: 'Ana photographed the receipt from Khao Soi Mae Sai',
        member: 'ana',
      },
      {
        at: ago(2, 4),
        type: 'bill.parsed',
        actor: 'Globie',
        summary: 'Globie read 6 items from the receipt',
        amountMinor: billTotal,
        member: 'ana',
      },
      {
        at: ago(2, 3),
        type: 'bill.allocated',
        actor: 'Globie',
        summary: 'Globie proposed who had what',
        member: 'ana',
      },
      {
        at: ago(2, 2),
        type: 'bill.confirmed',
        actor: 'Ben',
        summary: 'Everyone confirmed their own lines',
        member: 'ben',
      },
      {
        at: ago(2, 1),
        type: 'bill.finalized',
        actor: 'Globie',
        summary: `Shares locked: 3 people, ${money(billTotal)} THB`,
        amountMinor: billTotal,
        member: 'ana',
      },
      {
        at: ago(1, 12),
        type: 'share.requested',
        actor: 'Ben',
        summary: `Ben was asked for ${money(shares.get('ben')!.amount)} THB`,
        amountMinor: shares.get('ben')!.amount,
        member: 'ben',
        share: 'ben',
      },
      {
        at: ago(1, 7),
        type: 'share.paid',
        actor: 'Ana',
        summary: `Ana paid ${money(shares.get('ana')!.amount)} THB`,
        amountMinor: shares.get('ana')!.amount,
        member: 'ana',
        share: 'ana',
        metadata: { hours_to_pay: 18 },
      },
      {
        at: ago(1),
        type: 'reminder.sent',
        actor: 'Globie',
        summary: `Globie nudged Chai — ${money(shares.get('chai')!.amount)} THB still open`,
        amountMinor: shares.get('chai')!.amount,
        member: 'chai',
        share: 'chai',
        metadata: { tone: 'friendly' },
      },
    ];

    for (const entry of ledger) {
      await tx.query(
        `insert into ledger_events
           (time, group_id, agreement_id, share_id, member_id, event_type,
            amount_minor, currency, metadata)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [
          entry.at,
          groupId,
          agreementId,
          entry.share ? shares.get(entry.share)!.id : null,
          entry.member ? memberIds.get(entry.member) : null,
          entry.type,
          entry.amountMinor ?? 0,
          CURRENCY,
          JSON.stringify({
            actor: entry.actor,
            summary: entry.summary,
            ...entry.metadata,
          }),
        ],
      );
    }

    console.log(`[seed] group   Khao Soi Crew (invite ${INVITE_TOKEN})`);
    console.log(`[seed] members ${ACCOUNTS.map((account) => account.name).join(', ')}`);
    console.log(
      `[seed] bill    ${money(billTotal)} THB — ${ACCOUNTS.map(
        (account) => `${account.name} ${money(shares.get(account.key)!.amount)}`,
      ).join(', ')}`,
    );
  });
}

// `db/` sits outside the `server` package, so this file loads as CJS under
// tsx — hence an async entry point instead of top-level await.
async function main(): Promise<void> {
  try {
    await seed();
    console.log(
      `[seed] done. Sign in as ana@example.com, ben@example.com or chai@example.com — password ${DEMO_PASSWORD}`,
    );
  } catch (error) {
    console.error('[seed] failed', error);
    process.exitCode = 1;
  } finally {
    await closePool();
  }
}

void main();
