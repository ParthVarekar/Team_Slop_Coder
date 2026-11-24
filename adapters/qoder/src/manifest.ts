import type { Fidelity } from '@weft/protocol';

export const PROVIDER = 'qoder';
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
 * Qoder's Claude-compatible native hook catalog (re-verified against primary
 * docs): session_id/cwd/hook_event_name/tool_name/tool_input/tool_response plus
 * PreToolUse/PostToolUse/SessionStart/Stop/SessionEnd. PreToolUse participates
 * synchronously, but Weft's HTTP bridge currently returns an advisory response
 * rather than a provider-native deny contract, so hardBlock is false and hard
 * reservations downgrade to warnings instead of pretending to guarantee a block.
 */
export const CAPABILITY_MANIFEST: CapabilityManifest = {
  provider: PROVIDER,
  adapter: 'hooks',
  version: ADAPTER_VERSION,
  fidelity: 'high',
  transport: ['http', 'command'],
  enforcement: { preToolUse: true, mode: 'sync', hardBlock: false },
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
