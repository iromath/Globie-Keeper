import type { FastifyPluginAsync } from 'fastify';

import { isUniqueViolation, query, withTransaction } from '../db/pool.js';
import { requireMember } from '../lib/access.js';
import { ApiError } from '../lib/http-error.js';
import { createInviteCode } from '../lib/ids.js';
import { recordEvent } from '../lib/ledger.js';
import {
    mapAgreement,
    mapBill,
    mapGroup,
    mapMember,
    mapSettledRate,
    type AgreementRow,
    type BillItemRow,
    type BillRow,
    type GroupRow,
    type MemberRow,
} from '../lib/serialize.js';
import {
    asRecord,
    currencyCode,
    pathUuid,
    requiredString,
} from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

type GroupParams = { Params: { id: string } };

type MemberListRow = MemberRow;

type MyGroupRow = GroupRow & {
  role: string;
  member_count: number;
};

type TimelineRow = {
  time: Date;
  event_id: string;
  event_type: string;
  amount_minor: number;
  metadata: Record<string, unknown> | null;
};

type LeaderboardQueryRow = {
  member_id: string;
  member_name: string;
  fronted_minor: number;
  globie_balance: number;
  avg_hours: number | null;
};

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

async function loadMembers(groupId: string): Promise<MemberListRow[]> {
  const { rows } = await query<MemberListRow>(
    `select m.id, m.group_id, m.user_id, u.display_name, m.role, m.status
       from members m
       join users u on u.id = m.user_id
      where m.group_id = $1 and m.status <> 'removed'
      order by m.joined_at asc`,
    [groupId],
  );
  return rows;
}

async function loadLatestAgreement(
  groupId: string,
): Promise<AgreementRow | null> {
  const { rows } = await query<AgreementRow>(
    `select a.id, a.group_id, a.currency, a.estimated_total, a.deadline,
            a.status, a.created_by, a.fronted_by,
            (select count(*) from agreement_acceptances aa
              where aa.agreement_id = a.id) as accepted_count,
            (select count(*) from members m
              where m.group_id = a.group_id and m.status <> 'removed') as member_count
       from agreements a
      where a.group_id = $1
      order by a.created_at desc
      limit 1`,
    [groupId],
  );
  return rows[0] ?? null;
}

async function loadLatestBill(
  groupId: string,
): Promise<{ bill: BillRow; items: BillItemRow[] } | null> {
  const { rows } = await query<BillRow>(
    `select b.*
       from bills b
       join agreements a on a.id = b.agreement_id
      where a.group_id = $1
      order by b.created_at desc
      limit 1`,
    [groupId],
  );
  const bill = rows[0];
  if (!bill) return null;

  const items = await query<BillItemRow>(
    `select id, name, qty, unit_price, line_total, confidence
       from bill_items where bill_id = $1 order by created_at asc`,
    [bill.id],
  );
  return { bill, items: items.rows };
}

