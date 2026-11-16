import { useState, type ReactNode } from 'react';
import { useStore } from '../store/useStore.js';
import {
  actorLabel,
  isSystemActor,
  nextStates,
  priorityColor,
  taskStateColor,
  type Notification,
  type NotificationState,
  type Task,
  type WeftEvent,
} from '../lib/types.js';
import {
  categoryColor,
  categoryLabel,
  categoryOf,
  formatClock,
  notificationKindColor,
  notificationKindLabel,
  shortId,
} from '../lib/format.js';
import { CloseIcon } from './icons.js';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</dt>
      <dd className="break-words text-[12px] text-fg">{children}</dd>
    </div>
  );
}

function IdLink({ id, onClick }: { id: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="font-mono text-[11px] text-accent hover:underline"
      title={id}
    >
      {shortId(id)}
    </button>
  );
}

function EventDetail({ event }: { event: WeftEvent }) {
  const setFilter = useStore((s) => s.setFilter);
  const selectSession = useStore((s) => s.selectSession);
  const selectTask = useStore((s) => s.selectTask);
  const category = categoryOf(event.type);
  const color = categoryColor(category);

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <span
          className="mb-2 inline-block rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          style={{ color, backgroundColor: '#ffffff0d' }}
        >
          {categoryLabel(category)}
        </span>
        <div className="break-words font-mono text-[13px] font-semibold text-fg">{event.type}</div>
        <div className="mt-1 font-mono text-[11px] text-fg-subtle">
          {new Date(event.ts).toLocaleString()} · {formatClock(event.ts)}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Field label="Actor">
          {actorLabel(event.actor)}
          {!isSystemActor(event.actor) && event.actor.agent?.model && (
            <span className="block text-[11px] text-fg-muted">{event.actor.agent.model}</span>
          )}
        </Field>
        <Field label="Privacy">
          <span className="rounded bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase">
            {event.privacy}
          </span>
        </Field>
        <Field label="Event ID">
          <span className="font-mono text-[11px] text-fg-muted" title={event.event_id}>
            {shortId(event.event_id)}
          </span>
        </Field>
        <Field label="Sequence">{event.seq ?? '—'}</Field>
        {event.session_id && (
          <Field label="Session">
            <IdLink id={event.session_id} onClick={() => selectSession(event.session_id!)} />
          </Field>
        )}
        {event.repo_id && (
          <Field label="Repo">
            <IdLink id={event.repo_id} onClick={() => setFilter({ repo: event.repo_id! })} />
          </Field>
        )}
        {event.task_id && (
          <Field label="Task">
            <IdLink id={event.task_id} onClick={() => selectTask(event.task_id!)} />
          </Field>
        )}
        {event.rowid !== undefined && <Field label="Row ID">{event.rowid}</Field>}
      </dl>

      <div>
        <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">Payload</div>
        <pre className="max-h-[40vh] overflow-auto rounded-md border border-line bg-canvas-inset p-3 font-mono text-[11px] leading-relaxed text-fg-muted">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      </div>
    </div>
  );
}

