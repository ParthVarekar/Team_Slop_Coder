import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCheck, scrubEnv } from './exec.js';

const node = process.execPath;
const cwd = tmpdir();

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

describe('scrubEnv', () => {
  it('drops secret-bearing keys, preserves toolchain keys, skips undefined', () => {
    const scrubbed = scrubEnv({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      SystemRoot: 'C:\\Windows',
      NORMAL: 'visible',
      API_KEY: 'k',
      MY_PASSWORD: 'p',
      AUTH_TOKEN: 't',
      AWS_SECRET_ACCESS_KEY: 's',
      PRIVATE_KEY: 'pk',
      UNDEF: undefined,
    });
    expect(scrubbed).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/dev',
      SystemRoot: 'C:\\Windows',
      NORMAL: 'visible',
    });
  });
});

describe('runCheck', () => {
  it('captures combined stdout+stderr and a zero exit code', async () => {
    const r = await runCheck({
      cwd,
      command: node,
      args: ['-e', `process.stdout.write('out'); process.stderr.write('err')`],
    });
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
    expect(r.output).toContain('out');
    expect(r.output).toContain('err');
    expect(r.outputDigest).toBe(sha256(r.output));
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('records a non-zero exit code without throwing', async () => {
    const r = await runCheck({ cwd, command: node, args: ['-e', 'process.exit(3)'] });
    expect(r.exitCode).toBe(3);
    expect(r.timedOut).toBe(false);
    expect(r.spawnError).toBeNull();
  });

  it('caps output to the byte budget and flags truncation', async () => {
    const r = await runCheck({
      cwd,
      command: node,
      args: ['-e', `process.stdout.write('x'.repeat(5000))`],
      outputCapBytes: 100,
    });
    expect(Buffer.byteLength(r.output)).toBeLessThanOrEqual(100);
    expect(r.truncated).toBe(true);
    expect(r.exitCode).toBe(0);
    expect(r.outputDigest).toBe(sha256(r.output));
  });

  it('kills a long-running check on timeout and flags it authoritatively', async () => {
    const r = await runCheck({
      cwd,
      command: node,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      timeoutMs: 250,
    });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(10_000);
  });

  it('reports a spawn failure honestly instead of throwing', async () => {
    const r = await runCheck({
      cwd,
      command: 'weft-no-such-binary-xyz',
      args: [],
    });
    expect(r.exitCode).toBeNull();
    expect(r.spawnError).not.toBeNull();
    expect(r.timedOut).toBe(false);
  });

  it('never leaks secret env vars to the child but preserves normal ones', async () => {
    const env = scrubEnv({
      ...process.env,
      WEFT_TEST_TOKEN: 'super-secret',
      WEFT_TEST_NORMAL: 'visible',
    });
    const r = await runCheck({
      cwd,
      command: node,
      args: [
        '-e',
        `process.stdout.write(JSON.stringify({ tok: process.env.WEFT_TEST_TOKEN ?? null, norm: process.env.WEFT_TEST_NORMAL ?? null }))`,
      ],
      env,
    });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.output) as { tok: string | null; norm: string | null };
    expect(parsed.tok).toBeNull();
    expect(parsed.norm).toBe('visible');
  });

  it('does not interpret shell metacharacters (shell:false)', async () => {
    // With shell:false the args array is passed verbatim: ';' is just an argv
    // element to node, never a command separator, so nothing is injected.
    const r = await runCheck({
      cwd,
      command: node,
      args: ['-e', 'process.stdout.write("safe")', ';', 'echo', 'injected'],
    });
    expect(r.exitCode).toBe(0);
    expect(r.output).toBe('safe');
  });
});
