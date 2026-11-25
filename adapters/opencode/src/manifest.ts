import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'opencode';
export const ADAPTER_VERSION = '0.0.0';

/**
 * Declares what this adapter can emit and enforce so the UI labels telemetry
 * fidelity honestly and the daemon gates hard enforcement on real capability.
 */
export interface CapabilityManifest {
  provider: string;
  adapter: string;
  version: string;
  fidelity: Fidelity;
  transport: readonly ('http' | 'command' | 'sse')[];
  enforcement: { preToolUse: boolean; mode: 'sync' | 'async' | 'none'; hardBlock: boolean };
  emittedTypes: readonly string[];
}

/**
 * OpenCode `opencode serve` exposes a durable session-event SSE stream
 * (`GET /event`). The wire frame is `{ id, type, created, data, durable }` where
 * `data` carries `sessionID` plus event-specific fields (authoritative schema:
 * opencode packages/schema/src/session-event.ts).
 *
 * Fidelity is high: the stream carries full tool input/output, lifecycle, and
 * file edits. But it is OBSERVE-ONLY — events arrive after the fact over SSE, so
 * the adapter cannot synchronously deny a tool before it runs. Hence
 * preToolUse:false, mode:none, hardBlock:false: the daemon must never treat this
 * adapter as a hard enforcement boundary (hard reservations stay advisory).
 *
 * Tool name/input/result are split across `session.tool.input.started` (name),
 * `session.tool.called` (input), and `session.tool.success`/`failed` (result),
 * correlated by the tool-call `id`. The translator therefore keeps lightweight
 * per-tool state (see OpenCodeTranslator) rather than being purely stateless.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'sse',
  version: ADAPTER_VERSION,
  fidelity: 'high',
  transport: ['sse', 'http'],
  enforcement: { preToolUse: false, mode: 'none', hardBlock: false },
  emittedTypes: [
    'session.started',
    'session.status',
    'session.ended',
    'tool.pre',
    'tool.post',
    'tool.failed',
    'command.executed',
    'file.changed',
  ],
};