function TaskDetail({ task }: { task: Task }) {
  const transitionTask = useStore((s) => s.transitionTask);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const transitions = nextStates(task.state);

  const move = async (to: string) => {
    setBusy(true);
    setError(null);
    try {
      await transitionTask(task.task_id, task.version, to);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <span className="font-mono text-[11px] text-fg-subtle">
            {task.number !== null ? `#${task.number}` : shortId(task.task_id)}
          </span>
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium"
            style={{ color: priorityColor(task.priority), backgroundColor: '#ffffff0d' }}
          >
            {task.priority}
          </span>
        </div>
        <h3 className="text-[14px] font-semibold leading-snug text-fg">{task.title}</h3>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Field label="State">
          <span
            className="rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide"
            style={{ color: taskStateColor(task.state), backgroundColor: '#ffffff0d' }}
          >
            {task.state.replace('_', ' ')}
          </span>
        </Field>
        <Field label="Version">{task.version}</Field>
        {task.branch && (
          <Field label="Branch">
            <span className="font-mono text-[11px]">{task.branch}</span>
          </Field>
        )}
        {task.updated_at && <Field label="Updated">{formatClock(task.updated_at)}</Field>}
      </dl>

      {task.description && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">Description</div>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">
            {task.description}
          </p>
        </div>
      )}

      {transitions.length > 0 && (
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">
            Transition to
          </div>
          <div className="flex flex-wrap gap-1.5">
            {transitions.map((to) => (
              <button
                key={to}
                type="button"
                disabled={busy}
                onClick={() => void move(to)}
                className="rounded-md border border-line bg-canvas-subtle px-2.5 py-1 text-[11px] text-fg hover:border-accent hover:text-accent disabled:opacity-40"
              >
                {to.replace('_', ' ')}
              </button>
            ))}
          </div>
          {error && <div className="mt-2 text-[11px] text-danger">{error}</div>}
        </div>
      )}
    </div>
  );
}

function SessionDetail() {
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const sessions = useStore((s) => s.sessions);
  const directory = useStore((s) => s.directory);
  const session = sessions.find((s) => s.session_id === selectedSessionId);
  if (!session) return null;
  const developerName = session.developer_id
    ? directory.find((d) => d.userId === session.developer_id)?.displayName
    : undefined;

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <div className="text-[10px] uppercase tracking-wide text-fg-subtle">Session</div>
        <h3 className="text-[14px] font-semibold text-fg">{session.provider_id ?? 'agent'}</h3>
        <div className="mt-0.5 font-mono text-[11px] text-fg-subtle" title={session.session_id}>
          {shortId(session.session_id)}
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3">
        <Field label="Status">
          <span className="rounded bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase">
            {session.status}
          </span>
        </Field>
        <Field label="Fidelity">{session.fidelity}</Field>
        {session.model && <Field label="Model">{session.model}</Field>}
        {session.developer_id && (
          <Field label="Developer">{developerName ?? shortId(session.developer_id)}</Field>
        )}
        <Field label="Started">{formatClock(session.started_at)}</Field>
        {session.ended_at && <Field label="Ended">{formatClock(session.ended_at)}</Field>}
      </dl>
      {session.prompt_summary && (
        <Field label="Prompt summary">
          <span className="text-fg-muted">{session.prompt_summary}</span>
        </Field>
      )}
      {session.cwd && (
        <Field label="Working directory">
          <span className="break-all font-mono text-[11px] text-fg-muted">{session.cwd}</span>
        </Field>
      )}
      <Field label="Provider session">
        <span className="break-all font-mono text-[11px] text-fg-muted">
          {session.provider_session_id}
        </span>
      </Field>
    </div>
  );
}

const TRIAGE_LABEL: Record<NotificationState, string> = {
  inbox: 'Move to inbox',
  saved: 'Save for later',
  done: 'Mark done',
};
const TRIAGE_ORDER: NotificationState[] = ['inbox', 'saved', 'done'];

