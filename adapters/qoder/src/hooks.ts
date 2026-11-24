import { z } from 'zod';
import type { AgentInfo, Privacy } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';
import { asRecord, digest, truncate } from './util.js';

export interface AdapterContext {
  deviceId: string;
  projectId: string;
  userId: string;
  repoId?: string;
  cwd?: string;
  model?: string;
}

export interface AdapterEvent {
  type: string;
  payload: Record<string, unknown>;
  providerSessionId: string;
  agent: AgentInfo | null;
  privacy?: Privacy;
}

export class AdapterError extends Error {
  constructor(
    readonly code: 'invalid_hook',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

/** Qoder native hook stdin payload (Claude-compatible catalog). */
const QoderHookSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().nullable().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().min(1),
    model: z.string().optional(),
    turn_id: z.string().optional(),
    permission_mode: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    prompt: z.string().optional(),
    source: z.string().optional(),
    reason: z.string().optional(),
    trigger: z.string().optional(),
    file_path: z.string().optional(),
    last_assistant_message: z.string().nullable().optional(),
    stop_hook_active: z.boolean().optional(),
  })
  .passthrough();

const INPUT_KEYS = [
  'file_path',
  'notebook_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
];

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    const value = input[key];
    if (value !== undefined) out[key] = typeof value === 'string' ? truncate(value, 200) : value;
  }
  if (Object.keys(out).length === 0) {
    for (const [key, value] of Object.entries(input).slice(0, 5)) {
      out[key] = typeof value === 'string' ? truncate(value, 200) : value;
    }
  }
  return out;
}

function extractOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (response && typeof response === 'object') {
    const value = asRecord(response);
    if (typeof value.stdout === 'string') {
      return typeof value.stderr === 'string' && value.stderr
        ? `${value.stdout}\n${value.stderr}`
        : value.stdout;
    }
    if (typeof value.content === 'string') return value.content;
    if (typeof value.output === 'string') return value.output;
    if (typeof value.error === 'string') return value.error;
    const file = asRecord(value.file);
    if (typeof file.content === 'string') return file.content;
    return JSON.stringify(response);
  }
  return response === undefined ? '' : String(response);
}

function exitCodeOf(response: Record<string, unknown>): number | undefined {
  if (typeof response.exit_code === 'number') return response.exit_code;
  if (typeof response.exitCode === 'number') return response.exitCode;
  return undefined;
}

function mapEndReason(
  reason: string | undefined,
): 'completed' | 'failed' | 'interrupted' | 'crashed' {
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

const PATCH_HEADER = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s+(.+?)\s*$/;

function parseApplyPatch(
  command: string,
): { path: string; change_kind: 'add' | 'modify' | 'delete' }[] {
  const changes: { path: string; change_kind: 'add' | 'modify' | 'delete' }[] = [];
  for (const line of command.split('\n')) {
    const match = PATCH_HEADER.exec(line);
    if (!match) continue;
    const verb = match[1];
    const path = match[2];
    if (!verb || !path) continue;
    changes.push({
      path,
      change_kind: verb === 'Add' ? 'add' : verb === 'Delete' ? 'delete' : 'modify',
    });
  }
  return changes;
}

/** Translate Qoder native hooks; unknown/unmappable hooks emit nothing. */
export function translateHook(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = QoderHookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_hook', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const hook = parsed.data;
  const model = hook.model ?? ctx.model;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `hooks@${ADAPTER_VERSION}`,
    ...(model ? { model } : {}),
  };
  const base = { providerSessionId: hook.session_id, agent };
  const cwd = hook.cwd ?? ctx.cwd ?? '.';
  const toolName = hook.tool_name ?? 'unknown';
  const input = asRecord(hook.tool_input);

  switch (hook.hook_event_name) {
    case 'SessionStart':
      return [
        {
          ...base,
          type: 'session.started',
          payload: { cwd, fidelity: 'high', ...(model ? { model } : {}) },
        },
      ];

    case 'UserPromptSubmit': {
      const prompt = hook.prompt ?? '';
      return [
        {
          ...base,
          type: 'prompt.submitted',
          payload: { prompt_summary: truncate(prompt, 400), prompt_hash: digest(prompt) },
        },
      ];
    }

    case 'PreToolUse':
      return [
        {
          ...base,
          type: 'tool.pre',
          payload: {
            tool_name: toolName,
            tool_input_summary: summarizeInput(input),
            ...(hook.tool_use_id ? { tool_use_id: hook.tool_use_id } : {}),
          },
        },
      ];

    case 'PermissionRequest': {
      const detail = typeof input.description === 'string' ? input.description : toolName;
      return [
        {
          ...base,
          type: 'session.status',
          payload: { status: 'waiting_permission', detail: truncate(detail, 200) },
        },
      ];
    }

    case 'PostToolUse': {
      const response = asRecord(hook.tool_response);
      const output = extractOutput(hook.tool_response);
      const exitCode = exitCodeOf(response);
      const failed =
        response.success === false ||
        response.error !== undefined ||
        (exitCode !== undefined && exitCode !== 0);
      const events: AdapterEvent[] = failed
        ? [
            {
              ...base,
              type: 'tool.failed',
              payload: {
                tool_name: toolName,
                error_class: 'tool_error',
                error_excerpt: truncate(output, 2048),
                ...(hook.tool_use_id ? { tool_use_id: hook.tool_use_id } : {}),
              },
            },
          ]
        : [
            {
              ...base,
              type: 'tool.post',
              payload: {
                tool_name: toolName,
                success: true,
                output_excerpt: truncate(output, 2048),
                output_digest: digest(output),
                ...(hook.tool_use_id ? { tool_use_id: hook.tool_use_id } : {}),
              },
            },
          ];
      if (
        !failed &&
        toolName === 'Bash' &&
        typeof input.command === 'string' &&
        input.command.length > 0
      ) {
        events.push({
          ...base,
          type: 'command.executed',
          payload: {
            command_display: input.command,
            cwd,
            ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
          },
        });
      }
      const patch =
        toolName === 'apply_patch' && typeof input.command === 'string'
          ? parseApplyPatch(input.command)
          : [];
      const singleFile = hook.file_path
        ? [{ path: hook.file_path, change_kind: 'modify' as const }]
        : [];
      for (const change of patch.length > 0 ? patch : singleFile) {
        events.push({
          ...base,
          type: 'file.changed',
          payload: { ...change, source: 'agent_tool' },
        });
      }
      return events;
    }

    case 'Stop':
      return [
        {
          ...base,
          type: 'session.status',
          payload: {
            status: 'idle',
            ...(hook.last_assistant_message
              ? { detail: truncate(hook.last_assistant_message, 200) }
              : {}),
          },
        },
      ];

    case 'Interrupt':
      return [
        { ...base, type: 'session.status', payload: { status: 'idle', detail: 'interrupted' } },
      ];

    case 'SessionEnd':
      return [{ ...base, type: 'session.ended', payload: { reason: mapEndReason(hook.reason) } }];

    default:
      return [];
  }
}
