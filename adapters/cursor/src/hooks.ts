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

/** Documented Cursor Hooks subset; beta wire format is treated conservatively. */
const CursorHookSchema = z
  .object({
    conversation_id: z.string().min(1).optional(),
    session_id: z.string().min(1).optional(),
    hook_event_name: z.string().min(1),
    cwd: z.string().optional(),
    model: z.string().optional(),
    generation_id: z.string().optional(),
    tool_name: z.string().optional(),
    tool_input: z.unknown().optional(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    file_path: z.string().optional(),
    change_kind: z.enum(['add', 'modify', 'delete', 'rename']).optional(),
    edits: z.array(z.unknown()).optional(),
    command: z.string().optional(),
    exit_code: z.number().int().optional(),
    output: z.string().optional(),
    status: z.string().optional(),
    reason: z.string().optional(),
  })
  .passthrough()
  .refine((event) => event.conversation_id !== undefined || event.session_id !== undefined, {
    message: 'conversation_id or session_id is required',
  });

const INPUT_KEYS = ['file_path', 'path', 'command', 'pattern', 'url', 'query', 'description'];

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
    if (typeof value.output === 'string') return value.output;
    if (typeof value.content === 'string') return value.content;
    if (typeof value.error === 'string') return value.error;
    return JSON.stringify(response);
  }
  return response === undefined ? '' : String(response);
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

function commandOf(hook: z.infer<typeof CursorHookSchema>): string | null {
  const value = hook.command ?? asRecord(hook.tool_input).command;
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isShellHook(hook: z.infer<typeof CursorHookSchema>): boolean {
  return (
    hook.hook_event_name === 'beforeShellExecution' ||
    hook.hook_event_name === 'afterShellExecution'
  );
}

function isShellTool(name: string): boolean {
  return /^(shell|bash|execute_command|run_command)$/i.test(name) || /shell|terminal/i.test(name);
}

/** Translate only verified Cursor hook fields; unknown/unmappable hooks emit nothing. */
export function translateHook(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = CursorHookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_hook', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const hook = parsed.data;
  const providerSessionId = hook.conversation_id ?? hook.session_id;
  if (!providerSessionId)
    throw new AdapterError('invalid_hook', 'conversation_id or session_id is required');
  const model = hook.model ?? ctx.model;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `hooks@${ADAPTER_VERSION}`,
    ...(model ? { model } : {}),
  };
  const base = { providerSessionId, agent };
  const cwd = hook.cwd ?? ctx.cwd ?? '.';
  const input = asRecord(hook.tool_input);
  const response = asRecord(hook.tool_response);
  const toolName = hook.tool_name ?? (isShellHook(hook) ? 'Shell' : 'unknown');

  switch (hook.hook_event_name) {
    case 'sessionStart':
      return [
        {
          ...base,
          type: 'session.started',
          payload: { cwd, fidelity: 'medium', ...(model ? { model } : {}) },
        },
      ];

    case 'sessionEnd':
      return [{ ...base, type: 'session.ended', payload: { reason: mapEndReason(hook.reason) } }];

    case 'stop':
      return [{ ...base, type: 'session.status', payload: { status: 'idle' } }];

    case 'preToolUse':
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

    case 'beforeShellExecution': {
      const command = commandOf(hook);
      if (!command) return [];
      return [
        {
          ...base,
          type: 'tool.pre',
          payload: { tool_name: 'Shell', tool_input_summary: { command: truncate(command, 200) } },
        },
      ];
    }

    case 'postToolUse':
    case 'postToolUseFailure':
    case 'afterShellExecution': {
      const responseExit =
        typeof response.exit_code === 'number' ? response.exit_code : response.exitCode;
      const exitCode =
        hook.exit_code ?? (typeof responseExit === 'number' ? responseExit : undefined);
      const output = hook.output ?? extractOutput(hook.tool_response);
      const failed =
        hook.hook_event_name === 'postToolUseFailure' ||
        response.success === false ||
        response.error !== undefined ||
        hook.status === 'failed' ||
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
      const command = commandOf(hook);
      if (!failed && command && (isShellHook(hook) || isShellTool(toolName))) {
        events.push({
          ...base,
          type: 'command.executed',
          payload: {
            command_display: command,
            cwd,
            ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
          },
        });
      }
      return events;
    }

    case 'afterFileEdit': {
      if (!hook.file_path) return [];
      return [
        {
          ...base,
          type: 'file.changed',
          payload: {
            path: hook.file_path,
            change_kind: hook.change_kind ?? 'modify',
            source: 'agent_tool',
          },
        },
      ];
    }

    default:
      return [];
  }
}