export const groupRoutes: FastifyPluginAsync = async (app) => {
  /** Create a group; the caller becomes its owner and first member. */
  app.post('/groups', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const name = requiredString(body, 'name', { min: 2, max: 80 });
    const currency = currencyCode(body.currency);

    return withTransaction(async (tx) => {
      let group: GroupRow | null = null;

      for (let attempt = 0; attempt < 3 && !group; attempt += 1) {
        try {
          const { rows } = await tx.query<GroupRow>(
            `insert into groups (name, default_currency, owner_id, invite_token)
             values ($1, $2, $3, $4)
             returning id, name, default_currency, owner_id, invite_token, created_at`,
            [name, currency, auth.userId, createInviteCode()],
          );
          group = rows[0] ?? null;
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }

      if (!group) {
        throw new ApiError(500, 'invite_code_failed', 'Could not allocate an invite code');
      }

      const { rows: memberRows } = await tx.query<MemberRow>(
        `insert into members (group_id, user_id, role, status)
         values ($1, $2, 'owner', 'active')
         returning id, group_id, user_id, role, status`,
        [group.id, auth.userId],
      );
      const member = memberRows[0];
      if (!member) {
        throw new ApiError(500, 'member_insert_failed', 'Could not add the owner');
      }

      await recordEvent(tx, {
        groupId: group.id,
        memberId: member.id,
        eventType: 'system.group.created',
        actor: auth.displayName,
        summary: `${auth.displayName} started "${group.name}"`,
      });

      return {
        group: mapGroup(group),
        member: mapMember({ ...member, display_name: auth.displayName }),
      };
    });
  });

  /** Join by invite code. Idempotent for members who already belong. */
  app.post('/groups/join', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const inviteToken = requiredString(body, 'inviteToken', { min: 4, max: 16 })
      .toUpperCase();
    const displayName = requiredString(body, 'displayName', { min: 1, max: 80 });

    const { rows: groupRows } = await query<GroupRow>(
      `select id, name, default_currency, owner_id, invite_token, created_at
         from groups
        where upper(invite_token) = $1`,
      [inviteToken],
    );
    const group = groupRows[0];
    if (!group) {
      throw ApiError.notFound('No group matches that invite code');
    }

    await query(`update users set display_name = $1 where id = $2`, [
      displayName,
      auth.userId,
    ]);

    const { rows: existingRows } = await query<MemberRow>(
      `select m.id, m.group_id, m.user_id, u.display_name, m.role, m.status
         from members m join users u on u.id = m.user_id
        where m.group_id = $1 and m.user_id = $2`,
      [group.id, auth.userId],
    );
    const existing = existingRows[0];
    if (existing) {
      if (existing.status === 'removed') {
        await query(`update members set status = 'active' where id = $1`, [existing.id]);
      }
      return {
        group: mapGroup(group),
        member: mapMember({ ...existing, display_name: displayName }),
      };
    }

    return withTransaction(async (tx) => {
      const { rows } = await tx.query<MemberRow>(
        `insert into members (group_id, user_id, role, status)
         values ($1, $2, 'member', 'active')
         returning id, group_id, user_id, role, status`,
        [group.id, auth.userId],
      );
      const member = rows[0];
      if (!member) {
        throw new ApiError(500, 'member_insert_failed', 'Could not join the group');
      }

      await recordEvent(tx, {
        groupId: group.id,
        memberId: member.id,
        eventType: 'member.joined',
        actor: displayName,
        summary: `${displayName} joined the group`,
      });

      return {
        group: mapGroup(group),
        member: mapMember({ ...member, display_name: displayName }),
      };
    });
  });

  /**
   * Every table this member belongs to, newest first. Without it the app could
   * only show a group created or joined in the current sitting, so signing back
   * in looked like the memberships had been lost.
   */
  app.get('/groups', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<MyGroupRow>(
      `select g.id, g.name, g.default_currency, g.owner_id, g.invite_token, g.created_at,
              m.role,
              (select count(*) from members x
                where x.group_id = g.id and x.status <> 'removed')::int as member_count
         from members m
         join groups g on g.id = m.group_id
        where m.user_id = $1 and m.status <> 'removed'
        order by g.created_at desc`,
      [auth.userId],
    );

    return {
      groups: rows.map((row) => ({
        ...mapGroup(row),
        role: row.role,
        memberCount: row.member_count,
      })),
    };
  });

  /** Everything the group screen renders in one round trip. */
  app.get<GroupParams>('/groups/:id', async (request) => {
    const groupId = pathUuid(request.params.id);
    const member = await requireMember(request, groupId);

    const { rows: groupRows } = await query<GroupRow>(
      `select id, name, default_currency, owner_id, invite_token, created_at
         from groups where id = $1`,
      [groupId],
    );
    const group = groupRows[0];
    if (!group) throw ApiError.notFound('Group not found');

    const [members, agreementRow, billRow] = await Promise.all([
      loadMembers(groupId),
      loadLatestAgreement(groupId),
      loadLatestBill(groupId),
    ]);

    const me = members.find((entry) => entry.id === member.id) ?? {
      id: member.id,
      group_id: member.groupId,
      user_id: member.userId,
      display_name: member.displayName,
      role: member.role,
      status: member.status,
    };

    return {
      group: mapGroup(group),
      members: members.map(mapMember),
      agreement: agreementRow ? mapAgreement(agreementRow) : null,
      bill: billRow ? mapBill(billRow.bill, billRow.items) : null,
      me: mapMember(me),
    };
  });

  /** Chat-style history. Newest 100 events, oldest first. */
  app.get<GroupParams>('/groups/:id/timeline', async (request) => {
    const groupId = pathUuid(request.params.id);
    await requireMember(request, groupId);

    const { rows } = await query<TimelineRow>(
      `select time, event_id, event_type, amount_minor, metadata
         from ledger_events
        where group_id = $1
        order by time desc
        limit 100`,
      [groupId],
    );

    const events = rows
      .slice()
      .reverse()
      .map((row) => {
        const metadata = row.metadata ?? {};
        const actor =
          typeof metadata.actor === 'string' && metadata.actor
            ? metadata.actor
            : 'Globie';
        const summary =
          typeof metadata.summary === 'string' && metadata.summary
            ? metadata.summary
            : row.event_type;

        const settledRate = mapSettledRate(metadata);

        return {
          id: row.event_id,
          at: iso(row.time),
          actor,
          type: row.event_type,
          summary,
          ...(row.amount_minor > 0 ? { amountMinor: row.amount_minor } : {}),
          ...(settledRate ? { settledRate } : {}),
        };
      });

    return { events };
  });

  /** Rolling 30-day Hero board: fronted cash, Globie balance, repayment speed. */
  app.get<GroupParams>('/groups/:id/leaderboard', async (request) => {
    const groupId = pathUuid(request.params.id);
    await requireMember(request, groupId);

    const { rows } = await query<LeaderboardQueryRow>(
      `select m.id as member_id,
              u.display_name as member_name,
              coalesce(fronted.total, 0)::bigint as fronted_minor,
              coalesce(points.total, 0)::bigint as globie_balance,
              repaid.avg_hours::double precision as avg_hours
         from members m
         join users u on u.id = m.user_id
         left join lateral (
           select sum(b.total) as total
             from agreements a
             join bills b on b.agreement_id = a.id
            where a.fronted_by = m.id
              and b.created_at > now() - interval '30 days'
         ) fronted on true
         left join lateral (
           select sum(pa.delta) as total
             from points_awards pa
            where pa.member_id = m.id
         ) points on true
         left join lateral (
           select avg(extract(epoch from (s.paid_at - s.created_at)) / 3600.0) as avg_hours
             from shares s
             join bills b on b.id = s.bill_id
             join agreements a on a.id = b.agreement_id
            where s.member_id = m.id
              -- The person who fronted a bill has nothing to repay on it, so their
              -- own share would otherwise read as an instant 0h repayment.
              and a.fronted_by <> m.id
              and s.paid_at is not null
              and s.paid_at > now() - interval '30 days'
         ) repaid on true
        where m.group_id = $1 and m.status <> 'removed'
        order by fronted_minor desc, globie_balance desc, u.display_name asc`,
      [groupId],
    );

    const topFronted = rows[0]?.fronted_minor ?? 0;

    return {
      rows: rows.map((row) => ({
        memberId: row.member_id,
        memberName: row.member_name,
        frontedMinor: row.fronted_minor,
        globieBalance: row.globie_balance,
        repaymentSpeedHours:
          row.avg_hours === null ? null : Math.round(row.avg_hours * 10) / 10,
        isHero: row.fronted_minor > 0 && row.fronted_minor === topFronted,
      })),
    };
  });
};
