import { metrics, redact, runCheck, scrubEnv, type Logger } from '@weft/core';

const gatesRun = metrics.counter('weft_contract_gates_run_total', 'Contract gates executed');
const gatesBlocking = metrics.counter(
  'weft_contract_gates_blocking_total',
  'Contract gates reporting breaking changes',
);

export type ContractTool = 'oasdiff' | 'buf' | 'squawk' | 'prisma' | 'custom';

export interface ContractGateConfig {
  gate_id: string;
  tool: ContractTool;
  command: string;
  args?: string[] | undefined;
  /** A breaking change blocks the merge (default true). */
  blocking?: boolean | undefined;
  timeoutMs?: number | undefined;
}

export interface ContractGateResult {
  gate_id: string;
  tool: ContractTool;
  exit_code: number | null;
  /** The tool reported a breaking/unsafe change (non-zero exit). */
  breaking: boolean;
  blocking: boolean;
  duration_ms: number;
  log_excerpt: string;
  timed_out: boolean;
}

export interface ContractGateEvaluation {
  ok: boolean;
  blocking: ContractGateResult[];
  passed: ContractGateResult[];
}

export interface ContractGateRunnerOptions {
  timeoutMs?: number | undefined;
  outputCapBytes?: number | undefined;
  excerptBytes?: number | undefined;
  logger?: Logger | undefined;
}

/**
 * Runs configured contract gates (oasdiff for OpenAPI, buf for protobuf, squawk
 * for SQL migrations, prisma for schema diffs — or any custom command). These
 * tools signal a breaking/unsafe change with a non-zero exit; the runner records
 * that as breaking and, when the gate is blocking, the merge must not proceed.
 * The command is whatever the project configures (the real tool binary when
 * installed); execution is sandboxed with a scrubbed env, timeout, and capped +
 * redacted output, exactly like validation checks. The server never runs these —
 * they execute on the daemon that owns the worktree.
 */
export class ContractGateRunner {
  private readonly timeoutMs: number;
  private readonly outputCapBytes: number;
  private readonly excerptBytes: number;

  constructor(private readonly options: ContractGateRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.outputCapBytes = options.outputCapBytes ?? 1_048_576;
    this.excerptBytes = options.excerptBytes ?? 4096;
  }

  async run(gates: ContractGateConfig[], cwd: string): Promise<ContractGateResult[]> {
    const env = scrubEnv();
    const results: ContractGateResult[] = [];
    for (const gate of gates) {
      const result = await runCheck({
        cwd,
        command: gate.command,
        args: gate.args ?? [],
        env,
        timeoutMs: gate.timeoutMs ?? this.timeoutMs,
        outputCapBytes: this.outputCapBytes,
      });
      const exitCode = result.timedOut ? null : result.exitCode;
      const breaking = exitCode === null || exitCode !== 0;
      const blocking = gate.blocking ?? true;
      const ev: ContractGateResult = {
        gate_id: gate.gate_id,
        tool: gate.tool,
        exit_code: exitCode,
        breaking,
        blocking,
        duration_ms: Math.round(result.durationMs),
        log_excerpt: redact(result.output.slice(-this.excerptBytes)),
        timed_out: result.timedOut,
      };
      results.push(ev);
      gatesRun.inc();
      if (breaking && blocking) gatesBlocking.inc();
      this.options.logger?.debug(
        { gateId: gate.gate_id, tool: gate.tool, exitCode, breaking },
        'contract gate executed',
      );
    }
    return results;
  }
}

/** A merge is blocked iff any blocking gate reported a breaking change. */
export function evaluateContractGates(results: ContractGateResult[]): ContractGateEvaluation {
  const blocking = results.filter((r) => r.breaking && r.blocking);
  const passed = results.filter((r) => !r.breaking);
  return { ok: blocking.length === 0, blocking, passed };
}
