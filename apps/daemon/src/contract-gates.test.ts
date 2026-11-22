import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ContractGateRunner,
  evaluateContractGates,
  type ContractGateConfig,
} from './contract-gates.js';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-gates-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* Windows transient handles */
    }
  }
});

/** A simulated contract tool: prints `out` and exits with `code`. */
function tool(code: number, out = ''): ContractGateConfig {
  return {
    gate_id: `gate-${code}`,
    tool: 'custom',
    command: process.execPath,
    args: ['-e', `process.stdout.write(${JSON.stringify(out)});process.exit(${code})`],
  };
}

describe('ContractGateRunner classification', () => {
  it('a non-zero exit is breaking; a zero exit passes', async () => {
    const runner = new ContractGateRunner();
    const cwd = scratch();
    const results = await runner.run(
      [
        { ...tool(1, 'breaking: removed path /users'), gate_id: 'oasdiff', tool: 'oasdiff' },
        { ...tool(0, 'no breaking changes'), gate_id: 'buf', tool: 'buf' },
      ],
      cwd,
    );
    expect(results[0]).toMatchObject({ gate_id: 'oasdiff', exit_code: 1, breaking: true, blocking: true, timed_out: false });
    expect(results[1]).toMatchObject({ gate_id: 'buf', exit_code: 0, breaking: false, blocking: true });
    expect(results[0]?.log_excerpt).toContain('breaking: removed path');
  });

  it('a non-blocking gate reports breaking but does not block', async () => {
    const runner = new ContractGateRunner();
    const results = await runner.run([{ ...tool(1), gate_id: 'advisory', blocking: false }], scratch());
    expect(results[0]).toMatchObject({ breaking: true, blocking: false });
    const evaln = evaluateContractGates(results);
    expect(evaln.ok).toBe(true);
    expect(evaln.blocking).toHaveLength(0);
  });

  it('a timed-out gate has a null exit code and is breaking', async () => {
    const runner = new ContractGateRunner({ timeoutMs: 300 });
    const gate: ContractGateConfig = {
      gate_id: 'slow',
      tool: 'custom',
      command: process.execPath,
      args: ['-e', 'setTimeout(()=>{},5000)'],
      timeoutMs: 300,
    };
    const results = await runner.run([gate], scratch());
    expect(results[0]).toMatchObject({ exit_code: null, breaking: true, timed_out: true });
  });

  it('redacts secrets in the log excerpt', async () => {
    const runner = new ContractGateRunner();
    const results = await runner.run([tool(1, 'leaked AKIAIOSFODNN7EXAMPLE in diff')], scratch());
    expect(results[0]?.log_excerpt).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(results[0]?.log_excerpt).toContain('[REDACTED:');
  });
});

describe('evaluateContractGates', () => {
  it('blocks iff a blocking gate is breaking; partitions passed gates', async () => {
    const runner = new ContractGateRunner();
    const results = await runner.run(
      [
        { ...tool(0), gate_id: 'ok', tool: 'buf' },
        { ...tool(1), gate_id: 'bad', tool: 'squawk' },
        { ...tool(1), gate_id: 'advisory', tool: 'prisma', blocking: false },
      ],
      scratch(),
    );
    const evaln = evaluateContractGates(results);
    expect(evaln.ok).toBe(false);
    expect(evaln.blocking.map((r) => r.gate_id)).toEqual(['bad']);
    expect(evaln.passed.map((r) => r.gate_id)).toEqual(['ok']);
  });

  it('is ok when every gate passes', async () => {
    const runner = new ContractGateRunner();
    const results = await runner.run([tool(0), { ...tool(0), gate_id: 'second' }], scratch());
    const evaln = evaluateContractGates(results);
    expect(evaln.ok).toBe(true);
    expect(evaln.blocking).toHaveLength(0);
    expect(evaln.passed).toHaveLength(2);
  });
});