import { useState, type FormEvent } from 'react';
import { useStore } from '../store/useStore.js';
import { CloseIcon, SettingsIcon } from './icons.js';

const INPUT =
  'w-full rounded border border-line bg-canvas px-2 py-1.5 text-xs text-fg outline-none focus:border-accent';

export function ConnectionSettings({ onDone }: { onDone: () => void }) {
  const mode = useStore((s) => s.mode);
  const connection = useStore((s) => s.connection);
  const connectTeam = useStore((s) => s.connectTeam);
  const disconnectTeam = useStore((s) => s.disconnectTeam);
  const [serverUrl, setServerUrl] = useState(connection?.serverUrl ?? 'http://127.0.0.1:7420');
  const [projectId, setProjectId] = useState(connection?.projectId ?? '');
  const [token, setToken] = useState(connection?.token ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const next = {
      serverUrl: serverUrl.trim().replace(/\/+$/, ''),
      projectId: projectId.trim(),
      token: token.trim(),
    };
    if (!next.serverUrl || !next.projectId || !next.token) {
      setError('Server URL, project ID and API token are all required.');
      return;
    }
    setBusy(true);
    setError(null);
    await connectTeam(next);
    setBusy(false);
    if (useStore.getState().ready) onDone();
    else setError(useStore.getState().error ?? 'Connection failed.');
  };

  const disconnect = async () => {
    setBusy(true);
    await disconnectTeam();
    setBusy(false);
    onDone();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh] backdrop-blur-[2px]"
      onClick={onDone}
      role="presentation"
    >
      <div
        className="w-[min(460px,92vw)] overflow-hidden rounded-xl border border-line bg-canvas-subtle shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Team server connection"
      >
        <header className="flex items-center gap-2 border-b border-line px-4 py-3">
          <SettingsIcon size={15} className="text-fg-subtle" />
          <h2 className="text-xs font-semibold uppercase tracking-wide text-fg-muted">
            Team server connection
          </h2>
          <button
            type="button"
            aria-label="Close connection settings"
            onClick={onDone}
            className="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-subtle hover:bg-canvas-inset hover:text-fg"
          >
            <CloseIcon size={13} />
          </button>
        </header>

        <form onSubmit={submit} className="flex flex-col gap-3 p-4">
          {mode === 'team' && connection && (
            <div className="flex items-center gap-2 rounded-md border border-success/40 bg-success/10 px-3 py-2 text-[11px] text-fg">
              <span className="h-1.5 w-1.5 rounded-full bg-success" />
              <span className="truncate">
                Connected to <span className="font-mono">{connection.serverUrl}</span>
              </span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void disconnect()}
                className="ml-auto shrink-0 rounded border border-line px-2 py-0.5 text-[10px] text-fg-muted hover:border-danger hover:text-danger disabled:opacity-40"
              >
                Disconnect
              </button>
            </div>
          )}

          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Server URL</span>
            <input
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              placeholder="http://127.0.0.1:7420"
              className={`${INPUT} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">Project ID</span>
            <input
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="proj_…"
              className={`${INPUT} font-mono`}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-fg-subtle">API token</span>
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="weft_…"
              autoComplete="off"
              className={`${INPUT} font-mono`}
            />
          </label>
          <p className="text-[10px] leading-relaxed text-fg-subtle">
            Issue a project-scoped token with{' '}
            <code className="font-mono text-fg-muted">weft-server</code> admin access. The token is
            stored in this browser only and sent solely to the server above.
          </p>

          {error && (
            <div className="rounded border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] text-danger">
              {error}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onDone}
              className="rounded px-2.5 py-1 text-[11px] text-fg-muted hover:text-fg"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-accent-emphasis px-3 py-1 text-[11px] font-medium text-white hover:bg-accent disabled:opacity-40"
            >
              {busy ? 'Connecting…' : mode === 'team' ? 'Reconnect' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}