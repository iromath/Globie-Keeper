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
import { asRecord, optionalString, requiredString, requiredUuid } from '../lib/validate.js';

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
   */
  app.post('/agent/chat', async (request) => {
    const body = asRecord(request.body);
    const message = requiredString(body, 'message', { min: 1, max: 600 });
    const groupId = requiredUuid(body, 'group_id');
    const billId =
      body.bill_id === undefined || body.bill_id === null || body.bill_id === ''
        ? null
        : requiredUuid(body, 'bill_id');

    const reply = await chatReply({
      request,
      groupId,
      billId,
      message,
      history: parseChatHistory(body.history),
    });

    return { reply };
  });
};
