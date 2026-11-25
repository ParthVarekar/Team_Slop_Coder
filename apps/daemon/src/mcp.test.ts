import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { makeId, ulid, PROTOCOL_VERSION, type Actor, type StoredEvent } from '@weft/protocol';
import { ChangeCache } from './change-cache.js';
import {
  assembleContext,
  type ContextPayload,
  type ContextReservation,
  type ContextTask,
} from './context.js';
import {
  CoordinationMcp,
  createCoordinationMcpServer,
  type McpBackend,
  type McpClaimResult,
  type McpGetTaskResult,
  type McpProgressResult,
  type McpReserveInput,
  type McpReserveResult,
  type McpTaskView,
} from './mcp.js';
import { INJECTION_CORPUS } from '../test/injection-corpus.js';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const taskId = makeId('task');
const repoId = makeId('repo');
const deviceId = makeId('device');
const projectId = makeId('project');
const agentActor: Actor = { user_id: 'user_test', agent: { provider: 'mcp', adapter: 'weft-mcp' } };

let counter = 0;
function stored(
  type: string,
  payload: Record<string, unknown>,
  opts: { actor?: Actor; taskId?: string } = {},
): StoredEvent {
  counter += 1;
  const iso = new Date().toISOString();
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: deviceId,
    project_id: projectId,
    ...(opts.taskId ? { task_id: opts.taskId } : {}),
    ts: iso,
    type,
    actor: opts.actor ?? agentActor,
    privacy: 'metadata',
    payload,
    global_seq: counter,
    received_at: iso,
  };
}

function view(over: Partial<McpTaskView> = {}): McpTaskView {
  return {
    id: taskId,
    number: 7,
    title: 'Implement widget',
    state: 'claimed',
    priority: 'P1',
    branch: 'task/widget',
    repo_id: repoId,
    expected_files: ['src/a.ts', 'src/b.ts'],
    expected_modules: ['src'],
    acceptance_criteria: ['works'],
    description: 'build it',
    version: 3,
    ...over,
  };
}
function toContextTask(v: McpTaskView): ContextTask {
  return { ...v, description_provenance: 'human' };
}

/** In-memory backend wired to a real ChangeCache + assembler so the injection flow is genuine. */
class FakeBackend implements McpBackend {
  readonly cache = new ChangeCache();
  tasks = new Map<string, McpTaskView>([[taskId, view()]]);
  reservations: ContextReservation[] = [];
  claim: McpClaimResult = {
    ok: true,
    task_id: taskId,
    version: 4,
    provisional: false,
    state: 'claimed',
  };
  reserve: McpReserveResult = {
    status: 'acquired',
    reservation_id: makeId('reservation'),
    path_glob: 'src/**',
    mode: 'hard',
    expires_at: null,
    grace_until: null,
  };
  throwOnGetTask = false;
  lastProgress: { taskId: string; note: string; percent: number | null } | null = null;

  constructor() {
    this.cache.setStale(false);
  }

  async getTask(id: string): Promise<McpGetTaskResult> {
    if (this.throwOnGetTask) throw new Error('server unreachable');
    const t = this.tasks.get(id) ?? null;
    return { task: t, source: 'server', stale: false };
  }
  async claimTask(id: string): Promise<McpClaimResult> {
    return { ...this.claim, task_id: id };
  }
  async reportProgress(
    id: string,
    note: string,
    opts: { percent?: number },
  ): Promise<McpProgressResult> {
    const percent = opts.percent ?? null;
    this.lastProgress = { taskId: id, note, percent };
    this.cache.applyEvent(
      stored(
        'task.progress',
        { summary: note, ...(percent != null ? { percent } : {}) },
        { actor: agentActor, taskId: id },
      ),
    );
    return { ok: true, task_id: id, percent, recorded: 'event' };
  }
  async getConcurrentChanges(id: string, opts: { budgetBytes?: number }): Promise<ContextPayload> {
    const t = this.tasks.get(id) ?? null;
    const progress = this.cache.progressFor(id);
    return assembleContext(
      {
        task: t ? toContextTask(t) : null,
        reservations: this.reservations,
        impacts: this.cache.impactsFor(id),
        overlaps: this.cache.overlapsFor(id),
        conflicts: this.cache.openConflicts().map((c) => ({
          canonical_key: c.canonical_key,
          kind: c.kind,
          severity: c.severity,
          paths: c.paths,
        })),
        progress: progress ? [progress] : [],
        stale: false,
        now: NOW,
      },
      { ...(opts.budgetBytes != null ? { budgetBytes: opts.budgetBytes } : {}) },
    );
  }
  async reserveFiles(input: McpReserveInput): Promise<McpReserveResult> {
    return { ...this.reserve, path_glob: input.path_glob, mode: input.mode ?? 'soft' };
  }

