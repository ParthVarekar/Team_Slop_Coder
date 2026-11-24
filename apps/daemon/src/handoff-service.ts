import type { StoredEvent } from '@weft/protocol';
import type { Daemon } from './daemon.js';
import { TaskError, type TaskRecord } from './tasks.js';
import type { TaskSnapshot } from '@weft/protocol';
import type { RpcReservation, RpcValidationRun } from './coordination-rpc.js';
import type { StoredLocalEvent } from './store.js';
import {
  RecapConfigSchema,
  HANDOFF_LIMITS,
  buildHandoff,
  generateRecap,
  renderHandoff,
  type HandoffBundle,
  type HandoffChange,
  type HandoffClaim,
  type HandoffReservation,
  type HandoffResult,
  type HandoffTask,
  type HandoffValidation,
} from './handoff.js';

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const CHANGE_TYPES = ['file.changed', 'symbols.changed', 'commit.created'];

export interface HandoffRequest {
  asOf?: number;
  recentSince?: number;
  recap?: boolean;
  now?: number;
}

type TaskSource = TaskSnapshot | TaskRecord;

function taskBundle(task: TaskSource): HandoffTask {
  if ('task_id' in task) {
    return {
      id: task.task_id,
      title: task.title,
      state: task.state,
      version: task.version,
      branch: task.branch,
      description: task.description,
      acceptance_criteria: task.acceptance_criteria ? [task.acceptance_criteria] : [],
      expected_files: parseArray(task.expected_files),
    };
  }
  return {
    id: task.id,
    title: task.title,
    state: task.state,
    version: task.version,
    branch: task.branch,
    description: task.description,
    acceptance_criteria: task.acceptance_criteria,
    expected_files: task.expected_files,
  };
}

