import type { FastifyPluginAsync } from 'fastify';

import { query } from '../db/pool.js';
import { reissueDeadCheckout } from '../lib/bills.js';
import { feeCoverAllowed } from '../lib/fees.js';
import { ApiError } from '../lib/http-error.js';
import { channelEnabled, FALLBACK_ORDER, type Channel } from '../lib/notify.js';
import { mapSettledRate, mapShare, type ShareRow } from '../lib/serialize.js';
import { reconcileShare } from '../lib/settlement.js';
import {
    asRecord,
    currencyCode,
    optionalBoolean,
    optionalEmail,
    optionalMerchantId,
    optionalPaypalMeHandle,
    paymentMode,
    requiredString
} from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

type ActivityRow = {
  time: Date;
  event_id: string;
  event_type: string;
  amount_minor: number;
  currency: string;
  metadata: Record<string, unknown> | null;
  group_id: string;
  group_name: string;
};

/** Currency to show when the member has no open shares yet. */
async function fallbackCurrency(userId: string): Promise<string> {
  const { rows } = await query<{ default_currency: string }>(
    `select g.default_currency
       from members m
       join groups g on g.id = m.group_id
      where m.user_id = $1 and m.status <> 'removed'
      order by m.joined_at asc
      limit 1`,
    [userId],
  );

  const row = rows[0];
  return row ? row.default_currency.trim() : 'THB';
}

/**
 * Consent lives on `notification_preferences` per *member*, because reminders
 * are decided per share. The screen edits it per user, so a channel reads as on
 * unless one of the user's memberships turned it off.
 */
async function notificationSettings(userId: string) {
  const { rows } = await query<{ channel: string; enabled: boolean }>(
    `select p.channel, bool_and(p.enabled) as enabled
       from notification_preferences p
       join members m on m.id = p.member_id
      where m.user_id = $1
      group by p.channel`,
    [userId],
  );

  const off = new Set(rows.filter((row) => !row.enabled).map((row) => row.channel));

  const profile = await query<{ push_token: string | null }>(
    `select push_token from users where id = $1`,
    [userId],
  );

  return {
    channels: FALLBACK_ORDER.map((channel) => ({
      channel,
      enabled: !off.has(channel),
      available: channelEnabled(channel),
    })),
    pushRegistered: Boolean(profile.rows[0]?.push_token),
  };
}

