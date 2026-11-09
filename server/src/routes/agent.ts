/**
 * The Globie chat endpoint (DEV_PLAN §2.10 / §2.11).
 *
 * A single deterministic entry point: the client names one of the seven tools
 * and its arguments. Money-moving tools answer with `confirmationRequired` and
 * a short-lived token; the client repeats the same call with `confirmToken` to
 * commit it.
 *
 * `POST /agent/chat` is the conversational companion: it explains and answers
 * questions but never touches the bill.
 */

import type { FastifyPluginAsync } from 'fastify';

import { AGENT_TOOLS, runAgentTool } from '../lib/agent.js';
import { chatReply, parseChatHistory } from '../lib/assistant.js';
import { ApiError } from '../lib/http-error.js';
import { consume } from '../lib/throttle.js';
import { asRecord, optionalString, optionalUuid, requiredString } from '../lib/validate.js';
import { requireUser } from '../plugins/auth.js';

/** Every chat turn is a model call; a member cannot spend more than this. */
const CHAT_LIMIT = 40;
const CHAT_WINDOW_MS = 10 * 60 * 1000;

export const agentRoutes: FastifyPluginAsync = async (app) => {
  app.get('/agent/tools', async () => ({
    tools: AGENT_TOOLS,
  }));

  app.post('/agent/message', async (request) => {
    const body = asRecord(request.body);
    const tool = requiredString(body, 'tool', { max: 64 });
    const args = body.args === undefined || body.args === null ? {} : asRecord(body.args);
    const confirmToken = optionalString(body, 'confirmToken', 512);

    return runAgentTool({ request, tool, args, confirmToken });
  });

  /**
   * Free-form conversation. Separate from /agent/message on purpose: the seven
   * tools above stay deterministic and auditable, while this endpoint only
   * answers questions and never changes anything.
   *
   * `group_id` is optional (§2.22): without it Globie answers questions about
   * the app itself — the Help page and members with no group yet.
   */
  app.post('/agent/chat', async (request) => {
    // Chat is signed-in only: an anonymous caller would be a free model proxy.
    const auth = requireUser(request);
    if (!consume(`assistant:${auth.userId}`, CHAT_LIMIT, CHAT_WINDOW_MS)) {
      throw ApiError.tooManyRequests('Globie needs a breather. Try again in a few minutes.');
    }

    const body = asRecord(request.body);
    const message = requiredString(body, 'message', { min: 1, max: 600 });
    const groupId = optionalUuid(body, 'group_id');
    const billId = optionalUuid(body, 'bill_id');

    const reply = await chatReply({
      request,
      groupId,
      billId: groupId ? billId : null,
      message,
      history: parseChatHistory(body.history),
    });

    return { reply };
  });
};
