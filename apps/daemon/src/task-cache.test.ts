import { describe, expect, it, vi } from 'vitest';
import {
  ulid,
  makeId,
  PROTOCOL_VERSION,
  type StoredEvent,
  type TaskSnapshot,
} from '@weft/protocol';
import { TaskCache } from './task-cache.js';

const PROJECT = makeId('project');
const DEVICE = makeId('device');
const TASK = makeId('task');

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    id: TASK,
    project_id: PROJECT,
    repo_id: null,
    number: 1,
    title: 'Original',
    description: null,
    acceptance_criteria: [],
    validation_requirements: {},
    priority: 'P2',
    state: 'backlog',
    expected_modules: [],
    expected_files: [],
    branch: null,
    workspace_id: null,
    version: 0,
    created_by: null,
    parent_task_id: null,
    edit_conflict: null,
    ...overrides,
  };
}

function ev(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
  taskId = TASK,
): StoredEvent {
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: DEVICE,
    project_id: PROJECT,
    task_id: taskId,
    ts: new Date().toISOString(),
    type,
    actor: { user_id: 'user_test', agent: null },
    privacy: 'metadata',
    payload,
    global_seq: seq,
    received_at: new Date().toISOString(),
  };
}

describe('daemon task cache', () => {
  it('folds task.created into a snapshot', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot() }));
    expect(cache.getTask(TASK)?.title).toBe('Original');
    expect(cache.getCursor()).toBe(1);
  });

  it('folds updates, state changes, claims and releases', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot() }));
    cache.applyEvent(
      ev(2, 'task.updated', { version: 1, values: { title: 'Renamed' }, edit_conflict: null }),
    );
    cache.applyEvent(ev(3, 'task.state_changed', { from: 'backlog', to: 'ready', version: 2 }));
    cache.applyEvent(
      ev(4, 'task.claimed', {
        version: 3,
        claimant: { user_id: 'u', agent: null },
        device_id: DEVICE,
      }),
    );
    expect(cache.getTask(TASK)?.state).toBe('claimed');
    expect(cache.getTask(TASK)?.title).toBe('Renamed');
    cache.applyEvent(ev(5, 'task.released', { version: 4, to: 'ready' }));
    expect(cache.getTask(TASK)?.state).toBe('ready');
    expect(cache.getTask(TASK)?.version).toBe(4);
  });

  it('preserves edit_conflict from the fold', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot() }));
    const conflict = {
      title: { current: 'A', incoming: 'B', base_version: 0, detected_at_version: 1 },
    };
    cache.applyEvent(ev(2, 'task.updated', { version: 1, values: {}, edit_conflict: conflict }));
    expect(cache.getTask(TASK)?.edit_conflict).toEqual(conflict);
  });

  it('records claim rejections and fires the quarantine hook', () => {
    const onClaimRejected = vi.fn();
    const cache = new TaskCache({ onClaimRejected });
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot({ state: 'ready' }) }));
    cache.applyEvent(
      ev(2, 'task.claim_rejected', {
        version: 1,
        winner_claimant: { user_id: 'winner', agent: null },
        reason: 'task is claimed, not ready',
        claimant: { user_id: 'loser', agent: null },
        device_id: DEVICE,
        provisional: true,
      }),
    );
    const rejection = cache.getClaimRejection(TASK);
    expect(rejection?.provisional).toBe(true);
    expect(rejection?.winner_claimant).toMatchObject({ user_id: 'winner' });
    expect(onClaimRejected).toHaveBeenCalledOnce();
    // Rejection does not mutate the task snapshot.
    expect(cache.getTask(TASK)?.state).toBe('ready');
    cache.clearClaimRejection(TASK);
    expect(cache.getClaimRejection(TASK)).toBeUndefined();
  });

  it('ignores replayed events at or below the cursor', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot() }));
    cache.applyEvent(
      ev(2, 'task.updated', { version: 1, values: { title: 'Second' }, edit_conflict: null }),
    );
    cache.applyEvent(
      ev(2, 'task.updated', { version: 1, values: { title: 'Replay' }, edit_conflict: null }),
    );
    cache.applyEvent(
      ev(1, 'task.updated', { version: 1, values: { title: 'Old' }, edit_conflict: null }),
    );
    expect(cache.getTask(TASK)?.title).toBe('Second');
    expect(cache.getCursor()).toBe(2);
  });

  it('advances the cursor on non-task events without creating tasks', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'reservation.acquired', { path_glob: 'src/**', mode: 'soft' }));
    expect(cache.getCursor()).toBe(1);
    expect(cache.listTasks()).toHaveLength(0);
  });

  it('clear() resets the projection for a forced resync', () => {
    const cache = new TaskCache();
    cache.applyEvent(ev(1, 'task.created', { version: 0, snapshot: snapshot() }));
    cache.applyEvent(
      ev(2, 'task.claim_rejected', { version: 1, provisional: true, device_id: DEVICE }),
    );
    cache.clear();
    expect(cache.getCursor()).toBe(0);
    expect(cache.listTasks()).toHaveLength(0);
    expect(cache.snapshot().claimRejections).toHaveLength(0);
  });

  it('marks stale and exposes it in the snapshot', () => {
    const cache = new TaskCache();
    expect(cache.isStale()).toBe(true);
    cache.setStale(false);
    expect(cache.snapshot().stale).toBe(false);
  });
});
