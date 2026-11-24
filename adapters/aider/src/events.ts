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

/** Session/commit metadata reported by the external Aider wrapper. */
const AiderEventSchema = z
  .object({
    session_id: z.string().min(1),
    kind: z.string().min(1),
    cwd: z.string().optional(),
    commit_oid: z.string().min(1).optional(),
    message: z.string().optional(),
    branch: z.string().min(1).optional(),
    parents: z.array(z.string()).optional(),
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
  })
  .passthrough();

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

/** Translate Aider wrapper metadata; unknown kinds or incomplete commits emit nothing. */
export function translateEvent(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = AiderEventSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_event', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const event = parsed.data;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `wrap@${ADAPTER_VERSION}`,
    ...(ctx.model ? { model: ctx.model } : {}),
  };
  const base = { providerSessionId: event.session_id, agent };

  switch (event.kind) {
    case 'session_start':
      return [
        {
          ...base,
          type: 'session.started',
          payload: { cwd: event.cwd ?? ctx.cwd ?? '.', fidelity: 'low' },
        },
      ];

    case 'commit': {
      // commit.created requires real oid/branch/parents. Never invent a branch or
      // claim a root commit when the wrapper did not report that metadata.
      if (!event.commit_oid || !event.branch || !event.parents) return [];
      const events: AdapterEvent[] = [
        {
          ...base,
          type: 'commit.created',
          payload: {
            oid: event.commit_oid,
            branch: event.branch,
            parents: event.parents,
            ...(event.message ? { message_summary: truncate(event.message, 400) } : {}),
            ...(event.files ? { files_changed_count: event.files.length } : {}),
          },
        },
      ];
      for (const file of event.files ?? []) {
        events.push({
          ...base,
          type: 'file.changed',
          payload: {
            path: file.path,
            change_kind: file.change_kind ?? 'modify',
            source: 'git',
          },
        });
      }
      return events;
    }

    case 'session_end':
      return [{ ...base, type: 'session.ended', payload: { reason: mapReason(event.reason) } }];

    default:
      return [];
  }
}
