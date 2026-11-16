import { z } from 'zod';
import type { AgentInfo } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';
import { AdapterError, type AdapterContext, type AdapterEvent } from './hooks.js';
import { digest, truncate } from './util.js';

/**
 * Legacy Codex `notify` program hook. Unlike command hooks (one JSON object on
 * stdin), notify passes a single argv JSON blob and fires only on
 * agent-turn-complete. Keys are hyphenated per the Codex config reference.
 */
const CodexNotifySchema = z
  .object({
    type: z.string().min(1),
    'thread-id': z.string().optional(),
    'turn-id': z.string().optional(),
    cwd: z.string().optional(),
    'input-messages': z.array(z.unknown()).optional(),
    'last-assistant-message': z.string().optional(),
  })
  .passthrough();

/**
 * Translate a legacy notify payload. The only honest signal is "a turn
 * completed" → session idle; notify carries no tool/file/command detail and
 * cannot create a session (no session.started). Unknown notify types emit
 * nothing; malformed input throws.
 */
export function translateNotify(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = CodexNotifySchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_hook', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const n = parsed.data;
  if (n.type !== 'agent-turn-complete') return [];
  const providerSessionId = n['thread-id'] ?? n['turn-id'];
  if (!providerSessionId) {
    throw new AdapterError('invalid_hook', 'notify payload missing thread-id/turn-id');
  }
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `notify@${ADAPTER_VERSION}`,
    ...(ctx.model ? { model: ctx.model } : {}),
  };
  const message = n['last-assistant-message'];
  return [
    {
      type: 'session.status',
      providerSessionId,
      agent,
      payload: {
        status: 'idle',
        fidelity: 'low',
        ...(message ? { detail: truncate(message, 200), message_hash: digest(message) } : {}),
      },
    },
  ];
}