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

/**
 * Codex command-hook stdin payload. Field names match the official Hooks wire
 * format (Claude-compatible). tool_input/tool_response are arbitrary JSON values
 * per the spec, so they are accepted as unknown and coerced where read.
 */
const CodexHookSchema = z
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
    agent_id: z.string().optional(),
    agent_type: z.string().optional(),
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

function exitCodeOf(response: Record<string, unknown>): number | undefined {
  if (typeof response.exit_code === 'number') return response.exit_code;
  if (typeof response.exitCode === 'number') return response.exitCode;
  return undefined;
}

/** Codex SessionEnd currently only emits reason "other"; map honestly. */
function mapEndReason(reason: string | undefined): 'completed' | 'interrupted' {
  return reason === 'interrupted' ? 'interrupted' : 'completed';
}

/** Codex routes all file edits through apply_patch; the patch text is tool_input.command. */
const PATCH_TOOL = 'apply_patch';
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
    if (!path) continue;
    const change_kind = verb === 'Add' ? 'add' : verb === 'Delete' ? 'delete' : 'modify';
    changes.push({ path, change_kind });
  }
  return changes;
}

/**
 * Translate a Codex Hooks payload into protocol-v1 event drafts. Unknown or
 * unmappable hooks yield no events (never fabricate activity); malformed input
 * throws. Secret redaction happens downstream in the pipeline, not here.
 */
export function translateHook(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  const parsed = CodexHookSchema.safeParse(raw);
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
  const input = asRecord(h.tool_input);

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
            ...(h.permission_mode ? { permission_mode: h.permission_mode } : {}),
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
            ...(h.turn_id ? { turn_id: h.turn_id } : {}),
          },
        },
      ];

    case 'PermissionRequest': {
      const detail = typeof input.description === 'string' ? input.description : toolName;
      return [
        {
          ...base,
          type: 'session.status',
          payload: {
            status: 'waiting_permission',
            detail: truncate(detail, 200),
            tool_name: toolName,
          },
        },
      ];
    }

    case 'PostToolUse': {
      const response = asRecord(h.tool_response);
      const output = extractOutput(h.tool_response);
      const exitCode = exitCodeOf(response);
      const failed =
        response.success === false ||
        response.error !== undefined ||
        (exitCode !== undefined && exitCode !== 0);
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
        if (toolName === 'Bash' && typeof input.command === 'string' && input.command.length > 0) {
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
        if (toolName === PATCH_TOOL && typeof input.command === 'string') {
          for (const change of parseApplyPatch(input.command)) {
            events.push({
              ...base,
              type: 'file.changed',
              payload: { path: change.path, change_kind: change.change_kind, source: 'agent_tool' },
            });
          }
        }
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
            ...(h.last_assistant_message
              ? { detail: truncate(h.last_assistant_message, 200) }
              : {}),
          },
        },
      ];

    case 'Interrupt':
      return [
        { ...base, type: 'session.status', payload: { status: 'idle', detail: 'interrupted' } },
      ];

    case 'SessionEnd':
      return [{ ...base, type: 'session.ended', payload: { reason: mapEndReason(h.reason) } }];

    // SubagentStart/SubagentStop carry the PARENT session_id, so a session.status
    // would misrepresent the parent's state. PreCompact/PostCompact and
    // Pre/PostModelRequest are diagnostic-only with no protocol-v1 mapping. Emit
    // nothing rather than fabricate activity or misattribute session status.
    default:
      return [];
  }
}