function NotificationDetail({ notification }: { notification: Notification }) {
  const triageNotification = useStore((s) => s.triageNotification);
  const selectTask = useStore((s) => s.selectTask);
  const selectSession = useStore((s) => s.selectSession);
  const setFilter = useStore((s) => s.setFilter);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const color = notificationKindColor(notification.kind);

  const triage = async (state: NotificationState) => {
    setBusy(true);
    setError(null);
    try {
      await triageNotification(notification.id, state);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const subject = notification.subject_id;
  const openSubject = () => {
    if (!subject) return;
    if (notification.subject_type === 'task') selectTask(subject);
    else if (notification.subject_type === 'session') selectSession(subject);
    else if (notification.subject_type === 'repo') setFilter({ repo: subject });
  };

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <span
          className="mb-2 inline-block rounded px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide"
          style={{ color, backgroundColor: '#ffffff0d' }}
        >
          {notificationKindLabel(notification.kind)}
        </span>
        <h3 className="text-[14px] font-semibold leading-snug text-fg">{notification.title}</h3>
        <div className="mt-1 font-mono text-[11px] text-fg-subtle">
          {new Date(notification.created_at).toLocaleString()} · {formatClock(notification.created_at)}
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <Field label="State">
          <span className="rounded bg-canvas-inset px-1.5 py-0.5 text-[10px] uppercase tracking-wide">
            {notification.state}
          </span>
        </Field>
        <Field label="Notification ID">
          <span className="font-mono text-[11px] text-fg-muted" title={notification.id}>
            {shortId(notification.id)}
          </span>
        </Field>
        {notification.subject_type && subject && (
          <Field label={notification.subject_type}>
            <IdLink id={subject} onClick={openSubject} />
          </Field>
        )}
      </dl>

      {notification.body && (
        <div>
          <div className="mb-1 text-[10px] uppercase tracking-wide text-fg-subtle">Detail</div>
          <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-fg-muted">
            {notification.body}
          </p>
        </div>
      )}

      <div>
        <div className="mb-1.5 text-[10px] uppercase tracking-wide text-fg-subtle">Triage</div>
        <div className="flex flex-wrap gap-1.5">
          {TRIAGE_ORDER.filter((s) => s !== notification.state).map((state) => (
            <button
              key={state}
              type="button"
              disabled={busy}
              onClick={() => void triage(state)}
              className="rounded-md border border-line bg-canvas-subtle px-2.5 py-1 text-[11px] text-fg hover:border-accent hover:text-accent disabled:opacity-40"
            >
              {TRIAGE_LABEL[state]}
            </button>
          ))}
        </div>
        {error && <div className="mt-2 text-[11px] text-danger">{error}</div>}
      </div>
    </div>
  );
}

export function Inspector() {
  const events = useStore((s) => s.events);
  const selectedEventId = useStore((s) => s.selectedEventId);
  const selectedTaskId = useStore((s) => s.selectedTaskId);
  const selectedSessionId = useStore((s) => s.selectedSessionId);
  const selectedNotificationId = useStore((s) => s.selectedNotificationId);
  const tasks = useStore((s) => s.tasks);
  const notifications = useStore((s) => s.notifications);
  const selectEvent = useStore((s) => s.selectEvent);
  const selectTask = useStore((s) => s.selectTask);
  const selectSession = useStore((s) => s.selectSession);
  const selectNotification = useStore((s) => s.selectNotification);

  const event = selectedEventId ? events.find((e) => e.event_id === selectedEventId) : undefined;
  const task = selectedTaskId ? tasks.find((t) => t.task_id === selectedTaskId) : undefined;
  const notification = selectedNotificationId
    ? notifications.find((n) => n.id === selectedNotificationId)
    : undefined;

  const close = () => {
    selectEvent(null);
    selectTask(null);
    selectSession(null);
    selectNotification(null);
  };

  const title = event
    ? 'Event'
    : task
      ? 'Task'
      : notification
        ? 'Notification'
        : selectedSessionId
          ? 'Session'
          : 'Inspector';
  const hasSelection = Boolean(event || task || notification || selectedSessionId);

  return (
    <aside className="flex w-[340px] shrink-0 flex-col border-l border-line bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-line px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">{title}</h2>
        {hasSelection && (
          <button
            type="button"
            aria-label="Close inspector"
            onClick={close}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-canvas-subtle hover:text-fg"
          >
            <CloseIcon size={13} />
          </button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {event ? (
          <EventDetail event={event} />
        ) : task ? (
          <TaskDetail task={task} />
        ) : notification ? (
          <NotificationDetail notification={notification} />
        ) : selectedSessionId ? (
          <SessionDetail />
        ) : (
          <div className="flex h-full items-center justify-center px-6 text-center text-[11px] leading-relaxed text-fg-subtle">
            Select an event, task, session or notification to inspect its details.
          </div>
        )}
      </div>
    </aside>
  );
}