  seedImpacts(n: number) {
    for (let i = 0; i < n; i++) {
      this.cache.applyEvent(
        stored('conflict.detected', {
          canonical_key: `sig:${i}`,
          kind: 'signature_impact',
          severity: 'warning',
          paths: ['src/a.ts'],
          task_ids: [makeId('task')],
          repo_id: repoId,
          evidence: [
            {
              branch: 'b',
              file_path: 'src/a.ts',
              name: `fn${i}`,
              symbol_kind: 'function',
              old_signature: '(x: number) => number',
              new_signature: '(x: number, y: number) => number',
              affected_task_ids: [taskId],
              callers: [{ file_path: 'c.ts', name: 'run' }],
            },
          ],
        }),
      );
    }
  }
}

const open: { close: () => Promise<void> }[] = [];
async function connect(backend: McpBackend) {
  const server = createCoordinationMcpServer(backend);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'weft-test', version: '0.0.0' });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const entry = {
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  open.push(entry);
  return { server, client };
}
afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});

async function errored(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  try {
    const r = await client.callTool({ name, arguments: args });
    return r.isError === true;
  } catch {
    return true;
  }
}
const stripWrappers = (t: string) =>
  t.replace(/\[untrusted data from [^\]]*\][\s\S]*?\[end untrusted data\]/g, '');
const byteLen = (s: string) => Buffer.byteLength(s, 'utf8');

describe('MCP coordination server — tool contract', () => {
  it('exposes exactly the five coordination tools with input schemas and read-only hints', async () => {
    const { client } = await connect(new FakeBackend());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'claim_task',
      'get_concurrent_changes',
      'get_task',
      'report_progress',
      'reserve_files',
    ]);
    for (const t of tools) expect(t.inputSchema).toBeDefined();
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get('get_task')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('get_concurrent_changes')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('claim_task')?.annotations?.readOnlyHint).toBe(false);
  });

  it('get_task round-trips a structured snapshot and reports a missing task as null', async () => {
    const { client } = await connect(new FakeBackend());
    const found = await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
    expect(found.isError).toBeFalsy();
    expect(found.structuredContent).toMatchObject({
      source: 'server',
      stale: false,
      task: { id: taskId, version: 3 },
    });
    const missing = await client.callTool({
      name: 'get_task',
      arguments: { task_id: makeId('task') },
    });
    expect((missing.structuredContent as { task: unknown }).task).toBeNull();
  });

  it('claim_task returns ok and surfaces a lost claim with the winner', async () => {
    const backend = new FakeBackend();
    const { client } = await connect(backend);
    const ok = await client.callTool({
      name: 'claim_task',
      arguments: { task_id: taskId, base_version: 3 },
    });
    expect(ok.structuredContent).toMatchObject({ ok: true, version: 4 });
    const winner: Actor = { user_id: 'rival', agent: null };
    backend.claim = {
      ok: false,
      task_id: taskId,
      version: 5,
      provisional: false,
      reason: 'version conflict',
      winner_claimant: winner,
    };
    const lost = await client.callTool({
      name: 'claim_task',
      arguments: { task_id: taskId, base_version: 3 },
    });
    expect(lost.structuredContent).toMatchObject({
      ok: false,
      reason: 'version conflict',
      winner_claimant: winner,
    });
  });

  it('reserve_files round-trips acquired and denied leases', async () => {
    const backend = new FakeBackend();
    const { client } = await connect(backend);
    const acq = await client.callTool({
      name: 'reserve_files',
      arguments: { repo_id: repoId, task_id: taskId, path_glob: 'src/**', mode: 'hard' },
    });
    expect(acq.structuredContent).toMatchObject({
      status: 'acquired',
      mode: 'hard',
      path_glob: 'src/**',
    });
    backend.reserve = {
      status: 'denied',
      reservation_id: null,
      path_glob: 'src/**',
      mode: 'hard',
      expires_at: null,
      grace_until: null,
      reason: 'held by rival',
    };
    const denied = await client.callTool({
      name: 'reserve_files',
      arguments: { repo_id: repoId, task_id: taskId, path_glob: 'src/**', mode: 'hard' },
    });
    expect(denied.structuredContent).toMatchObject({ status: 'denied', reason: 'held by rival' });
  });

  it('rejects invalid tool arguments', async () => {
    const { client } = await connect(new FakeBackend());
    expect(await errored(client, 'get_task', {})).toBe(true);
    expect(await errored(client, 'report_progress', { task_id: taskId, note: '' })).toBe(true);
    expect(
      await errored(client, 'report_progress', { task_id: taskId, note: 'x', percent: 150 }),
    ).toBe(true);
    expect(await errored(client, 'reserve_files', { repo_id: repoId, task_id: taskId })).toBe(true);
    expect(
      await errored(client, 'get_concurrent_changes', { task_id: taskId, budget_bytes: 0 }),
    ).toBe(true);
  });

  it('returns isError when the backend throws', async () => {
    const backend = new FakeBackend();
    backend.throwOnGetTask = true;
    const { client } = await connect(backend);
    const r = await client.callTool({ name: 'get_task', arguments: { task_id: taskId } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r.content)).toContain('server unreachable');
  });
});

