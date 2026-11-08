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
import { formatAmount } from './paypal.js';

export type ChatTurn = { role: 'user' | 'assistant'; content: string };

const SETTLED = new Set(['paid', 'settled', 'refunded']);
const MAX_MESSAGE_CHARS = 600;
const MAX_TURN_CHARS = 1_500;

const SYSTEM_PROMPT = `You are Globie, the in-app assistant for Globie Keeper, an app a group uses to split a restaurant bill and collect reimbursements through PayPal.

Voice: warm, brief, plain. At most three sentences. No markdown, no bullet lists.

What the app can do (these are actions you cannot perform yourself):
- read the receipt, split the bill across the group, ask everyone to confirm their lines
- say who still owes, nudge a member, request a PayPal payment, award Globie points
Only the fronter — the member who paid the merchant — can change the bill.

Rules:
- Answer from CONTEXT only. Never invent names, amounts, statuses or dates. If something is not in CONTEXT, say you do not know.
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
  groupId: string,
  billId: string | null,
): Promise<string> {
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
    lines.push('', 'BILL', 'none captured yet');
    return lines.join('\n');
  }

  const billCtx = await requireBillMember(request, billId);
  // The bill must belong to the group the client claims to be looking at.
  if (billCtx.groupId !== groupId) throw ApiError.forbidden();

  const [{ bill }, shares] = await Promise.all([loadBill(billId), loadShares(billId)]);
  const currency = bill.currency.trim();
  const money = (amount: number) => `${formatAmount(amount, currency)} ${currency}`;
  const open = shares.filter((share) => !SETTLED.has(share.status));
  const own = shares.find((share) => share.member_id === member.id);
  const names = [...new Set(shares.map((share) => share.member_name))];

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
  );

  return lines.join('\n');
}

/**
 * One conversational turn. `message` is what the member just typed; `history`
 * is the tail of the chat, already filtered to user/assistant turns.
 */
export async function chatReply(input: {
  request: FastifyRequest;
  groupId: string;
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
          { role: 'system', content: `${SYSTEM_PROMPT}\n\nCONTEXT\n${context}` },
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
