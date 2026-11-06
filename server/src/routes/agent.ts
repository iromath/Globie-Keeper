/**
 * The Globie chat endpoint (DEV_PLAN §2.10 / §2.11).
 *
 * A single deterministic entry point: the client names one of the seven tools
 * and its arguments. Money-moving tools answer with `confirmationRequired` and
 * a short-lived token; the client repeats the same call with `confirmToken` to
 * commit it.
 */

import type { FastifyPluginAsync } from 'fastify';

import { AGENT_TOOLS, runAgentTool } from '../lib/agent.js';
import { asRecord, optionalString, requiredString } from '../lib/validate.js';

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
};
