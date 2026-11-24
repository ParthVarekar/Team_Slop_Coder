import { lazy, Suspense, useEffect } from 'react';
import { useStore } from './store/useStore.js';
import { ScopeRail } from './components/ScopeRail.js';
import { ListPane } from './components/ListPane.js';
import { StreamWorkspace } from './components/StreamWorkspace.js';
import { Inspector } from './components/Inspector.js';

const CommandPalette = lazy(() =>
  import('./components/CommandPalette.js').then((m) => ({ default: m.CommandPalette })),
);
const ConnectionSettings = lazy(() =>
  import('./components/ConnectionSettings.js').then((m) => ({ default: m.ConnectionSettings })),
);
const RetentionSettings = lazy(() =>
  import('./components/RetentionSettings.js').then((m) => ({ default: m.RetentionSettings })),
);

export function App() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const error = useStore((s) => s.error);
  const mode = useStore((s) => s.mode);
  const connectLocal = useStore((s) => s.connectLocal);
  const paletteOpen = useStore((s) => s.paletteOpen);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const retentionOpen = useStore((s) => s.retentionOpen);
  const setRetentionOpen = useStore((s) => s.setRetentionOpen);

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen(!useStore.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setPaletteOpen]);

  const team = mode === 'team';

  return (
    <>
      {settingsOpen && (
        <Suspense fallback={null}>
          <ConnectionSettings onDone={() => setSettingsOpen(false)} />
        </Suspense>
      )}

      {retentionOpen && (
        <Suspense fallback={null}>
          <RetentionSettings onDone={() => setRetentionOpen(false)} />
        </Suspense>
      )}

      {!ready ? (
        <div className="flex h-full items-center justify-center bg-canvas">
          {error ? (
            <div className="max-w-md rounded-lg border border-danger/40 bg-canvas-subtle p-6 text-center">
              <div className="mb-2 text-sm font-semibold text-danger">
                {team ? 'Team server unreachable' : 'Daemon unreachable'}
              </div>
              <p className="mb-4 text-fg-muted">{error}</p>
              {team ? (
                <p className="mb-4 text-xs text-fg-subtle">
                  Check the server URL, project ID and API token, or switch to the local daemon.
                </p>
              ) : (
                <p className="mb-4 text-xs text-fg-subtle">
                  Start the local daemon (<code className="font-mono text-fg">weft daemon</code>)
                  and reload. The UI connects to{' '}
                  <code className="font-mono text-fg">127.0.0.1:7421</code>.
                </p>
              )}
              <div className="flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="rounded-md border border-line bg-canvas px-3 py-1.5 text-fg hover:border-accent"
                >
                  Connection settings
                </button>
                {team ? (
                  <button
                    type="button"
                    onClick={() => void connectLocal()}
                    className="rounded-md border border-line bg-canvas px-3 py-1.5 text-fg hover:border-accent"
                  >
                    Use local mode
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-md border border-line bg-canvas px-3 py-1.5 text-fg hover:border-accent"
                  >
                    Retry
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-3 text-fg-muted">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
              {team ? 'Connecting to team server…' : 'Connecting to local daemon…'}
            </div>
          )}
        </div>
      ) : (
        <div className="flex h-full overflow-hidden bg-canvas text-fg">
          <ScopeRail />
          <ListPane />
          <StreamWorkspace />
          <Inspector />
          {paletteOpen && (
            <Suspense fallback={null}>
              <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
            </Suspense>
          )}
        </div>
      )}
    </>
  );
}