export const meRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Profile plus the display-currency preference (DEV_PLAN §2.19) and the
   * PayPal address that reimbursements settle into.
   */
  app.get('/me', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<{
      display_currency: string | null;
      paypal_payer_id: string | null;
      paypal_email: string | null;
      paypal_merchant_id: string | null;
      paypal_mode: string | null;
      paypal_me_handle: string | null;
      cover_paypal_fee: boolean | null;
    }>(
      `select u.display_currency, u.paypal_payer_id,
              (select max(coalesce(m.paypal_email, u.paypal_email))
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_email,
              (select max(m.paypal_merchant_id)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_merchant_id,
              (select max(m.paypal_mode)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_mode,
              (select max(m.paypal_me_handle)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_me_handle,
              (select max(m.cover_paypal_fee::int) = 1
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as cover_paypal_fee
         from users u
        where u.id = $1`,
      [auth.userId],
    );

    const row = rows[0];

    return {
      userId: auth.userId,
      email: auth.email,
      displayName: auth.displayName,
      displayCurrency: row?.display_currency?.trim() ?? null,
      paypalLinked: Boolean(row?.paypal_payer_id),
      paypalEmail: row?.paypal_email?.trim() ?? null,
      paypalMerchantId: row?.paypal_merchant_id?.trim() ?? null,
      paypalMode: row?.paypal_mode === 'paypal_me' ? 'paypal_me' : 'payee_direct',
      paypalMeHandle: row?.paypal_me_handle?.trim() ?? null,
      /**
       * DEV_PLAN §2.20. Only meaningful when the feature is permitted in this
       * environment; a stored `true` reads as `false` while live mode refuses it,
       * because no order will actually carry the fee.
       */
      coverPaypalFee: Boolean(row?.cover_paypal_fee) && feeCoverAllowed(),
    };
  });

  /**
   * Display currency is presentation only: it changes how amounts are rendered,
   * never what is stored or charged. `null` clears the override, so the client
   * falls back to the device or group currency.
   *
   * `paypalEmail` and `paypalMerchantId` say where members reimburse the
   * fronter, so both are written to every active membership — that is what
   * `requestPaymentForShare` reads. The merchant id wins when both are set.
   *
   * `paypalMode` splits the two ways to get paid: `payee_direct` needs a
   * Business-style account that can be a payee on an order, while `paypal_me`
   * works with any personal account through a PayPal.Me link.
   */
  app.patch('/me', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);

    if ('displayCurrency' in body) {
      const requested = body.displayCurrency;
      const displayCurrency =
        requested === undefined || requested === null || requested === ''
          ? null
          : currencyCode(requested, 'displayCurrency');

      await query(`update users set display_currency = $2 where id = $1`, [
        auth.userId,
        displayCurrency,
      ]);
    }

    // These five live on the membership, so a user with no group has nothing to
    // write to. Say so instead of accepting the change and silently dropping it.
    if (
      ['paypalEmail', 'paypalMerchantId', 'paypalMode', 'paypalMeHandle', 'coverPaypalFee'].some(
        (key) => key in body,
      )
    ) {
      const { rows } = await query(
        `select 1 from members where user_id = $1 and status <> 'removed' limit 1`,
        [auth.userId],
      );
      if (rows.length === 0) {
        throw ApiError.conflict(
          'no_membership',
          'Join a group first — payment details apply to every group you are in.',
        );
      }
    }

    if ('paypalEmail' in body) {
      const paypalEmail = optionalEmail(body, 'paypalEmail');

      await query(
        `update members set paypal_email = $2
          where user_id = $1 and status <> 'removed'`,
        [auth.userId, paypalEmail],
      );
    }

    if ('paypalMerchantId' in body) {
      const paypalMerchantId = optionalMerchantId(body, 'paypalMerchantId');

      await query(
        `update members set paypal_merchant_id = $2
          where user_id = $1 and status <> 'removed'`,
        [auth.userId, paypalMerchantId],
      );
    }

    if ('paypalMode' in body) {
      const mode = paymentMode(body, 'paypalMode');

      await query(
        `update members set paypal_mode = $2
          where user_id = $1 and status <> 'removed'`,
        [auth.userId, mode],
      );
    }

    if ('paypalMeHandle' in body) {
      const handle = optionalPaypalMeHandle(body, 'paypalMeHandle');

      await query(
        `update members set paypal_me_handle = $2
          where user_id = $1 and status <> 'removed'`,
        [auth.userId, handle],
      );
    }

    /**
     * DEV_PLAN §2.20. Opt-in per fronter, off unless they ask for it. Asking is
     * refused outright in live mode: passing PayPal's fee to the payer is a
     * surcharge under both the US (§4.5) and Thai "No Surcharges" clauses.
     */
    if ('coverPaypalFee' in body) {
      const cover = optionalBoolean(body, 'coverPaypalFee');

      if (cover && !feeCoverAllowed()) {
        throw new ApiError(
          403,
          'fee_cover_not_permitted',
          "Covering the PayPal fee can't be turned on here — PayPal's user agreement for this market does not allow passing the fee to the payer.",
        );
      }

      await query(
        `update members set cover_paypal_fee = $2
          where user_id = $1 and status <> 'removed'`,
        [auth.userId, cover],
      );
    }

    const { rows } = await query<{
      display_currency: string | null;
      paypal_email: string | null;
      paypal_merchant_id: string | null;
      paypal_mode: string | null;
      paypal_me_handle: string | null;
      cover_paypal_fee: boolean | null;
    }>(
      `select u.display_currency,
              (select max(coalesce(m.paypal_email, u.paypal_email))
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_email,
              (select max(m.paypal_merchant_id)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_merchant_id,
              (select max(m.paypal_mode)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_mode,
              (select max(m.paypal_me_handle)
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as paypal_me_handle,
              (select max(m.cover_paypal_fee::int) = 1
                 from members m
                where m.user_id = u.id and m.status <> 'removed') as cover_paypal_fee
         from users u
        where u.id = $1`,
      [auth.userId],
    );

    return {
      userId: auth.userId,
      displayCurrency: rows[0]?.display_currency?.trim() ?? null,
      paypalEmail: rows[0]?.paypal_email?.trim() ?? null,
      paypalMerchantId: rows[0]?.paypal_merchant_id?.trim() ?? null,
      paypalMode: rows[0]?.paypal_mode === 'paypal_me' ? 'paypal_me' : 'payee_direct',
      paypalMeHandle: rows[0]?.paypal_me_handle?.trim() ?? null,
      coverPaypalFee: Boolean(rows[0]?.cover_paypal_fee) && feeCoverAllowed(),
    };
  });

  /** Everything this user still owes, across every group, oldest deadline first. */
  app.get('/me/shares', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<ShareRow>(
      `select s.id, s.bill_id, b.agreement_id, a.group_id, g.name as group_name,
              s.member_id, u.display_name as member_name, s.amount, s.currency,
              s.status, s.due_at, s.paid_at, s.created_at,
              s.paypal_order_id, s.paypal_approve_url, s.payment_mode,
              s.fee_minor, s.gross_minor, s.late_fee_minor,
              fu.display_name as fronter_name
         from shares s
         join bills b on b.id = s.bill_id
         join agreements a on a.id = b.agreement_id
         join groups g on g.id = a.group_id
         join members m on m.id = s.member_id
         join users u on u.id = m.user_id
         left join members fm on fm.id = a.fronted_by
         left join users fu on fu.id = fm.user_id
        where m.user_id = $1
          and m.status <> 'removed'
          and s.status not in ('paid', 'settled', 'refunded')
        order by s.due_at asc nulls last, s.created_at asc`,
      [auth.userId],
    );

    // These are the caller's own shares, so every `requested` row is a checkout
    // they opened. Re-read those orders: a refusal at PayPal's page never comes
    // back to us, and the row would otherwise say "Payment requested" forever.
    const shares = await Promise.all(
      rows.map(async (row) => {
        const state = await reconcileShare(row);
        if (state.status === 'failed') {
          // The checkout died under the member. Mint a replacement instead of
          // handing back a balance with no way to pay it; when no order can be
          // made the row stays `failed` and the list says so, as it always has.
          const fresh = await reissueDeadCheckout({
            share: row,
            actor: { memberId: row.member_id, displayName: 'Globie Keeper' },
          });
          if (fresh) {
            return mapShare(
              {
                ...row,
                status: fresh.status,
                paypal_approve_url: fresh.approveUrl,
                payment_mode: fresh.paymentMode,
                fee_minor: fresh.feeMinor,
                gross_minor: fresh.grossMinor,
                late_fee_minor: fresh.lateFeeMinor,
              },
              false,
            );
          }
        }
        return mapShare(
          {
            ...row,
            status: state.status,
            // A checkout that ended without a payment leaves no usable link, and
            // this row was read before reconcileShare could clear it.
            paypal_approve_url: state.status === 'failed' ? null : row.paypal_approve_url,
          },
          state.canFinish,
        );
      }),
    );
    // What the member still owes, late fee included: the fee is charged when
    // the fronter asks for the money, so it is part of the outstanding balance.
    const outstandingMinor = shares.reduce(
      (sum, share) => sum + share.amountMinor + share.lateFeeMinor,
      0,
    );
    const currency = shares.length > 0 ? shares[0]!.currency : await fallbackCurrency(auth.userId);

    return { shares, outstandingMinor, currency };
  });

  /**
   * Everything that happened in every group this user belongs to, newest first.
   * The row shape mirrors `/groups/:id/timeline` so one renderer serves both
   * feeds; `groupName` is what the cross-group version adds.
   */
  app.get('/me/activity', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<ActivityRow>(
      `select e.time, e.event_id, e.event_type, e.amount_minor, e.currency, e.metadata,
              e.group_id, g.name as group_name
         from ledger_events e
         join groups g on g.id = e.group_id
         join members m on m.group_id = e.group_id
        where m.user_id = $1 and m.status <> 'removed'
        order by e.time desc
        limit 60`,
      [auth.userId],
    );

    const events = rows.map((row) => {
      const metadata = row.metadata ?? {};
      const actor =
        typeof metadata.actor === 'string' && metadata.actor ? metadata.actor : 'Globie';
      const summary =
        typeof metadata.summary === 'string' && metadata.summary
          ? metadata.summary
          : row.event_type;

      const settledRate = mapSettledRate(metadata);

      return {
        id: row.event_id,
        at: new Date(row.time).toISOString(),
        actor,
        type: row.event_type,
        summary,
        groupId: row.group_id,
        groupName: row.group_name,
        ...(row.amount_minor > 0
          ? { amountMinor: row.amount_minor, currency: row.currency }
          : {}),
        ...(settledRate ? { settledRate } : {}),
      };
    });

    return { events };
  });

  /** Globie balance across every group this user belongs to. */
  app.get('/me/points', async (request) => {
    const auth = requireUser(request);

    const { rows } = await query<{ balance: number }>(
      `select coalesce(sum(pa.delta), 0)::bigint as balance
         from points_awards pa
         join members m on m.id = pa.member_id
        where m.user_id = $1`,
      [auth.userId],
    );

    return { balance: rows[0]?.balance ?? 0 };
  });

  // --- notifications (DEV_PLAN §2.13) -------------------------------------

  app.get('/me/notifications', async (request) => {
    const auth = requireUser(request);
    return notificationSettings(auth.userId);
  });

  /** One toggle fans out to every membership, so the screen stays per-user. */
  app.patch('/me/notifications', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const channel = body.channel;

    if (typeof channel !== 'string' || !FALLBACK_ORDER.includes(channel as Channel)) {
      throw ApiError.badRequest(
        'invalid_channel',
        `channel must be one of ${FALLBACK_ORDER.join(', ')}`,
      );
    }
    if (typeof body.enabled !== 'boolean') {
      throw ApiError.badRequest('invalid_enabled', 'enabled must be a boolean');
    }

    await query(
      `insert into notification_preferences (member_id, channel, enabled)
       select m.id, $2, $3
         from members m
        where m.user_id = $1 and m.status <> 'removed'
       on conflict (member_id, channel)
       do update set enabled = excluded.enabled, updated_at = now()`,
      [auth.userId, channel, body.enabled],
    );

    return notificationSettings(auth.userId);
  });

  /** The Expo push token this handset registered; one device, one user. */
  app.post('/me/push-token', async (request) => {
    const auth = requireUser(request);
    const body = asRecord(request.body);
    const token = requiredString(body, 'token', { min: 8, max: 200 });

    await query(`update users set push_token = $2 where id = $1`, [auth.userId, token]);
    return { registered: true };
  });

  /** Sign-out clears it so the next account on this handset gets no pushes. */
  app.delete('/me/push-token', async (request) => {
    const auth = requireUser(request);
    await query(`update users set push_token = null where id = $1`, [auth.userId]);
    return { registered: false };
  });
};
