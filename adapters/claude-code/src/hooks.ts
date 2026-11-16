import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { AgentInfo, Privacy } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';

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
    readonly code: 'invalid_hook',
    message: string,
  ) {
    super(message);
    this.name = 'AdapterError';
  }
}

const ClaudeHookSchema = z
  .object({
    session_id: z.string().min(1),
    transcript_path: z.string().optional(),
    cwd: z.string().optional(),
    hook_event_name: z.string().min(1),
    tool_name: z.string().optional(),
    tool_input: z.record(z.unknown()).optional(),
    tool_response: z.unknown().optional(),
    tool_use_id: z.string().optional(),
    prompt: z.string().optional(),
    message: z.string().optional(),
    reason: z.string().optional(),
    source: z.string().optional(),
    model: z.string().optional(),
  })
  .passthrough();

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function digest(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex').slice(0, 16)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

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

function summarizeInput(input: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!input) return {};
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
    const o = asRecord(response);
    if (typeof o.stdout === 'string') {
      return typeof o.stderr === 'string' && o.stderr ? `${o.stdout}\n${o.stderr}` : o.stdout;
    }
    if (typeof o.content === 'string') return o.content;
    if (typeof o.output === 'string') return o.output;
    if (typeof o.error === 'string') return o.error;
    const file = asRecord(o.file);
    if (typeof file.content === 'string') return file.content;
    return JSON.stringify(response);
  }
  return response === undefined ? '' : String(response);
}

function mapEndReason(reason: string | undefined): 'completed' | 'interrupted' {
  return reason === 'prompt_input_exit' ? 'interrupted' : 'completed';
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

/**
 * Claude Code PreToolUse hook JSON response. `permissionDecision: 'deny'`
 * synchronously blocks the tool call — this adapter is a real hard enforcement
 * boundary (manifest hardBlock:true), unlike fail-open adapters.
 */
export interface PreToolUseDecision {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'deny' | 'allow' | 'ask';
    permissionDecisionReason?: string;
  };
}

export function denyPreToolUse(reason: string): PreToolUseDecision {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

/**
 * Translate a Claude Code hook payload into protocol-v1 event drafts. Unknown
 * hooks yield no events (never fabricate activity); malformed input throws.
 * Secret redaction happens downstream in the pipeline, not here.
 */
export function translateHook(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = ClaudeHookSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError('invalid_hook', parsed.error.issues.map((i) => i.message).join('; '));
  }
  const h = parsed.data;
  const model = h.model ?? ctx.model;
  const agent: AgentInfo = {
    provider: PROVIDER,
    adapter: `hooks@${ADAPTER_VERSION}`,
    ...(model ? { model } : {}),
  };
  const providerSessionId = h.session_id;
  const cwd = h.cwd ?? ctx.cwd ?? '.';
  const base = { providerSessionId, agent };
  const toolName = h.tool_name ?? 'unknown';
  const input = h.tool_input;

  switch (h.hook_event_name) {
    case 'SessionStart':
      return [
        {
          ...base,
          type: 'session.started',
          payload: {
            cwd,
            fidelity: 'high',
            ...(model ? { model } : {}),
            ...(h.source ? { source: h.source } : {}),
          },
        },
      ];

    case 'UserPromptSubmit': {
      const prompt = h.prompt ?? '';
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
            ...(h.tool_use_id ? { tool_use_id: h.tool_use_id } : {}),
          },
        },
      ];

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const response = asRecord(h.tool_response);
      const output = extractOutput(h.tool_response);
      const failed =
        h.hook_event_name === 'PostToolUseFailure' ||
        response.success === false ||
        response.error !== undefined;
      const events: AdapterEvent[] = [];
      if (failed) {
        events.push({
          ...base,
          type: 'tool.failed',
          payload: {
            tool_name: toolName,
            error_class: 'tool_error',
            error_excerpt: truncate(output, 2048),
            ...(h.tool_use_id ? { tool_use_id: h.tool_use_id } : {}),
          },
        });
      } else {
        events.push({
          ...base,
          type: 'tool.post',
          payload: {
            tool_name: toolName,
            success: true,
            output_excerpt: truncate(output, 2048),
            output_digest: digest(output),
            ...(h.tool_use_id ? { tool_use_id: h.tool_use_id } : {}),
          },
        });
        if (toolName === 'Bash' && typeof input?.command === 'string' && input.command.length > 0) {
          events.push({
            ...base,
            type: 'command.executed',
            payload: {
              command_display: input.command,
              cwd,
              ...(typeof response.exitCode === 'number' ? { exit_code: response.exitCode } : {}),
            },
          });
        }
        if (FILE_TOOLS.has(toolName)) {
          const path = input?.file_path ?? input?.notebook_path;
          if (typeof path === 'string' && path.length > 0) {
            events.push({
              ...base,
              type: 'file.changed',
              payload: {
                path,
                change_kind: toolName === 'Write' ? 'add' : 'modify',
                source: 'agent_tool',
              },
            });
          }
        }
      }
      return events;
    }

    case 'Notification':
      return [
        {
          ...base,
          type: 'session.status',
          payload: { status: 'waiting_permission', ...(h.message ? { detail: h.message } : {}) },
        },
      ];

    case 'Stop':
    case 'SubagentStop':
      return [{ ...base, type: 'session.status', payload: { status: 'idle' } }];

    case 'SessionEnd':
      return [{ ...base, type: 'session.ended', payload: { reason: mapEndReason(h.reason) } }];

    default:
      return [];
  }
}
