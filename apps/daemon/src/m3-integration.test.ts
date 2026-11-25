import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WeftConfigSchema } from '@weft/core';
import { makeId, ulid, PROTOCOL_VERSION, type StoredEvent } from '@weft/protocol';
import { Daemon } from './daemon.js';
import { createApiServer, type ApiServer } from './api.js';

const dirs: string[] = [];

function g(repo: string, args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'weft-m3-repo-'));
  dirs.push(dir);
  g(dir, ['init', '-q', '-b', 'main']);
  g(dir, ['config', 'user.name', 'Test']);
  g(dir, ['config', 'user.email', 'test@example.com']);
  g(dir, ['config', 'commit.gpgsign', 'false']);
  g(dir, ['config', 'core.autocrlf', 'false']);
  writeFiles(dir, files);
  g(dir, ['add', '-A']);
  g(dir, ['commit', '-q', '-m', 'base']);
  return dir;
}

function branchRepo(
  base: Record<string, string>,
  branches: Record<string, Record<string, string>>,
): string {
  const dir = makeRepo(base);
  for (const [name, files] of Object.entries(branches)) {
    g(dir, ['checkout', '-q', '-b', name]);
    writeFiles(dir, files);
    g(dir, ['add', '-A']);
    g(dir, ['commit', '-q', '-m', name]);
    g(dir, ['checkout', '-q', 'main']);
  }
  return dir;
}

const BASE = {
  'src/lib.ts': 'export function getUser(id: string): string { return id; }\n',
  'src/caller.ts':
    "import { getUser } from './lib';\nexport function run(): string { return getUser('x'); }\n",
};

