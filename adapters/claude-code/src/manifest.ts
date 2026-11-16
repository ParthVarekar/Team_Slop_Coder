import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'claude-code';
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
