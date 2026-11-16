import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { metrics } from './metrics.js';

const checkDuration = metrics.histogram(
  'weft_validation_check_ms',
  'Validation check child-process wall duration (ms)',
);
const checkTimeouts = metrics.counter(
  'weft_validation_check_timeouts_total',
  'Validation checks killed after exceeding their timeout',
);

/**
 * Env keys whose names imply secret material. Dropped before spawning a check so
 * project-configured commands never inherit API tokens, passwords, or credentials
 * from the daemon's environment. Non-secret keys (PATH, HOME, SystemRoot, TEMP…)
 * are preserved so toolchains still resolve.
 */
const SECRET_ENV_KEY =
  /(?:secret|token|password|passwd|pwd|api[_-]?key|apikey|credential|private[_-]?key|auth)/i;

export function scrubEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_ENV_KEY.test(key)) continue;
    out[key] = value;
  }
  return out;
}

export interface RunCheckOptions {
  cwd: string;
  command: string;
  args?: string[];
  /** Already-scrubbed environment; defaults to scrubEnv(process.env). */
  env?: Record<string, string>;
  timeoutMs?: number;
  outputCapBytes?: number;
}

export interface CheckRunResult {
  /**
   * Process exit code; null on spawn failure or a POSIX signal. A Windows
   * forced-kill may surface a non-zero code, so use `timedOut` (not exitCode)
   * as the authoritative timeout signal.
   */
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  /** Combined stdout+stderr, capped to outputCapBytes. */
  output: string;
  truncated: boolean;
  outputDigest: string;
  spawnError: string | null;
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Kill the child and (best-effort) its descendants so a timeout frees the slot. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => child.kill('SIGKILL'));
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}

/**
 * Run a project-configured check as a direct child process (shell:false — no
 * shell metacharacter injection). Output is capped to a shared byte budget across
 * stdout+stderr; a timeout kills the process tree. Never throws for a non-zero
 * exit or a spawn failure — the result carries the evidence (exit code, signal,
 * duration, capped output, content digest) so the caller can record it honestly.
 */
export function runCheck(options: RunCheckOptions): Promise<CheckRunResult> {
  const started = performance.now();
  const cap = options.outputCapBytes ?? 1_048_576;
  const timeoutMs = options.timeoutMs ?? 120_000;
  const env = options.env ?? scrubEnv();

  return new Promise<CheckRunResult>((resolve) => {
    let output = '';
    let bytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let child: ChildProcess;

    const finish = (
      exitCode: number | null,
      signal: string | null,
      spawnError: string | null,
    ): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const durationMs = performance.now() - started;
      checkDuration.observe(durationMs);
      if (timedOut) checkTimeouts.inc();
      resolve({
        exitCode,
        signal,
        timedOut,
        durationMs,
        output,
        truncated,
        outputDigest: digest(output),
        spawnError,
      });
    };

    try {
      child = spawn(options.command, options.args ?? [], {
        cwd: options.cwd,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      finish(null, null, messageOf(err));
      return;
    }

    const append = (chunk: Buffer): void => {
      if (bytes >= cap) {
        truncated = true;
        return;
      }
      const remaining = cap - bytes;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      output += slice.toString('utf8');
      bytes += slice.length;
      if (chunk.length > remaining) truncated = true;
    };
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);
    timer.unref?.();

    child.on('error', (err) => finish(null, null, messageOf(err)));
    child.on('close', (code, signal) => finish(code, signal, null));
  });
}