import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'cline';
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
 * Cline SDK/OTel push bridge. The bridge POSTs normalized task/tool lifecycle
 * events; Weft observes tool calls and reported results but has no synchronous
 * PreToolUse boundary. Declared medium fidelity (not a full transcript) and
 * observe-only so reservations downgrade to warnings rather than hard blocking.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'push',
  version: ADAPTER_VERSION,
  fidelity: 'medium',
  transport: ['http'],
  enforcement: { preToolUse: false, mode: 'none', hardBlock: false },
  emittedTypes: [
    'session.started',
    'session.status',
    'session.ended',
    'tool.pre',
    'tool.post',
    'tool.failed',
    'file.changed',
  ],
};
