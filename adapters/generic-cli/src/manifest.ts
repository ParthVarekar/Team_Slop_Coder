import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'generic';
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
 * Generic CLI wrapper. There are no native hooks: a thin external wrapper script
 * around an arbitrary CLI coding agent POSTs normalized lifecycle/command/file
 * events to the daemon. It observes process lifecycle, executed commands, and
 * reported file changes only — there is no tool-level transcript, no PreToolUse
 * participation, and no enforcement boundary. Declared low fidelity so the UI
 * never overstates what the wrapper can see; preToolUse:false / mode:none /
 * hardBlock:false keep the daemon from treating it as a hard reservation gate.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'wrap',
  version: ADAPTER_VERSION,
  fidelity: 'low',
  transport: ['command', 'http'],
  enforcement: { preToolUse: false, mode: 'none', hardBlock: false },
  emittedTypes: [
    'session.started',
    'session.status',
    'session.ended',
    'command.executed',
    'file.changed',
  ],
};
