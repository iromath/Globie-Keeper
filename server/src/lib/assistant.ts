/**
 * Free-form Globie replies.
 *
 * The seven agent tools stay deterministic (lib/agent.ts): they own every
 * action and every write. This module only covers the conversational layer
 * around them — greetings, "what can you do", and read-only questions about the
 * group's bill — so a member is never answered with a canned capability menu.
 * It reads the database to ground an answer and never writes to it.
 */

import type { FastifyRequest } from 'fastify';

import { query } from '../db/pool.js';
import { requireBillMember, requireMember } from './access.js';
import { loadBill, loadShares } from './bills.js';
import { config } from './config.js';
import { ApiError } from './http-error.js';
import { manualDigest } from './manual.js';
import { formatAmount } from './paypal.js';
import { listTips, loadFronter } from './tips.js';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

const SETTLED = new Set(['paid', 'settled', 'refunded']);
/** Mirrors the tip route: a tip only makes sense once the fronter has paid. */
const TIP_OPEN = new Set(['FINALIZED', 'COLLECTING', 'SETTLED']);
const MAX_MESSAGE_CHARS = 600;
const MAX_TURN_CHARS = 1_500;

const SYSTEM_PROMPT = `You are Globie, the in-app assistant for Globie Keeper, an app a group uses to split a bill — dinner, a trip, a shared purchase — and collect reimbursements through PayPal.

Voice: warm, brief, plain. At most three sentences. No markdown, no bullet lists.

What the app can do (these are actions you cannot perform yourself):
- read the receipt, split the bill across the group, ask everyone to confirm their lines
- say who still owes, nudge a member, request a PayPal payment, award Globie points
- take a tip for the fronter: the bill screen has a "Tip the fronter" card with suggested amounts and an open amount field, paid straight to the fronter through PayPal and worth +2 Globie
- adopt trees in the Globie Fund with PayPal or with Globie points, where 1,000 points are worth US$1
Only the fronter — the member who paid the merchant — can change the bill.
Tipping is one per member, it opens once the bill is finalized, and the fronter cannot tip themselves.

Rules:
- Answer from CONTEXT and MANUAL only. Never invent names, amounts, statuses or dates. If something is in neither, say you do not know.
- When asked how to do something in the app, answer from MANUAL, naming the exact screen and quoting the button labels it gives. Never describe a control that is not in MANUAL or CONTEXT.
- You cannot execute actions, move money or send messages, and you must never claim you did. If asked, point to the button or tell the member which sentence to type.
- Quote amounts exactly as they appear in CONTEXT, with their currency.
- Reply in the language the member wrote in.`;

type ChatPayload = {
  choices?: { message?: { content?: string | null } }[];
};

/** Only the last few turns are replayed: enough for pronouns, bounded for cost. */
export function parseChatHistory(value: unknown): ChatTurn[] {
  if (!Array.isArray(value)) return [];
  const turns: ChatTurn[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const turn = entry as Record<string, unknown>;
    const role = turn.role === 'assistant' ? 'assistant' : turn.role === 'user' ? 'user' : null;
    const content = typeof turn.content === 'string' ? turn.content.trim() : '';
    if (!role || !content) continue;
    turns.push({ role, content: content.slice(0, MAX_TURN_CHARS) });
  }
  return turns.slice(-config.chatHistoryTurns);
}

