import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'codex';
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
  enforcement: { preToolUse: boolean; mode: 'sync' | 'async' | 'none' };
  emittedTypes: readonly string[];
}

/**
 * Codex Hooks framework (hooks.json / [hooks] in config.toml). The wire format
 * is Claude-compatible: session_id, cwd, hook_event_name, tool_name, tool_input,
 * tool_use_id, tool_response. PreToolUse can deny synchronously, but Codex treats
 * hooks as a fail-open guardrail (an error/timeout/malformed response lets the
 * tool run), not a hard enforcement boundary — hence preToolUse:true, mode:sync
 * declares participation, not a guarantee.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'hooks',
  version: ADAPTER_VERSION,
  fidelity: 'high',
  transport: ['http', 'command'],
  enforcement: { preToolUse: true, mode: 'sync' },
  emittedTypes: [
    'session.started',
    'session.status',
    'session.ended',
    'prompt.submitted',
    'tool.pre',
    'tool.post',
    'tool.failed',
    'command.executed',
    'file.changed',
  ],
};

/**
 * Legacy `notify` config.toml program hook. Fires only on agent-turn-complete
 * with a single argv JSON blob (type, thread-id, turn-id, cwd, input-messages,
 * last-assistant-message). No tool/file/command detail and no enforcement —
 * declared low fidelity so the UI never overstates what Codex notify observes.
 */
export const NOTIFY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'notify',
  version: ADAPTER_VERSION,
  fidelity: 'low',
  transport: ['command', 'http'],
  enforcement: { preToolUse: false, mode: 'none' },
  emittedTypes: ['session.status'],
};