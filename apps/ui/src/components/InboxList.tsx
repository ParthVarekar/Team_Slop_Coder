import { useStore } from '../store/useStore.js';
import type { Notification, NotificationState } from '../lib/types.js';
import {
  formatRelative,
  notificationKindColor,
  notificationKindLabel,
  shortId,
} from '../lib/format.js';
import { InboxIcon } from './icons.js';

const TABS: { state: NotificationState; label: string }[] = [
  { state: 'inbox', label: 'Inbox' },
  { state: 'saved', label: 'Saved' },
  { state: 'done', label: 'Done' },
];

function NotificationCard({ notification }: { notification: Notification }) {
  const selectedNotificationId = useStore((s) => s.selectedNotificationId);
  const selectNotification = useStore((s) => s.selectNotification);
  const active = selectedNotificationId === notification.id;
  const color = notificationKindColor(notification.kind);

  return (
    <li>
      <button
        type="button"
        onClick={() => selectNotification(active ? null : notification.id)}
        className={`flex w-full flex-col gap-1 border-b border-line-muted px-3 py-2.5 text-left transition-colors ${
          active ? 'bg-canvas-subtle' : 'hover:bg-canvas-subtle/60'
        }`}
      >
        <div className="flex items-center gap-2">
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide"
            style={{ color, backgroundColor: '#ffffff0d' }}
          >
            {notificationKindLabel(notification.kind)}
          </span>
          <span className="ml-auto shrink-0 font-mono text-[10px] text-fg-subtle">
            {shortId(notification.id)}
          </span>
        </div>
        <div className="truncate font-medium text-fg">{notification.title}</div>
        {notification.body && (
          <div className="truncate text-[11px] text-fg-muted">{notification.body}</div>
        )}
        <div className="flex items-center gap-2 text-[10px] text-fg-subtle">
          {notification.subject_type && (
            <span className="rounded bg-canvas-inset px-1.5 py-0.5 uppercase tracking-wide">
              {notification.subject_type}
            </span>
          )}
          <span className="ml-auto">{formatRelative(notification.created_at)}</span>
        </div>
      </button>
    </li>
  );
}

export function InboxList() {
  const notifications = useStore((s) => s.notifications);
  const inboxState = useStore((s) => s.inboxState);
  const setInboxState = useStore((s) => s.setInboxState);

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-line px-2 py-1.5">
        {TABS.map(({ state, label }) => (
          <button
            key={state}
            type="button"
            onClick={() => setInboxState(state)}
            aria-current={inboxState === state ? 'true' : undefined}
            className={`flex-1 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
              inboxState === state
                ? 'bg-canvas-subtle text-accent'
                : 'text-fg-subtle hover:bg-canvas-subtle/60 hover:text-fg'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {notifications.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <InboxIcon size={26} className="text-fg-subtle" />
            <div className="text-xs font-medium text-fg-muted">
              {inboxState === 'inbox' ? 'Inbox zero' : `No ${inboxState} cards`}
            </div>
            <p className="text-[11px] leading-relaxed text-fg-subtle">
              Approvals, questions, failures, conflicts and mentions addressed to you appear here.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col">
            {notifications.map((n) => (
              <NotificationCard key={n.id} notification={n} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