/** A compact, factual brief the model may quote but must not extrapolate. */
async function buildContext(
  request: FastifyRequest,
  groupId: string | null,
  billId: string | null,
): Promise<string> {
  // App-wide help (§2.22): no group means no group-scoped facts to read.
  if (!groupId) {
    return [
      'GROUP',
      'none selected — this question is about the app itself, not one group',
      '',
      'BILL',
      'none selected',
      '',
      'TIPS',
      'none — no bill selected',
    ].join('\n');
  }

  const member = await requireMember(request, groupId);

  const { rows: groupRows } = await query<{ name: string }>(
    `select name from groups where id = $1`,
    [groupId],
  );
  const groupName = groupRows[0]?.name ?? 'this group';

  const lines = [
    'GROUP',
    `name: ${groupName}`,
    `member: ${member.displayName}`,
    `role: ${member.role}${member.role === 'member' ? ' (cannot change the bill)' : ''}`,
  ];

  if (!billId) {
    lines.push('', 'BILL', 'none captured yet', '', 'TIPS', 'none — no bill captured yet');
    return lines.join('\n');
  }

  const billCtx = await requireBillMember(request, billId);
  // The bill must belong to the group the client claims to be looking at.
  if (billCtx.groupId !== groupId) throw ApiError.forbidden();

  const [{ bill }, shares, tipRows, fronter] = await Promise.all([
    loadBill(billId),
    loadShares(billId),
    listTips(billId),
    loadFronter(billCtx.agreementId),
  ]);
  const currency = bill.currency.trim();
  const money = (amount: number) => `${formatAmount(amount, currency)} ${currency}`;
  const open = shares.filter((share) => !SETTLED.has(share.status));
  const own = shares.find((share) => share.member_id === member.id);
  const names = [...new Set(shares.map((share) => share.member_name))];

  /** Optional fee coverage (§2.20): the caller's own order may ask for more than their share. */
  const ownCovered =
    own && (own.fee_minor ?? 0) > 0 && own.gross_minor
      ? { gross: own.gross_minor, fee: own.fee_minor ?? 0, net: own.amount }
      : null;

  lines.push(
    '',
    'BILL',
    `status: ${bill.status}`,
    `merchant: ${bill.merchant ?? 'not recorded'}`,
    `total: ${money(bill.total)}`,
    `members with a share: ${names.slice(0, 12).join(', ') || 'none'}`,
    open.length === 0
      ? 'still owes: nobody, every share is paid'
      : `still owes: ${open
          .slice(0, 12)
          .map((share) => `${share.member_name} ${money(share.amount)} (${share.status})`)
          .join(', ')}`,
    own
      ? `your share: ${money(own.amount)}, ${own.status}`
      : 'your share: none on this bill',
    ...(ownCovered
      ? [
          `your checkout: ${money(ownCovered.gross)} at PayPal, which includes ${money(
            ownCovered.fee,
          )} covering the PayPal fee — the share itself stays ${money(ownCovered.net)}`,
        ]
      : []),
  );

  const paidTips = tipRows.filter((tip) => tip.status === 'paid');
  const tippedTotal = paidTips.reduce((sum, tip) => sum + tip.amount, 0);
  const myTip = tipRows.find((tip) => tip.from_member_id === member.id) ?? null;

  lines.push('', 'TIPS');
  if (!fronter.id) {
    lines.push(
      'fronter: not recorded',
      'tipping: unavailable — this bill has no fronter to tip',
    );
  } else {
    lines.push(`fronter: ${fronter.name}${fronter.id === member.id ? ' (you)' : ''}`);
    if (fronter.id === member.id) {
      lines.push(
        'tipping: you fronted this bill, so you cannot tip yourself — the others can tip you',
      );
      if (!fronter.payoutReady) {
        lines.push(
          'fronter payout: no PayPal email set — no tip can reach you until you add one in Settings',
        );
      }
    } else if (!TIP_OPEN.has(bill.status)) {
      lines.push(
        `tipping: not open yet — tips open once the bill is finalized (bill status: ${bill.status})`,
      );
    } else if (!fronter.payoutReady) {
      lines.push(
        `tipping: not possible yet — ${fronter.name} has not added a PayPal email, so a tip has nowhere to land`,
      );
    } else {
      lines.push(
        'tipping: open — the "Tip the fronter" card on the bill screen offers preset amounts; it pays the fronter directly through PayPal and earns +2 Globie',
      );
    }
  }
  lines.push(
    paidTips.length === 0
      ? 'paid tips: none yet'
      : `paid tips: ${paidTips.length}, ${money(tippedTotal)} in total from ${paidTips
          .map((tip) => tip.from_member_name)
          .join(', ')}`,
    myTip
      ? `your tip: ${myTip.status}${
          myTip.status === 'paid' ? `, ${money(myTip.amount)}` : ''
        }`
      : 'your tip: none',
  );

  return lines.join('\n');
}

/**
 * One conversational turn. `message` is what the member just typed; `history`
 * is the tail of the chat, already filtered to user/assistant turns.
 */
export async function chatReply(input: {
  request: FastifyRequest;
  groupId: string | null;
  billId: string | null;
  message: string;
  history: ChatTurn[];
}): Promise<string> {
  if (!config.chatApiKey) {
    throw new ApiError(
      503,
      'assistant_not_configured',
      'Set CHAT_API_KEY (or VISION_API_KEY) before Globie can hold a conversation',
    );
  }

  const context = await buildContext(input.request, input.groupId, input.billId);
  const manual = manualDigest(input.message);

  let response: Response;
  try {
    response = await fetch(config.chatApiUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.chatApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.chatModel,
        temperature: 0.3,
        max_tokens: 300,
        messages: [
          { role: 'system', content: `${SYSTEM_PROMPT}\n\nMANUAL\n${manual}\n\nCONTEXT\n${context}` },
          ...input.history,
          { role: 'user', content: input.message.slice(0, MAX_MESSAGE_CHARS) },
        ],
      }),
      signal: AbortSignal.timeout(config.chatTimeoutMs),
    });
  } catch {
    throw new ApiError(502, 'assistant_unavailable', 'The assistant could not be reached');
  }

  if (!response.ok) {
    throw new ApiError(502, 'assistant_unavailable', 'The assistant could not answer that');
  }

  const payload = (await response.json().catch(() => null)) as ChatPayload | null;
  const reply = payload?.choices?.[0]?.message?.content?.trim();
  if (!reply) {
    throw new ApiError(502, 'assistant_unavailable', 'The assistant returned an empty reply');
  }

  return reply.slice(0, 1_200);
}
