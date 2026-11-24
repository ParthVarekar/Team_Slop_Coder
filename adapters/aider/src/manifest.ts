import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'aider';
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
 * Aider wrap/poll bridge. Aider has no PreToolUse hook boundary: Weft observes
 * session lifecycle and the git commits Aider reports through an external
 * wrapper. Declared low fidelity so the UI never claims tool-level transcript
 * visibility, and observe-only so reservations cannot hard-block Aider.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'wrap',
  version: ADAPTER_VERSION,
  fidelity: 'low',
  transport: ['command', 'http'],
  enforcement: { preToolUse: false, mode: 'none', hardBlock: false },
  emittedTypes: ['session.started', 'session.ended', 'commit.created', 'file.changed'],
};
