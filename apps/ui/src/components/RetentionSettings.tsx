import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api/client.js';
import { teamClient } from '../api/team.js';
import { useStore } from '../store/useStore.js';
import type { RetentionPreview, RetentionResult, RetentionStatus } from '../lib/types.js';

interface RetentionApi {
  retentionStatus(): Promise<RetentionStatus>;
  retentionPreview(cutoff: string, batchLimit: number): Promise<RetentionPreview>;
  retentionApply(preview: RetentionPreview, runId: string): Promise<RetentionResult>;
}

interface RetentionClient {
  status(): Promise<RetentionStatus>;
  preview(cutoff: string, batchLimit: number): Promise<RetentionPreview>;
  apply(preview: RetentionPreview, runId: string): Promise<RetentionResult>;
}

function retentionClient(client: RetentionApi): RetentionClient {
  return {
    status: () => client.retentionStatus(),
    preview: (cutoff, batchLimit) => client.retentionPreview(cutoff, batchLimit),
    apply: (preview, runId) => client.retentionApply(preview, runId),
  };
}

function bytes(value: number | null): string {
  if (value === null) return 'unavailable';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 / 1024).toFixed(1)} MiB`;
}
function defaultCutoff(status: RetentionStatus): string {
  return new Date(Date.now() - status.defaultTelemetryDays * 86_400_000).toISOString().slice(0, 16);
}
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function RetentionSection({
  title,
  subtitle,
  client,
}: {
  title: string;
  subtitle: string;
  client: RetentionClient | null;
}) {
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [cutoff, setCutoff] = useState('');
  const [batchLimit, setBatchLimit] = useState(1000);
  const [preview, setPreview] = useState<RetentionPreview | null>(null);
  const [result, setResult] = useState<RetentionResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    if (!client) return;
    setStatusError('');
    try {
      const next = await client.status();
      setStatus(next);
      setBatchLimit(next.batchLimit);
      setCutoff((current) => current || defaultCutoff(next));
    } catch (err) {
      setStatus(null);
      setStatusError(message(err));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const key = `${cutoff}:${batchLimit}`;
  const stale =
    preview !== null &&
    key !== `${new Date(preview.cutoff).toISOString().slice(0, 16)}:${preview.batchLimit}`;
  const runPreview = async () => {
    if (!client || !cutoff) return;
    setBusy(true);
    setError('');
    setResult(null);
    setConfirmed(false);
    setConfirmation('');
    try {
      // datetime-local is converted to an explicit UTC instant, never client event ts.
      const p = await client.preview(new Date(`${cutoff}:00.000Z`).toISOString(), batchLimit);
      setPreview(p);
    } catch (err) {
      setPreview(null);
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };
  const apply = async () => {
    if (!client || !preview || stale || !confirmed || confirmation !== 'DELETE') return;
    setBusy(true);
    setError('');
    try {
      const committed = await client.apply(preview, crypto.randomUUID());
      setResult(committed);
      setPreview(null);
      setConfirmed(false);
      setConfirmation('');
      await refresh();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-canvas p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          <p className="mt-1 text-[11px] leading-relaxed text-fg-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={!client || busy}
          className="shrink-0 rounded border border-line px-2 py-1 text-[11px] text-fg-muted hover:text-fg disabled:opacity-40"
        >
          Refresh
        </button>
      </div>

      {!client ? (
        <p className="text-xs text-fg-subtle">Connect a team server to manage team retention.</p>
      ) : statusError ? (
        <div
          role="alert"
          className="rounded border border-danger/40 bg-danger/5 p-3 text-xs text-danger"
        >
          Database status unavailable: {statusError}
        </div>
      ) : !status ? (
        <p className="text-xs text-fg-subtle">Reading database status…</p>
      ) : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-2 text-[11px] sm:grid-cols-3">
            <Metric label="Hot events (exact)" value={status.exactCounts.events.toLocaleString()} />
            <Metric
              label="Coordination (protected)"
              value={status.exactCounts.coordinationEvents.toLocaleString()}
            />
            <Metric
              label="Completed runs"
              value={status.exactCounts.completedRuns.toLocaleString()}
            />
            <Metric label="Replay receipts" value={status.exactCounts.receipts.toLocaleString()} />
            <Metric label="Summary ranges" value={status.exactCounts.ranges.toLocaleString()} />
            <Metric
              label="Tuple size (estimate)"
              value={bytes(status.byteMetrics.storedTupleEstimateBytes.value)}
            />
          </div>
          <div className="mb-3 rounded border border-line/70 p-3 text-[11px] leading-relaxed text-fg-muted">
            <div>
              Payload bytes:{' '}
              <strong className="text-fg">{bytes(status.byteMetrics.payloadBytes.value)}</strong> (
              {status.byteMetrics.payloadBytes.label})
            </div>
            <div>
              Allocated events relation:{' '}
              <strong className="text-fg">
                {bytes(status.byteMetrics.allocatedRelationBytes.value)}
              </strong>{' '}
              ({status.byteMetrics.allocatedRelationBytes.label}; not reclaimed space)
            </div>
            <div>
              Free pages: {status.byteMetrics.freePagesBytes.label}. No VACUUM, partition DROP, git
              GC, or pruning.
            </div>
            {status.partitions && (
              <div>
                Monthly partitions: {status.partitions.current}, {status.partitions.next};
                events_default retained. Automation is non-destructive.
              </div>
            )}
            {status.outbox && (
              <div>
                Pending outbox: {status.outbox.pending}; protected coordination:{' '}
                {status.outbox.coordinationPending}
                {status.outbox.backpressure
                  ? '; backpressure remains after allowlisted compaction'
                  : ''}
                .
              </div>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-[11px] text-fg-muted">
              Server received_at cutoff (UTC)
              <input
                type="datetime-local"
                value={cutoff}
                max="9999-12-31T23:59"
                disabled={busy}
                onChange={(e) => {
                  setCutoff(e.target.value);
                  setResult(null);
                }}
                className="mt-1 w-full rounded border border-line bg-canvas-subtle px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
              />
            </label>
            <label className="text-[11px] text-fg-muted">
              Batch limit (1–1000)
              <input
                type="number"
                min={1}
                max={1000}
                value={batchLimit}
                disabled={busy}
                onChange={(e) => {
                  setBatchLimit(Number(e.target.value));
                  setResult(null);
                }}
                className="mt-1 w-full rounded border border-line bg-canvas-subtle px-2 py-1.5 text-xs text-fg outline-none focus:border-accent"
              />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void runPreview()}
              disabled={
                busy ||
                !cutoff ||
                !Number.isInteger(batchLimit) ||
                batchLimit < 1 ||
                batchLimit > 1000
              }
              className="rounded border border-accent/50 px-3 py-1.5 text-xs text-fg hover:bg-accent/10 disabled:opacity-40"
            >
              {busy ? 'Working…' : 'Dry run (writes nothing)'}
            </button>
            <span className="text-[10px] text-fg-subtle">
              Team preview/apply requires project admin scope.
            </span>
          </div>

          {preview && (
            <div className="mt-4 rounded border border-line bg-canvas-subtle p-3 text-xs">
              <div className="font-semibold text-fg">Dry-run selection</div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-fg-muted sm:grid-cols-4">
                <Metric
                  label="Eligible (exact count)"
                  value={preview.eligibleRows.toLocaleString()}
                />
                <Metric
                  label="Selected (exact count)"
                  value={preview.selectedRows.toLocaleString()}
                />
                <Metric
                  label="Eligible payload (exact)"
                  value={bytes(preview.eligiblePayloadBytes)}
                />
                <Metric
                  label="Selected payload (exact)"
                  value={bytes(preview.selectedPayloadBytes)}
                />
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-fg-muted">
                {preview.rangeCount} exact {preview.sequenceKind} ranges and {preview.summaryCount}{' '}
                synthetic summary events will be written. Protected gaps remain:{' '}
                {preview.exclusions.protectedCoordination} coordination,{' '}
                {preview.exclusions.protectedReceipts} receipted,{' '}
                {preview.exclusions.protectedOrNonAllowlisted} other known non-allowlisted,{' '}
                {preview.exclusions.protectedUnknown} unknown, {preview.exclusions.tooNew} newer.
                Raw payloads will not be recoverable. Tuple/relation measurements are estimates or
                allocated size, not reclaimed bytes.
              </p>
              <div className="mt-2 font-mono text-[9px] text-fg-subtle">
                fingerprint {preview.fingerprint}
              </div>
              {stale && (
                <p role="alert" className="mt-2 text-attention">
                  Inputs changed. Dry run again; this preview is stale.
                </p>
              )}
              <div className="mt-3 rounded border border-danger/40 p-3">
                <div className="text-[11px] font-semibold text-danger">
                  Destructive confirmation
                </div>
                <label className="mt-2 flex items-center gap-2 text-[11px] text-fg-muted">
                  <input
                    type="checkbox"
                    checked={confirmed}
                    disabled={busy || stale || preview.selectedRows === 0}
                    onChange={(e) => setConfirmed(e.target.checked)}
                  />
                  I understand only the exact selected allowlisted telemetry is deleted.
                </label>
                <input
                  aria-label="Type DELETE to confirm"
                  placeholder="Type DELETE to confirm"
                  value={confirmation}
                  disabled={busy || stale || preview.selectedRows === 0}
                  onChange={(e) => setConfirmation(e.target.value)}
                  className="mt-2 w-full rounded border border-line bg-canvas px-2 py-1.5 text-xs text-fg"
                />
                <button
                  type="button"
                  onClick={() => void apply()}
                  disabled={
                    busy ||
                    stale ||
                    !confirmed ||
                    confirmation !== 'DELETE' ||
                    preview.selectedRows === 0
                  }
                  className="mt-2 rounded bg-danger px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
                >
                  {busy ? 'Applying…' : 'Apply compaction'}
                </button>
              </div>
            </div>
          )}

          {result && (
            <div
              role="status"
              className="mt-4 rounded border border-success/40 bg-success/5 p-3 text-xs text-success"
            >
              Committed {result.selectedRows} rows in {result.rangeCount} exact ranges (
              {result.selectedPayloadBytes} payload bytes). Run {result.runId}
              {result.idempotent ? ' was already committed (idempotent replay).' : '.'}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="mt-3 rounded border border-danger/40 p-3 text-xs text-danger"
            >
              {error}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line/60 p-2">
      <div className="text-[9px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="mt-1 font-mono text-xs text-fg">{value}</div>
    </div>
  );
}

export function RetentionSettings({ onDone }: { onDone: () => void }) {
  const connection = useStore((s) => s.connection);
  const mode = useStore((s) => s.mode);
  const localClient = useMemo(() => retentionClient(api), []);
  const team = useMemo(
    () => (connection ? retentionClient(teamClient(connection)) : null),
    [connection],
  );
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Retention and compaction"
    >
      <div className="max-h-[90vh] w-full max-w-4xl overflow-auto rounded-xl border border-line bg-canvas-subtle shadow-2xl">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-canvas-subtle px-5 py-4">
          <div>
            <h1 className="text-sm font-semibold text-fg">Retention and compaction</h1>
            <p className="mt-1 text-[11px] text-fg-muted">
              Manual, evidence-preserving telemetry retention. Destructive automation stays
              disabled.
            </p>
          </div>
          <button
            type="button"
            onClick={onDone}
            className="rounded border border-line px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
          >
            Done
          </button>
        </header>
        <div className="space-y-4 p-5">
          <RetentionSection
            title="Local database"
            subtitle="This machine's SQLite events, selected by rowid and server received_at. Pending-outbox rows are excluded."
            client={localClient}
          />
          <RetentionSection
            title={mode === 'team' ? 'Team server (connected)' : 'Team server'}
            subtitle="Central Postgres events, selected by per-project global_seq. Coordination remains durable and summaries are hot-only."
            client={team}
          />
        </div>
      </div>
    </div>
  );
}
