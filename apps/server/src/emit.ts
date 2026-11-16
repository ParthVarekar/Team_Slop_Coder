import type { Client } from 'pg';
import { ulid, PROTOCOL_VERSION, type Actor, type Privacy } from '@weft/protocol';

export interface CoordinationEmit {
  projectId: string;
  deviceId: string;
  type: string;
  actor: Actor;
  payload: Record<string, unknown>;
  taskId?: string;
  repoId?: string;
  sessionId?: string;
  privacy?: Privacy;
}

export interface EmittedRef {
  event_id: string;
  global_seq: number;
}

/**
 * Append a server-originated coordination event inside the caller's transaction.
 * Reserves one per-project global_seq via an atomic project_stream_seq increment
 * (row lock = CAS), then writes both the partitioned events log and the
 * never-expiring coordination mirror. Because this runs on the same client as
 * the mutation that produced it, the snapshot change and its fan-out event commit
 * atomically — a daemon can never observe one without the other. The caller wakes
 * SSE subscribers (hub.notify) only after the transaction commits.
 */
export async function appendCoordinationEvent(
  client: Client,
  input: CoordinationEmit,
): Promise<EmittedRef> {
  const eventId = ulid();
  const now = new Date().toISOString();
  const privacy = input.privacy ?? 'metadata';

  const seq = await client.query(
    `INSERT INTO project_stream_seq (project_id, last_seq, min_seq)
     VALUES ($1, 1, 0)
     ON CONFLICT (project_id) DO UPDATE SET last_seq = project_stream_seq.last_seq + 1
     RETURNING last_seq`,
    [input.projectId],
  );
  const globalSeq = Number(seq.rows[0]?.last_seq);

  await client.query(
    `INSERT INTO events
       (event_id, v, device_id, project_id, repo_id, session_id, provider_session_id,
        task_id, seq, global_seq, ts, received_at, type, actor, payload, privacy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [
      eventId, PROTOCOL_VERSION, input.deviceId, input.projectId,
      input.repoId ?? null, input.sessionId ?? null, null,
      input.taskId ?? null, null, globalSeq, now, now,
      input.type, JSON.stringify(input.actor), JSON.stringify(input.payload), privacy,
    ],
  );

  await client.query(
    `INSERT INTO coordination_events
       (event_id, v, device_id, project_id, repo_id, session_id, task_id, seq,
        global_seq, ts, received_at, type, actor, payload, privacy)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (event_id) DO NOTHING`,
    [
      eventId, PROTOCOL_VERSION, input.deviceId, input.projectId,
      input.repoId ?? null, input.sessionId ?? null, input.taskId ?? null, null,
      globalSeq, now, now, input.type, JSON.stringify(input.actor), JSON.stringify(input.payload), privacy,
    ],
  );

  return { event_id: eventId, global_seq: globalSeq };
}