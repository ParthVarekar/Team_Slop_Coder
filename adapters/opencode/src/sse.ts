import { z } from 'zod';
import type { AgentInfo, Privacy } from '@weft/protocol';
import { PROVIDER, ADAPTER_VERSION } from './manifest.js';
import { asRecord, digest, truncate } from './util.js';

/** Machine/project context supplied by the daemon. */
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
 * actor from `agent`.
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
 * OpenCode durable SSE frame. `data` always carries `sessionID` (the aggregate
 * key) plus event-specific fields, which are arbitrary JSON per the schema and
 * coerced where read. `durable` carries the per-aggregate seq/version watermark.
 */
const OpenCodeEventSchema = z
  .object({
    type: z.string().min(1),
    data: z.object({ sessionID: z.string().min(1) }).passthrough(),
    id: z.string().optional(),
    created: z.union([z.string(), z.number()]).optional(),
    durable: z
      .object({
        aggregateID: z.string().optional(),
        seq: z.number().optional(),
        version: z.number().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

/** Input keys worth summarizing; source-bearing keys are deliberately excluded. */
const INPUT_KEYS = [
  'filePath',
  'file_path',
  'path',
  'command',
  'pattern',
  'url',
  'query',
  'description',
];
const SOURCE_KEYS = new Set([
  'content',
  'oldString',
  'newString',
  'old_string',
  'new_string',
  'patchText',
  'text',
  'prompt',
]);

function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    const value = input[key];
    if (value !== undefined) out[key] = typeof value === 'string' ? truncate(value, 200) : value;
  }
  if (Object.keys(out).length === 0) {
    for (const [key, value] of Object.entries(input)) {
      if (SOURCE_KEYS.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        out[key] = typeof value === 'string' ? truncate(value, 200) : value;
        if (Object.keys(out).length >= 3) break;
      }
    }
  }
  return out;
}

/** Tool output is a Content[] (text/file/json parts); join the textual parts. */
function extractContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === 'string') return item;
        const r = asRecord(item);
        if (typeof r.text === 'string') return r.text;
        if (typeof r.content === 'string') return r.content;
        return JSON.stringify(item);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  const r = asRecord(content);
  if (typeof r.text === 'string') return r.text;
  return JSON.stringify(content);
}

function errorMessage(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err === undefined || err === null) return '';
  const r = asRecord(err);
  const data = asRecord(r.data);
  return str(r.message) ?? str(data.message) ?? str(r.name) ?? str(r._tag) ?? JSON.stringify(err);
}

/** Model.Ref is `{ providerID, modelID }` (or a bare string in older frames). */
function modelRef(m: unknown): string | undefined {
  if (typeof m === 'string') return m;
  const r = asRecord(m);
  const provider = str(r.providerID) ?? str(r.provider);
  const model = str(r.modelID) ?? str(r.model) ?? str(r.id);
  if (provider && model) return `${provider}/${model}`;
  return model ?? provider;
}

function locationCwd(loc: unknown, fallback: string): string {
  if (typeof loc === 'string' && loc.length > 0) return loc;
  const r = asRecord(loc);
  return str(r.directory) ?? str(r.path) ?? str(r.cwd) ?? fallback;
}

const EDIT_TOOLS = new Set(['edit', 'write', 'multiedit', 'multi_edit']);
const BASH_TOOL = 'bash';

interface SessionState {
  model?: string;
  cwd?: string;
}
interface ToolState {
  sessionID: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Translates the OpenCode durable session-event stream into protocol-v1 drafts.
 *
 * Stateful by necessity: the tool name arrives in `session.tool.input.started`,
 * the input in `session.tool.called`, and the result in `session.tool.success` /
 * `failed`, all correlated by the tool-call `id`. One instance serves a daemon
 * (tool ids are unique); per-session model/cwd and per-tool name/input are
 * remembered and evicted on completion or session deletion to bound memory.
 *
 * Unknown or unmappable events yield no events (never fabricate activity);
 * malformed frames throw. Secret redaction happens downstream in the pipeline.
 */
export class OpenCodeTranslator {
  private readonly sessions = new Map<string, SessionState>();
  private readonly tools = new Map<string, ToolState>();

  constructor(private readonly ctx: AdapterContext) {}

  reset(): void {
    this.sessions.clear();
    this.tools.clear();
  }

  private baseFor(sessionID: string): { providerSessionId: string; agent: AgentInfo } {
    const model = this.sessions.get(sessionID)?.model ?? this.ctx.model;
    return {
      providerSessionId: sessionID,
      agent: { provider: PROVIDER, adapter: `sse@${ADAPTER_VERSION}`, ...(model ? { model } : {}) },
    };
  }

  private cwdFor(sessionID: string): string {
    return this.sessions.get(sessionID)?.cwd ?? this.ctx.cwd ?? '.';
  }

