import {
  ulid,
  PROTOCOL_VERSION,
  type Actor,
  type EventEnvelope,
  type Privacy,
} from '@weft/protocol';

/** Machine/project context every locally-originated event is stamped with. */
export interface EventSource {
  deviceId: string;
  projectId: string;
  repoId?: string;
}

export interface EventDraft {
  type: string;
  actor: Actor;
  payload: Record<string, unknown>;
  privacy?: Privacy;
  sessionId?: string;
  providerSessionId?: string;
  taskId?: string;
  repoId?: string;
  seq?: number;
  ts?: string;
}

/** Build a valid protocol-v1 envelope; the pipeline re-validates on enqueue. */
export function draftEvent(source: EventSource, draft: EventDraft): EventEnvelope {
  const repoId = draft.repoId ?? source.repoId;
  return {
    v: PROTOCOL_VERSION,
    event_id: ulid(),
    device_id: source.deviceId,
    project_id: source.projectId,
    ...(repoId ? { repo_id: repoId } : {}),
    ...(draft.sessionId ? { session_id: draft.sessionId } : {}),
    ...(draft.providerSessionId ? { provider_session_id: draft.providerSessionId } : {}),
    ...(draft.taskId ? { task_id: draft.taskId } : {}),
    ...(draft.seq !== undefined ? { seq: draft.seq } : {}),
    ts: draft.ts ?? new Date().toISOString(),
    type: draft.type,
    actor: draft.actor,
    privacy: draft.privacy ?? 'metadata',
    payload: draft.payload,
  };
}
