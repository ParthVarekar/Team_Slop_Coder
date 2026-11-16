import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ulid, makeId, type EventEnvelope } from '@weft/protocol';

const SAMPLE_PAYLOADS: { type: string; payload: Record<string, unknown> }[] = [
  { type: 'tool.post', payload: { tool_name: 'Edit', success: true, duration_ms: 12 } },
  {
    type: 'file.changed',
    payload: {
      path: 'src/auth/token.ts',
      change_kind: 'modify',
      source: 'agent_tool',
      lines_added: 4,
    },
  },
  { type: 'command.executed', payload: { command_display: 'pnpm test', exit_code: 0 } },
  { type: 'session.status', payload: { status: 'running' } },
  { type: 'tool.pre', payload: { tool_name: 'Bash', tool_input_summary: { command: 'ls' } } },
];

const DEVICE = makeId('device');
const PROJECT = makeId('project');
const REPO = makeId('repo');
const SESSION = makeId('session');
const USER = makeId('user');

/** Deterministic-ish synthetic protocol-v1 event for load/microbenchmarks. */
export function syntheticEvent(i: number): EventEnvelope {
  const sample = SAMPLE_PAYLOADS[i % SAMPLE_PAYLOADS.length] as {
    type: string;
    payload: Record<string, unknown>;
  };
  return {
    v: 1,
    event_id: ulid(),
    device_id: DEVICE,
    project_id: PROJECT,
    repo_id: REPO,
    session_id: SESSION,
    seq: i,
    ts: new Date().toISOString(),
    type: sample.type,
    actor: {
      user_id: USER,
      agent: { provider: 'claude-code', model: 'claude-opus-4-6', adapter: 'hooks@1.4.0' },
    },
    privacy: 'metadata',
    payload: sample.payload,
  };
}

export function syntheticEvents(n: number): EventEnvelope[] {
  return Array.from({ length: n }, (_, i) => syntheticEvent(i));
}

/** Mixed benign/secret-bearing strings for redaction throughput measurement. */
export const SAMPLE_TEXTS: string[] = [
  'The file src/auth/token.ts has been updated successfully.',
  'Modified 8 files in authentication; three functions changed.',
  `Authorization: Bearer abcdef1234567890ABCDEF`,
  `api_key = "abcdef1234567890abcdef"`,
  'Running pnpm vitest run --coverage in the worktree.',
  `ghp_${'x'.repeat(36)}`,
  'getUserById now returns User | null; callers must handle null.',
  'postgres://admin:secretpass@db.internal:5432/app',
];

/** Generate a deterministic fixture repository of TS files (for git benches). */
export function generateFixtureRepo(dir: string, fileCount: number): void {
  mkdirSync(join(dir, 'src'), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    const body = `export function fn${i}(x: number): number {\n  return x + ${i};\n}\n`;
    writeFileSync(join(dir, 'src', `mod${i}.ts`), body);
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
}
