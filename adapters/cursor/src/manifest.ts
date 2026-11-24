import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'cursor';
export const ADAPTER_VERSION = '0.0.0';

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
 * Cursor Hooks are beta and the adapter wire format remains flagged for
 * re-verification. We therefore translate only documented session/tool/shell/file
 * lifecycle fields, use medium fidelity, emit nothing for subagent/unknown hooks,
 * and participate in pre-tool checks as a fail-open guardrail (no provider-native
 * deny response contract is wired yet).
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'hooks',
  version: ADAPTER_VERSION,
  fidelity: 'medium',
  transport: ['http', 'command'],
  enforcement: { preToolUse: true, mode: 'sync', hardBlock: false },
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