describe('M3 end-to-end: index -> overlap -> context -> enforcement', () => {
  let teamDir: string;
  let daemon: Daemon;
  let api: ApiServer;
  let secret: string;

  const auth = () => ({ authorization: `Bearer ${secret}` });

  function storedEvent(
    seq: number,
    type: string,
    payload: Record<string, unknown>,
    repoId: string,
  ): StoredEvent {
    return {
      v: PROTOCOL_VERSION,
      event_id: ulid(),
      device_id: 'device_server',
      project_id: daemon.identity.project_id,
      repo_id: repoId,
      ts: new Date().toISOString(),
      type,
      actor: { user_id: daemon.identity.user_id, agent: null },
      privacy: 'metadata',
      payload,
      global_seq: seq,
      received_at: new Date().toISOString(),
    };
  }

  function seedSession(
    providerSessionId: string,
    taskId: string | null,
    providerId: string,
  ): string {
    const sessionId = makeId('session');
    daemon.store.upsertSession({
      session_id: sessionId,
      device_id: daemon.identity.device_id,
      provider_id: providerId,
      provider_session_id: providerSessionId,
      task_id: taskId,
      developer_id: null,
      cwd: null,
      status: 'running',
      started_at: new Date().toISOString(),
      ended_at: null,
      model: null,
      prompt_summary: null,
      fidelity: 'high',
    });
    return sessionId;
  }

  function preToolUse(providerSessionId: string, toolName: string, input: Record<string, unknown>) {
    return {
      session_id: providerSessionId,
      hook_event_name: 'PreToolUse',
      tool_name: toolName,
      tool_input: input,
      cwd: '/repo',
    };
  }

  beforeEach(() => {
    teamDir = mkdtempSync(join(tmpdir(), 'weft-m3-team-'));
    const config = WeftConfigSchema.parse({
      dataDir: teamDir,
      logLevel: 'fatal',
      mode: 'team',
      server: { url: 'http://127.0.0.1:7420', token: 'test-token' },
    });
    // Constructed but never started(): no shipper/coordination timers, so the test
    // stays offline. The coordination mirror is simulated by feeding global_seq'd
    // events straight into the caches, exactly as the SSE client would.
    daemon = new Daemon({ config });
    api = createApiServer(daemon);
    secret = daemon.identity.hook_secret;
    daemon.enforcement?.setStale(false);
    daemon.changeCache?.setStale(false);
    daemon.taskCache?.setStale(false);
  });

  afterEach(async () => {
    await api.close();
    await daemon.shipper?.stop();
    daemon.pipeline.stop();
    daemon.store.close();
    rmSync(teamDir, { recursive: true, force: true });
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      } catch {
        /* Windows transient handles */
      }
    }
  });

  it('signature change flows from the symbol index to a bounded agent context and a hard lock', async () => {
    const dir = branchRepo(BASE, {
      taskA: {
        'src/lib.ts': 'export function getUser(id: number): string { return String(id); }\n',
      },
      taskB: {
        'src/caller.ts':
          "import { getUser } from './lib';\nexport function run(): string { return getUser('y'); }\n",
      },
    });
    const repo = await daemon.repos.register(dir);

    // M3.1/M3.2: index the base + both task branches, then sweep for symbol overlap
    // and signature impact. taskA changes getUser's signature; taskB edits a caller.
    const sweep = await daemon.overlap.sweep(repo.repo_id, [
      { taskId: 'taskA', branch: 'taskA' },
      { taskId: 'taskB', branch: 'taskB' },
    ]);
    expect(sweep.impacts).toHaveLength(1);
    const impact = sweep.impacts[0];
    expect(impact?.name).toBe('getUser');
    expect(impact?.old_signature).toBe('getUser(id: string): string');
    expect(impact?.new_signature).toBe('getUser(id: number): string');
    expect(
      impact?.callers.some((c) => c.file_path === 'src/caller.ts' && c.from_symbol === 'run'),
    ).toBe(true);
    expect(impact?.affected_task_ids).toContain('taskB');

    // The sweep emitted conflict.detected cards into the durable pipeline.
    daemon.pipeline.flush();
    const emitted = daemon.store
      .getEvents({ limit: 1000 })
      .filter((e) => e.type === 'conflict.detected');
    expect(emitted.length).toBeGreaterThan(0);
    const impactEvent = emitted.find(
      (e) => (e.payload as { kind?: string }).kind === 'signature_impact',
    );
    expect(impactEvent).toBeDefined();

    // M3.5: the coordination mirror projects those cards into the change cache.
    const cache = daemon.changeCache;
    if (!cache) throw new Error('expected team-mode change cache');
    let seq = 1;
    for (const e of emitted) {
      cache.applyEvent(
        storedEvent(seq++, e.type, e.payload as Record<string, unknown>, repo.repo_id),
      );
    }
    expect(cache.impactsFor('taskB', repo.repo_id)).toHaveLength(1);

    // A hard reservation on the caller file, held by taskA on another device.
    const enforcement = daemon.enforcement;
    if (!enforcement) throw new Error('expected team-mode enforcement cache');
    enforcement.applyEvent(
      storedEvent(
        seq++,
        'reservation.acquired',
        {
          path_glob: 'src/caller.ts',
          mode: 'hard',
          holder_task_id: 'taskA',
          holder_device_id: 'device_other',
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          grace_until: new Date(Date.now() + 3_630_000).toISOString(),
        },
        repo.repo_id,
      ),
    );

    // taskB is a local task scoped to the caller file so the context assembler
    // surfaces the impact + reservation that affect it.
    const taskB = daemon.tasks.create({
      title: 'Update caller',
      repoId: repo.repo_id,
      expectedFiles: ['src/caller.ts'],
      branch: 'taskB',
    });
    // Re-key the projected impact onto the real local task id.
    cache.applyEvent(
      storedEvent(
        seq++,
        'conflict.detected',
        {
          ...(impactEvent?.payload as Record<string, unknown>),
          task_ids: ['taskA', taskB.task_id],
          evidence: [
            {
              ...((impactEvent?.payload as { evidence?: Record<string, unknown>[] })
                .evidence?.[0] ?? {}),
              affected_task_ids: [taskB.task_id],
            },
          ],
        },
        repo.repo_id,
      ),
    );

    // M3.5: the agent-facing context is bounded (<=2KB) and carries the signature
    // change + hard lock, never a raw event dump.
    const ctx = await daemon.mcp.getConcurrentChanges(taskB.task_id, { budgetBytes: 2048 });
    expect(ctx.used_bytes).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(ctx.text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(ctx.text).toContain('getUser');
    expect(ctx.text).toContain('SIGNATURE CHANGE');
    expect(ctx.text).toContain('RESERVATION hard');
    expect(ctx.text).not.toContain('"event_id"');
    expect(ctx.text).not.toContain('"global_seq"');
    expect(ctx.text).not.toContain('"payload"');

    // M3.4: a rival Claude Code session editing the reserved caller file is denied
    // (hardBlock); the holder is allowed; Codex auto-downgrades to a labeled warn.
    seedSession('sess_rival', taskB.task_id, 'claude-code');
    seedSession('sess_holder', 'taskA', 'claude-code');
    const codexSessionId = seedSession('sess_codex', taskB.task_id, 'codex');

    const deny = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/claude',
      headers: auth(),
      payload: preToolUse('sess_rival', 'Edit', { file_path: 'src/caller.ts' }),
    });
    expect(deny.statusCode).toBe(200);
    expect(deny.json().hookSpecificOutput.permissionDecision).toBe('deny');
    expect(deny.json().hookSpecificOutput.permissionDecisionReason).toContain('src/caller.ts');

    const allow = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/claude',
      headers: auth(),
      payload: preToolUse('sess_holder', 'Edit', { file_path: 'src/caller.ts' }),
    });
    expect(allow.statusCode).toBe(202);

    const downgrade = await api.app.inject({
      method: 'POST',
      url: '/v1/hooks/codex',
      headers: auth(),
      payload: preToolUse('sess_codex', 'Edit', { file_path: 'src/caller.ts' }),
    });
    expect(downgrade.statusCode).toBe(202);
    expect(downgrade.json().hookSpecificOutput).toBeUndefined();
    daemon.pipeline.flush();
    const codexPre = daemon.store
      .getEvents({ sessionId: codexSessionId })
      .find((e) => e.type === 'tool.pre');
    expect((codexPre?.payload as { reservation_downgraded?: boolean }).reservation_downgraded).toBe(
      true,
    );
  });

  it('keeps the context bounded under a storm of overlapping cards', async () => {
    const dir = makeRepo({ 'src/lib.ts': 'export function foo(): number { return 1; }\n' });
    const repo = await daemon.repos.register(dir);
    const cache = daemon.changeCache;
    if (!cache) throw new Error('expected team-mode change cache');

    const task = daemon.tasks.create({
      title: 'Storm task',
      repoId: repo.repo_id,
      expectedFiles: ['src/lib.ts'],
    });
    let seq = 1;
    for (let i = 0; i < 200; i++) {
      cache.applyEvent(
        storedEvent(
          seq++,
          'conflict.detected',
          {
            canonical_key: `symbol_overlap:storm:${i}`,
            kind: 'symbol_overlap',
            severity: 'warning',
            state: 'open',
            task_ids: [task.task_id, `rival_${i}`],
            paths: ['src/lib.ts'],
            repo_id: repo.repo_id,
            evidence: [
              {
                kind: 'symbol-overlap',
                symbols: [{ name: `sym${i}`, file_path: 'src/lib.ts' }],
              },
            ],
          },
          repo.repo_id,
        ),
      );
    }
    const ctx = await daemon.mcp.getConcurrentChanges(task.task_id, { budgetBytes: 2048 });
    expect(ctx.used_bytes).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(ctx.text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(ctx.truncated).toBe(true);
    expect(ctx.dropped).toBeGreaterThan(0);
    expect(ctx.text).not.toContain('"payload"');
  });
});