function parseArray(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function eventChange(event: StoredEvent | StoredLocalEvent, taskId: string): HandoffChange | null {
  if (!CHANGE_TYPES.includes(event.type)) return null;
  const payload = event.payload as Record<string, unknown>;
  const path =
    typeof payload.path === 'string'
      ? payload.path
      : event.type === 'commit.created'
        ? '(commit)'
        : null;
  if (!path) return null;
  return {
    event_id: event.event_id,
    type: event.type,
    path,
    change_kind: typeof payload.change_kind === 'string' ? payload.change_kind : 'commit',
    occurred_at: event.ts,
    task_attributed: event.task_id === taskId,
  };
}

function validationBundle(
  run: RpcValidationRun | ReturnType<Daemon['validation']['listRuns']>[number],
): HandoffValidation {
  return {
    id: 'run_id' in run ? run.run_id : run.id,
    task_id: run.task_id,
    candidate_oid: run.candidate_oid,
    tree_oid: run.tree_oid,
    state: run.state,
    started_at: run.started_at,
    finished_at: run.finished_at,
    independence: run.independence,
    checks: run.checks.map((check) => ({
      check_id: check.check_id,
      exit_code: check.exit_code,
      selection: check.selection,
      log_digest: check.log_digest,
    })),
  };
}

function rpcReservationBundle(reservation: RpcReservation): HandoffReservation {
  return {
    key: reservation.id,
    path_glob: reservation.path_glob,
    mode: reservation.mode,
    holder_task_id: reservation.task_id,
    holder_device_id: reservation.holder_device_id ?? 'unknown',
    expires_at: reservation.expires_at,
    grace_until: reservation.grace_until,
    state: reservation.state,
  };
}

export class HandoffService {
  constructor(
    private readonly daemon: Daemon,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async get(taskId: string, request: HandoffRequest = {}): Promise<HandoffResult> {
    const now = request.now ?? Date.now();
    const asOf = request.asOf ?? now;
    const recentSince = request.recentSince ?? asOf - RECENT_WINDOW_MS;
    if (!Number.isFinite(asOf) || !Number.isFinite(recentSince) || recentSince > asOf) {
      throw new TaskError('validation', 'recent_since must not exceed as_of');
    }
    const sinceIso = new Date(recentSince).toISOString();
    const untilIso = new Date(asOf).toISOString();
    let bundle: HandoffBundle;

    if (this.daemon.config.mode === 'team' && this.daemon.rpc) {
      bundle = await this.teamBundle(taskId, asOf, recentSince, sinceIso, untilIso);
    } else {
      bundle = this.soloBundle(taskId, asOf, recentSince, sinceIso, untilIso);
    }

    const recap = request.recap
      ? await generateRecap(bundle, this.recapConfig(), this.fetchImpl)
      : null;
    return {
      task_id: taskId,
      generated_at: new Date(now).toISOString(),
      bundle,
      text: renderHandoff(bundle),
      recap,
    };
  }

  private soloBundle(
    taskId: string,
    asOf: number,
    recentSince: number,
    since: string,
    until: string,
  ): HandoffBundle {
    const task = this.daemon.tasks.getTask(taskId);
    if (!task) throw new TaskError('not_found', `task ${taskId} not found`);
    const repoId = task.repo_id;
    const events = this.daemon.store.getEvents({
      projectId: this.daemon.identity.project_id,
      ...(repoId ? { repoId } : {}),
      taskId,
      types: CHANGE_TYPES,
      since,
      until,
      newestFirst: true,
      deterministicRecent: true,
      limit: 1000,
    });
    const reservationEvents = this.daemon.store.getEvents({
      projectId: this.daemon.identity.project_id,
      ...(repoId ? { repoId } : {}),
      taskId,
      types: ['reservation.acquired', 'reservation.renewed', 'reservation.released'],
      until,
      newestFirst: true,
      deterministicRecent: true,
      limit: 1001,
    });
    const leases = new Map<string, HandoffReservation>();
    const reservationHistoryTruncated = reservationEvents.length > 1000;
    for (const event of reservationEvents.slice(0, 1000).reverse()) {
      if (
        !event.type.startsWith('reservation.') ||
        (event.task_id !== taskId && event.repo_id !== repoId)
      )
        continue;
      const payload = event.payload as Record<string, unknown>;
      const path = typeof payload.path_glob === 'string' ? payload.path_glob : null;
      if (!path) continue;
      const key =
        typeof payload.reservation_id === 'string'
          ? payload.reservation_id
          : `${event.device_id}:${path}`;
      const existing = leases.get(key);
      leases.set(key, {
        key,
        path_glob: path,
        mode: payload.mode === 'hard' ? 'hard' : 'soft',
        holder_task_id:
          typeof payload.holder_task_id === 'string'
            ? payload.holder_task_id
            : (event.task_id ?? null),
        holder_device_id:
          typeof payload.holder_device_id === 'string' ? payload.holder_device_id : event.device_id,
        expires_at:
          typeof payload.expires_at === 'string'
            ? payload.expires_at
            : (existing?.expires_at ?? null),
        grace_until:
          typeof payload.grace_until === 'string'
            ? payload.grace_until
            : (existing?.grace_until ?? null),
        state: event.type === 'reservation.released' ? 'released' : 'active',
      });
    }
    const claims: HandoffClaim[] = this.daemon.tasks
      .listClaims(taskId)
      .map((claim) => ({ ...claim }));
    const validations = this.daemon.validation
      .listRuns({ taskId, until, limit: HANDOFF_LIMITS.validations + 1 })
      .map(validationBundle);
    return buildHandoff({
      task: taskBundle(task),
      claims,
      reservations: [...leases.values()].filter((reservation) => reservation.state === 'active'),
      validations,
      changes: events
        .map((event) => eventChange(event, taskId))
        .filter((c): c is HandoffChange => c !== null),
      asOf,
      recentSince,
      taskSource: 'local',
      claimsSource: 'local',
      reservationsSource: 'local_events',
      validationSource: 'local',
      coverageReasons: [
        'solo validation coverage includes runs executed by this device',
        'task and reservation state are current projections, not historical reconstruction',
        ...(reservationHistoryTruncated
          ? ['reservation state uses only the 1000 newest durable reservation events']
          : []),
      ],
    });
  }

  private async teamBundle(
    taskId: string,
    asOf: number,
    recentSince: number,
    since: string,
    until: string,
  ): Promise<HandoffBundle> {
    const rpc = this.daemon.rpc;
    if (!rpc) throw new TaskError('not_found', `task ${taskId} not found`);
    let task: TaskSnapshot | null = null;
    let taskSource: HandoffBundle['coverage']['task'] = 'unavailable';
    const reasons: string[] = [
      'task and active reservation state are current projections, not historical reconstruction',
    ];
    try {
      task = await rpc.getTask(taskId);
      if (task) taskSource = 'authoritative';
    } catch {
      reasons.push('team server task read failed');
    }
    if (!task) {
      const cached = this.daemon.taskCache?.getTask(taskId);
      if (cached) {
        task = cached;
        taskSource = 'cache';
        reasons.push('task uses the last server projection; cache may be stale');
      }
    }
    if (!task) throw new TaskError('not_found', `task ${taskId} not found`);
    const currentTask = task;
    const repoId = currentTask.repo_id;

    const [claimsResult, reservationsResult, validationResult, changesResult] =
      await Promise.allSettled([
        Promise.resolve().then(() => rpc.listCompletionClaims(taskId)),
        repoId
          ? Promise.resolve().then(() => rpc.listReservations({ repoId, state: 'active' }))
          : Promise.reject(new Error('task has no repo')),
        Promise.resolve().then(() =>
          rpc.listValidationRuns(taskId, HANDOFF_LIMITS.validations + 1, until),
        ),
        repoId
          ? Promise.resolve().then(() => rpc.getHandoffChanges({ taskId, repoId, since, until }))
          : Promise.reject(new Error('task has no repo')),
      ]);
    if (claimsResult.status === 'rejected') reasons.push('completion claims unavailable');
    if (reservationsResult.status === 'rejected') reasons.push('server reservations unavailable');
    if (validationResult.status === 'rejected')
      reasons.push('server validation evidence unavailable');
    if (changesResult.status === 'rejected') {
      reasons.push('server recent changes unavailable; falling back to this device');
    }

    let changes =
      changesResult.status === 'fulfilled'
        ? changesResult.value.events
            .map((event) => eventChange(event, taskId))
            .filter((c): c is HandoffChange => c !== null)
        : this.daemon.store
            .getEvents({
              projectId: this.daemon.identity.project_id,
              ...(repoId ? { repoId } : {}),
              taskId,
              types: CHANGE_TYPES,
              since,
              until,
              newestFirst: true,
              deterministicRecent: true,
              limit: 1000,
            })
            .map((event) => eventChange(event, taskId))
            .filter((c): c is HandoffChange => c !== null);
    changes = [...new Map(changes.map((change) => [change.event_id, change])).values()];

    return buildHandoff({
      task: taskBundle(currentTask),
      claims: claimsResult.status === 'fulfilled' ? claimsResult.value : [],
      reservations:
        reservationsResult.status === 'fulfilled'
          ? reservationsResult.value.map(rpcReservationBundle)
          : [],
      validations:
        validationResult.status === 'fulfilled' ? validationResult.value.map(validationBundle) : [],
      changes,
      asOf,
      recentSince,
      taskSource,
      claimsSource: claimsResult.status === 'fulfilled' ? 'authoritative' : 'unavailable',
      reservationsSource: reservationsResult.status === 'fulfilled' ? 'server' : 'unavailable',
      validationSource: validationResult.status === 'fulfilled' ? 'server' : 'unavailable',
      changesSource: changesResult.status === 'fulfilled' ? 'server_events' : 'local_events',
      historyComplete:
        changesResult.status === 'fulfilled' ? changesResult.value.history_complete : false,
      coverageReasons: reasons,
    });
  }

  private recapConfig() {
    const config = this.daemon.config.recap;
    if (!config.enabled || !config.endpoint || !config.model) return null;
    const parsed = RecapConfigSchema.safeParse({
      enabled: true,
      endpoint: config.endpoint,
      model: config.model,
      maxChars: config.maxChars,
      timeoutMs: config.timeoutMs,
      ...(config.token ? { token: config.token } : {}),
    });
    return parsed.success ? parsed.data : null;
  }
}
