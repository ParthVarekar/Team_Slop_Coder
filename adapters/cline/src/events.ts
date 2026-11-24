import { z } from 'zod';
import type { AgentInfo, Privacy } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';
import { asRecord, digest, truncate } from './util.js';

/** Machine/project context supplied by the daemon; the adapter stays stateless. */
export interface AdapterContext {
  deviceId: string;
  projectId: string;
  userId: string;
  repoId?: string;
  cwd?: string;
  model?: string;
}

/** A translated event draft; the daemon stamps ids/ts and builds the actor. */
export interface AdapterEvent {
  type: string;
  payload: Record<string, unknown>;
  providerSessionId: string;
  agent: AgentInfo | null;
  privacy?: Privacy;
}

export class AdapterError extends Error {
  constructor(
    readonly code: 'invalid_event',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Normalized events pushed by the Cline SDK/OTel bridge. */
const ClineEventSchema = z
  .object({
    session_id: z.string().min(1).optional(),
    task_id: z.string().min(1).optional(),
    kind: z.string().min(1),
    cwd: z.string().optional(),
    model: z.string().optional(),
    tool_name: z.string().min(1).optional(),
    tool_input: z.unknown().optional(),
    output: z.string().optional(),
    success: z.boolean().optional(),
    exit_code: z.number().int().optional(),
    path: z.string().min(1).optional(),
    change_kind: z.enum(['add', 'modify', 'delete', 'rename']).optional(),
    reason: z.string().optional(),
  })
  .passthrough()
  .refine((event) => event.session_id !== undefined || event.task_id !== undefined, {
    message: 'session_id or task_id is required',
  });

function summarize(input: unknown): Record<string, unknown> {
  const record = asRecord(input);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record).slice(0, 6)) {
    out[key] = typeof value === 'string' ? truncate(value, 200) : value;
  }
  return out;
}

function mapReason(reason: string | undefined): 'completed' | 'failed' | 'interrupted' | 'crashed' {
  switch (reason) {
    case 'failed':
      return 'failed';
    case 'interrupted':
      return 'interrupted';
    case 'crashed':
      return 'crashed';
    default:
      return 'completed';
  }
}

/** Translate a normalized Cline push event; unknown kinds emit nothing. */
export function translateEvent(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = ClineEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_event', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const event = parsed.data;
  const providerSessionId = event.session_id ?? event.task_id ?? '';
  const model = event.model ?? ctx.model;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `push@${ADAPTER_VERSION}`,
    ...(model ? { model } : {}),
  };
  const base = { providerSessionId, agent };

  switch (event.kind) {
    case 'task.started':
      return [
        {
          ...base,
          type: 'session.started',
          payload: {
            cwd: event.cwd ?? ctx.cwd ?? '.',
            fidelity: 'medium',
            ...(model ? { model } : {}),
          },
        },
      ];

    case 'tool.called': {
      if (!event.tool_name) return [];
      return [
        {
          ...base,
          type: 'tool.pre',
          payload: {
            tool_name: event.tool_name,
            ...(event.tool_input !== undefined
              ? { tool_input_summary: summarize(event.tool_input) }
              : {}),
          },
        },
      ];
    }

    case 'tool.completed': {
      if (!event.tool_name) return [];
      const output = event.output ?? '';
      const failed =
        event.success === false || (event.exit_code !== undefined && event.exit_code !== 0);
      const events: AdapterEvent[] = failed
        ? [
            {
              ...base,
              type: 'tool.failed',
              payload: {
                tool_name: event.tool_name,
                error_class: 'tool_error',
                error_excerpt: truncate(output, 2048),
              },
            },
          ]
        : [
            {
              ...base,
              type: 'tool.post',
              payload: {
                tool_name: event.tool_name,
                success: true,
                output_digest: digest(output),
                output_excerpt: truncate(output, 2048),
              },
            },
          ];
      if (event.path) {
        events.push({
          ...base,
          type: 'file.changed',
          payload: {
            path: event.path,
            change_kind: event.change_kind ?? 'modify',
            source: 'agent_tool',
          },
        });
      }
      return events;
    }

    case 'task.completed':
      return [{ ...base, type: 'session.ended', payload: { reason: mapReason(event.reason) } }];

    case 'message':
      return [{ ...base, type: 'session.status', payload: { status: 'running' } }];

    default:
      return [];
  }
}