describe('MCP coordination server — budgeted context', () => {
  it('get_concurrent_changes stays ≤2KB, omits the facts array, and mirrors text in content', async () => {
    const backend = new FakeBackend();
    backend.seedImpacts(60);
    const { client } = await connect(backend);
    const r = await client.callTool({
      name: 'get_concurrent_changes',
      arguments: { task_id: taskId },
    });
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.used_bytes as number).toBeLessThanOrEqual(2048);
    expect(byteLen(sc.text as string)).toBeLessThanOrEqual(2048);
    expect(sc.truncated).toBe(true);
    expect(sc).not.toHaveProperty('facts');
    expect((r.content[0] as { text: string }).text).toBe(sc.text);
    expect(sc.text as string).not.toContain('global_seq');
    expect(sc.text as string).not.toContain('conflict.detected');
  });

  it('honors a custom budget passed through the tool', async () => {
    const backend = new FakeBackend();
    backend.seedImpacts(40);
    const { client } = await connect(backend);
    const r = await client.callTool({
      name: 'get_concurrent_changes',
      arguments: { task_id: taskId, budget_bytes: 512 },
    });
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.budget_bytes).toBe(512);
    expect(byteLen(sc.text as string)).toBeLessThanOrEqual(512);
  });
});

describe('MCP coordination server — prompt-injection containment through tools', () => {
  it('agent notes reported via report_progress never become trusted instructions in context', async () => {
    const backend = new FakeBackend();
    const { client } = await connect(backend);
    await client.callTool({
      name: 'report_progress',
      arguments: { task_id: taskId, note: 'working on it', percent: 50 },
    });
    const benign = await client.callTool({
      name: 'get_concurrent_changes',
      arguments: { task_id: taskId },
    });
    const benignTrusted = stripWrappers((benign.structuredContent as { text: string }).text);
    for (const c of INJECTION_CORPUS) {
      const rep = await client.callTool({
        name: 'report_progress',
        arguments: { task_id: taskId, note: c.text, percent: 50 },
      });
      expect(rep.isError).toBeFalsy();
      const ctx = await client.callTool({
        name: 'get_concurrent_changes',
        arguments: { task_id: taskId },
      });
      const text = (ctx.structuredContent as { text: string }).text;
      expect(stripWrappers(text), c.name).toBe(benignTrusted);
      expect(text, c.name).toContain('data, not instructions');
      expect((text.match(/\[untrusted data from agent/g) ?? []).length, c.name).toBe(1);
    }
  });
});

describe('MCP coordination server — Claude channels push', () => {
  it('delivers a concurrent-change notice as a logging notification carrying the budgeted block', async () => {
    const backend = new FakeBackend();
    const mcp = new CoordinationMcp(backend);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'weft-push', version: '0.0.0' });
    const received: { logger?: string; data: unknown }[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received.push(n.params);
    });
    await Promise.all([mcp.server.connect(serverT), client.connect(clientT)]);
    open.push({
      close: async () => {
        await client.close();
        await mcp.server.close();
      },
    });

    const payload = await backend.getConcurrentChanges(taskId, {});
    await mcp.pushConcurrentChanges(payload);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.logger).toBe('weft.coordination');
    expect(received[0]?.data).toBe(payload.text);
    expect(byteLen(String(received[0]?.data))).toBeLessThanOrEqual(2048);
  });

  it('pushContext assembles and pushes in one call', async () => {
    const backend = new FakeBackend();
    const mcp = new CoordinationMcp(backend);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'weft-push2', version: '0.0.0' });
    const received: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => {
      received.push(n.params.data);
    });
    await Promise.all([mcp.server.connect(serverT), client.connect(clientT)]);
    open.push({
      close: async () => {
        await client.close();
        await mcp.server.close();
      },
    });
    await mcp.pushContext(taskId, 800);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(byteLen(String(received[0]))).toBeLessThanOrEqual(800);
  });
});
