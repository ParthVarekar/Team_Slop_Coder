import { categoryOf } from './format.js';
import { isSystemActor, str, type Session, type WeftEvent } from './types.js';

/**
 * Derive cross-developer sessions from the shared team stream. The server has no
 * session projection, so the UI folds session.started/status/ended events (in
 * global_seq order) into live session rows, attributing each to its developer
 * via the event actor. Pure and order-stable: identical input yields identical
 * rows. A status/ended event whose started event was evicted is ignored.
 */
export function deriveSessions(events: WeftEvent[]): Session[] {
  const bySession = new Map<string, Session>();
  for (const e of events) {
    if (!e.session_id || categoryOf(e.type) !== 'session') continue;
    const actor = e.actor;
    const agent = isSystemActor(actor) ? null : actor.agent;
    const developerId = isSystemActor(actor) ? null : actor.user_id;

    if (e.type === 'session.started') {
      const p = e.payload;
      bySession.set(e.session_id, {
        session_id: e.session_id,
        device_id: e.device_id,
        provider_id: agent?.provider ?? str(p, 'provider_id') ?? null,
        provider_session_id: e.provider_session_id ?? str(p, 'provider_session_id') ?? e.session_id,
        task_id: e.task_id ?? null,
        developer_id: developerId,
        cwd: str(p, 'cwd') ?? null,
        status: 'running',
        started_at: e.ts,
        ended_at: null,
        model: str(p, 'model') ?? agent?.model ?? null,
        prompt_summary: str(p, 'prompt_summary') ?? null,
        fidelity: str(p, 'fidelity') ?? 'high',
      });
      continue;
    }

    const session = bySession.get(e.session_id);
    if (!session) continue;
    if (e.type === 'session.status') {
      session.status = str(e.payload, 'status') ?? session.status;
    } else if (e.type === 'session.ended') {
      session.status = 'ended';
      session.ended_at = e.ts;
    }
  }
  return [...bySession.values()].sort((a, b) => b.started_at.localeCompare(a.started_at));
}

/** "Claude Code for Priya" when the directory resolves the developer, else provider. */
export function sessionDeveloperLabel(
  session: Session,
  directory: { userId: string; displayName: string }[],
): string {
  const provider = session.provider_id ?? 'agent';
  const name = session.developer_id
    ? directory.find((d) => d.userId === session.developer_id)?.displayName
    : undefined;
  return name ? `${provider} for ${name}` : provider;
}
