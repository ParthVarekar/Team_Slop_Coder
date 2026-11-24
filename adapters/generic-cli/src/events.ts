import { z } from 'zod';
import type { AgentInfo, Privacy } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';
import { truncate } from './util.js';

/** Machine/project context supplied by the daemon; the adapter stays stateless. */
export interface AdapterContext {
  deviceId: string;
  projectId: string;
  userId: string;
  repoId?: string;
  cwd?: string;
  model?: string;
}

/**
 * A translated event draft. The daemon stamps device/project/event_id/ts,
 * resolves the native provider session to a Weft session_id, and builds the
 * actor from `agent`. Keeping that here would couple the adapter to daemon state.
 */
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

/**
 * Normalized payload POSTed by the thin external wrapper script. The wrapper has
 * no native hooks, so it reports only what it can honestly observe about an
 * arbitrary CLI agent: process lifecycle (start/idle/end), executed commands, and
 * file changes it detected. stdout/stderr are accepted for forward compatibility
 * but are not translated into a tool-level transcript (this adapter is low
 * fidelity, observe-only). Unknown additive fields survive via passthrough.
 */
const WrapperEventSchema = z
  .object({
    session_id: z.string().min(1),
    kind: z.string().min(1),
    cwd: z.string().optional(),
    model: z.string().optional(),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    files: z
      .array(
        z
          .object({
            path: z.string().min(1),
            change_kind: z.enum(['add', 'modify', 'delete', 'rename']).optional(),
          })
          .passthrough(),
      )
      .optional(),
    reason: z.string().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

/** Map a wrapper-reported end reason onto the protocol enum; default to completed. */
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

/**
 * Translate a normalized wrapper payload into protocol-v1 event drafts. Unknown
 * or unmappable kinds yield no events (never fabricate activity); malformed input
 * throws. A 'command' kind with no non-empty command emits nothing rather than
 * inventing a command. Secret redaction happens downstream in the pipeline.
 */
export function translateEvent(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = WrapperEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_event', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const e = parsed.data;
  const model = e.model ?? ctx.model;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `wrap@${ADAPTER_VERSION}`,
    ...(model ? { model } : {}),
  };
  const providerSessionId = e.session_id;
  const cwd = e.cwd ?? ctx.cwd;
  const base = { providerSessionId, agent };

  switch (e.kind) {
    case 'start':
      return [
        {
          ...base,
          type: 'session.started',
          payload: {
            cwd: cwd ?? '.',
            fidelity: 'low',
            ...(model ? { model } : {}),
          },
        },
      ];

    case 'command': {
      const command = e.command;
      // Only emit when a real command was reported; never fabricate one.
      if (typeof command !== 'string' || command.length === 0) return [];
      const events: AdapterEvent[] = [
        {
          ...base,
          type: 'command.executed',
          payload: {
            command_display: truncate(command, 200),
            ...(cwd !== undefined ? { cwd } : {}),
            ...(e.exit_code !== undefined ? { exit_code: e.exit_code } : {}),
          },
        },
      ];
      for (const file of e.files ?? []) {
        events.push({
          ...base,
          type: 'file.changed',
          payload: {
            path: file.path,
            change_kind: file.change_kind ?? 'modify',
            source: 'agent_tool',
          },
        });
      }
      return events;
    }

    case 'idle':
      return [
        {
          ...base,
          type: 'session.status',
          payload: {
            status: 'idle',
            ...(e.detail ? { detail: truncate(e.detail, 200) } : {}),
          },
        },
      ];

    case 'end':
      return [{ ...base, type: 'session.ended', payload: { reason: mapReason(e.reason) } }];

    // Unknown kinds carry no honest protocol-v1 mapping. Emit nothing rather than
    // fabricate activity or misattribute session state.
    default:
      return [];
  }
}