  translate(raw: unknown): AdapterEvent[] {
    const parsed = OpenCodeEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new AdapterError('invalid_event', parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { type } = parsed.data;
    const d = parsed.data.data;
    const sessionID = d.sessionID;

    switch (type) {
      case 'session.created': {
        const model = modelRef(d.model);
        const cwd = locationCwd(d.location, this.ctx.cwd ?? '.');
        this.sessions.set(sessionID, { ...(model ? { model } : {}), cwd });
        const version =
          str(d.version) ?? (num(d.version) !== undefined ? String(d.version) : undefined);
        return [
          {
            ...this.baseFor(sessionID),
            type: 'session.started',
            payload: {
              cwd,
              fidelity: 'high',
              ...(model ? { model } : {}),
              ...(version ? { provider_version: version } : {}),
            },
          },
        ];
      }

      case 'session.model.selected': {
        const model = modelRef(d.model);
        if (model) {
          const s = this.sessions.get(sessionID) ?? {};
          this.sessions.set(sessionID, { ...s, model });
        }
        return [];
      }

      case 'session.execution.started':
        return [
          { ...this.baseFor(sessionID), type: 'session.status', payload: { status: 'running' } },
        ];

      case 'session.execution.succeeded':
        return [
          { ...this.baseFor(sessionID), type: 'session.status', payload: { status: 'idle' } },
        ];

      case 'session.execution.failed':
        return [
          {
            ...this.baseFor(sessionID),
            type: 'session.status',
            payload: { status: 'idle', detail: truncate(`error: ${errorMessage(d.error)}`, 200) },
          },
        ];

      case 'session.execution.interrupted':
        return [
          {
            ...this.baseFor(sessionID),
            type: 'session.status',
            payload: { status: 'idle', detail: `interrupted:${str(d.reason) ?? 'unknown'}` },
          },
        ];

      case 'session.deleted': {
        this.sessions.delete(sessionID);
        for (const [id, tool] of this.tools) {
          if (tool.sessionID === sessionID) this.tools.delete(id);
        }
        return [
          { ...this.baseFor(sessionID), type: 'session.ended', payload: { reason: 'completed' } },
        ];
      }

      case 'session.tool.input.started': {
        const id = str(d.id);
        const name = str(d.name);
        if (id && name) this.tools.set(id, { sessionID, name });
        return [];
      }

      case 'session.tool.called': {
        const id = str(d.id);
        const input = asRecord(d.input);
        const prev = id ? this.tools.get(id) : undefined;
        const name = prev?.name ?? 'unknown';
        if (id) this.tools.set(id, { sessionID, name, input });
        return [
          {
            ...this.baseFor(sessionID),
            type: 'tool.pre',
            payload: {
              tool_name: name,
              tool_input_summary: summarizeInput(input),
              ...(id ? { tool_use_id: id } : {}),
            },
          },
        ];
      }

      case 'session.tool.success': {
        const id = str(d.id);
        const state = id ? this.tools.get(id) : undefined;
        const name = state?.name ?? 'unknown';
        const input = state?.input ?? {};
        if (id) this.tools.delete(id);
        const output = extractContent(d.content);
        const base = this.baseFor(sessionID);
        const events: AdapterEvent[] = [
          {
            ...base,
            type: 'tool.post',
            payload: {
              tool_name: name,
              success: true,
              output_excerpt: truncate(output, 2047),
              output_digest: digest(output),
              ...(id ? { tool_use_id: id } : {}),
            },
          },
        ];
        const meta = asRecord(d.metadata);
        if (name === BASH_TOOL && typeof input.command === 'string' && input.command.length > 0) {
          const exit = num(meta.exitCode) ?? num(meta.exit_code);
          events.push({
            ...base,
            type: 'command.executed',
            payload: {
              command_display: input.command,
              cwd: this.cwdFor(sessionID),
              ...(exit !== undefined ? { exit_code: exit } : {}),
            },
          });
        }
        const filePath = str(input.filePath) ?? str(input.file_path);
        // edit/write tell us a file was touched, not whether it was created or
        // overwritten; 'modify' is the honest conservative kind (git reconciles).
        if (EDIT_TOOLS.has(name) && filePath) {
          events.push({
            ...base,
            type: 'file.changed',
            payload: { path: filePath, change_kind: 'modify', source: 'agent_tool' },
          });
        }
        return events;
      }

      case 'session.tool.failed': {
        const id = str(d.id);
        const state = id ? this.tools.get(id) : undefined;
        const name = state?.name ?? 'unknown';
        if (id) this.tools.delete(id);
        const msg = errorMessage(d.error) || extractContent(d.content);
        return [
          {
            ...this.baseFor(sessionID),
            type: 'tool.failed',
            payload: {
              tool_name: name,
              error_class: 'tool_error',
              error_excerpt: truncate(msg, 2047),
              ...(id ? { tool_use_id: id } : {}),
            },
          },
        ];
      }

      // input.ended/delta/progress, text/reasoning/step/compaction/usage/shell/
      // revert/skill/inbox/permissions/metadata/viewed/retry and any future event
      // have no clean protocol-v1 telemetry mapping (or are diagnostic-only).
      // Emit nothing rather than fabricate activity or misattribute state.
      default:
        return [];
    }
  }
}

/** Stateless convenience for a single frame (no cross-event tool correlation). */
export function translateEvent(raw: unknown, ctx: AdapterContext): AdapterEvent[] {
  return new OpenCodeTranslator(ctx).translate(raw);
}
