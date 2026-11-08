/**
 * Client for the Globie Earth sanctuary MCP (DEV_PLAN §2.21).
 *
 * The host 404s on `/`, so the transport is JSON-RPC over `POST /mcp`. The
 * server has been observed answering `initialize` with a plain JSON body and
 * other calls with `data:`-framed SSE, so the parser accepts both. Identity is
 * per `X-Device-Id`; we derive a stable pseudo-device from the Globie user so a
 * restart cannot orphan a member's adoption deeds.
 */

import { createHash } from 'node:crypto';
import { config } from './config.js';
import { ApiError } from './http-error.js';

const PROTOCOL_VERSION = '2025-06-18';
const TOOL_TIMEOUT_MESSAGE = 'The Globie Earth sanctuary did not answer in time';

type JsonRpcEnvelope = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export type ForestHit = {
  entityType?: string;
  entityId?: string;
  title?: string;
  content?: string;
  similarity?: number;
};

export type AdoptionDeed = {
  deedNo?: string;
  speciesId?: string;
  treesPlanted?: number;
  progressPct?: number;
  co2OffsetKg?: number;
};

function unavailable(message: string): ApiError {
  return new ApiError(502, 'mcp_unavailable', message);
}

/** A stable HTTP-safe UUID for a user: the sanctuary scopes deeds to it. */
export function deviceIdForUser(userId: string): string {
  const hex = createHash('sha256').update(`globie-user:${userId}`).digest('hex');
  const variant = ((Number.parseInt(hex[16] ?? '0', 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-');
}

/** Accept a plain JSON body, an SSE body, or JSON delivered inside SSE data. */
function parseBody(text: string): JsonRpcEnvelope[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as JsonRpcEnvelope | JsonRpcEnvelope[];
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Fall through to the SSE parser; some proxies label SSE as JSON.
    }
  }

  const envelopes: JsonRpcEnvelope[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const payload = line.startsWith('data:') ? line.slice(5).trim() : '';
    if (!payload || payload === '[DONE]') continue;
    try {
      const parsed = JSON.parse(payload) as JsonRpcEnvelope | JsonRpcEnvelope[];
      if (Array.isArray(parsed)) envelopes.push(...parsed);
      else envelopes.push(parsed);
    } catch {
      // A partial frame; ignore and try the next line.
    }
  }
  return envelopes;
}

async function post(
  deviceId: string,
  payload: unknown,
  sessionId?: string,
): Promise<{ envelopes: JsonRpcEnvelope[]; sessionId?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-Device-Id': deviceId,
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  if (config.mcpBearerToken) headers.Authorization = `Bearer ${config.mcpBearerToken}`;

  let response: Response;
  try {
    response = await fetch(config.mcpBaseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(config.mcpTimeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network error';
    throw unavailable(`${TOOL_TIMEOUT_MESSAGE} (${detail})`);
  }

  const text = await response.text();
  if (!response.ok) {
    throw unavailable(`The sanctuary rejected the request (HTTP ${response.status})`);
  }

  return {
    envelopes: parseBody(text),
    sessionId: response.headers.get('mcp-session-id') ?? sessionId,
  };
}

/** initialize → notifications/initialized → tools/call, per request. */
async function callTool<T>(
  deviceId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  let nextId = 1;
  const { sessionId } = await post(deviceId, {
    jsonrpc: '2.0',
    id: nextId++,
    method: 'initialize',
    params: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'globie-keeper', version: '1.0.0' },
    },
  });
  if (!sessionId) throw unavailable('The sanctuary did not open a session');

  await post(
    deviceId,
    { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
    sessionId,
  );

  const { envelopes } = await post(
    deviceId,
    {
      jsonrpc: '2.0',
      id: nextId++,
      method: 'tools/call',
      params: { name, arguments: args },
    },
    sessionId,
  );

  const answer = envelopes.find((envelope) => envelope.result !== undefined || envelope.error);
  if (!answer) throw unavailable('The sanctuary returned an empty reply');
  if (answer.error) {
    throw unavailable(answer.error.message ?? 'The sanctuary rejected the tool call');
  }

  const result = answer.result as
    | { structuredContent?: unknown; content?: Array<{ type?: string; text?: string }> }
    | undefined;
  if (result?.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent as T;
  }

  const textPart = result?.content?.find((part) => typeof part.text === 'string')?.text;
  if (textPart) {
    try {
      return JSON.parse(textPart) as T;
    } catch {
      throw unavailable('The sanctuary returned an unreadable reply');
    }
  }
  throw unavailable('The sanctuary returned no content');
}

/** The live catalogue is small; `recommend_species` is empty until embedded. */
export async function searchForestKnowledge(
  deviceId: string,
  query = 'native trees to adopt',
): Promise<ForestHit[]> {
  const result = await callTool<{ hits?: ForestHit[] }>(deviceId, 'search_forest_knowledge', {
    query,
  });
  return Array.isArray(result.hits) ? result.hits : [];
}

/** `reference` makes a retry a no-op, which is why it is the donation id. */
export async function adoptSpecies(
  deviceId: string,
  input: { speciesId: string; quantity: number; reference: string },
): Promise<{ deed: AdoptionDeed | null; replayed: boolean; note?: string | null }> {
  const result = await callTool<{
    deed?: AdoptionDeed | null;
    replayed?: boolean;
    note?: string | null;
  }>(deviceId, 'adopt_species', {
    species_id: input.speciesId,
    quantity: input.quantity,
    reference: input.reference,
  });
  return {
    deed: result.deed ?? null,
    replayed: Boolean(result.replayed),
    note: result.note ?? null,
  };
}
