# Weft — Performance Engineering Plan

**Date:** 2026-11-07 · Principle: performance is measured, never assumed. Targets below are grounded in documented figures ([01](01-research-report.md) §3–5) with explicit headroom; every target has a benchmark that runs in CI and fails on regression.

## 1. Scale model (what we actually engineer for)

| Dimension | Design point | Burst ceiling |
|---|---|---|
| Developers per team | 5–20 | 50 |
| Concurrent agent sessions | 20–40 | 100 |
| Event rate | ~10/s sustained | 500/s burst (<1MB/s) |
| Repo size | 10k–100k files | 400k files (Chromium-class) |
| Diff size per task | ≤2k lines | 50k lines |
| Event history | 90 days hot | 1 year (partitioned) |

Documented headroom: Fastify ~89.7K req/s (official illustrative); SQLite batched WAL inserts far exceed 500/s; ort merge P50 7.74ms (GitHub); ast-grep-class parsing 43ms/75k LOC; git status with fsmonitor ~0.8s on 393k files. **The bottleneck is never raw throughput — it's avoiding redundant work (re-indexing, re-rendering, re-sending) and keeping tail latency low.**

## 2. Performance targets (SLOs)

### Daemon
| Metric | Target | Measurement |
|---|---|---|
| Hook handling latency (telemetry, receipt → queued) | p50 ≤ 5ms, p99 ≤ 25ms | Load harness, 500/s burst |
| Enforcement hook (PreToolUse, sync reservation check) | p99 ≤ 50ms local; hard fails closed / soft fails open on stale copy | Reservation contention sim |
| Resolver process (TS Compiler API) RSS | ≤ 1GB @10k files; idle-evicted after 10 min | M3 exit benchmark, 10k/100k fixtures |
| Event ingest throughput | ≥ 5,000 events/s sustained | Synthetic adapter flood |
| Event → local UI | p95 ≤ 100ms | End-to-end timestamp trace |
| Idle CPU / RSS | < 1% / < 150MB | 10-min idle soak, watchers armed |
| Active CPU / RSS (40 sessions) | < 15% / < 300MB | Load sim §4 |
| Cold startup → ready | ≤ 2s | Time-to-hook-listener + DB open |
| Incremental symbol update | ≤ 50ms/file p95 (≤2k-line file) | Parse+extract+store benchmark |
| Full index, 10k TS files | ≤ 60s one-time; ≤ 5s warm restart | Fixture repo |
| git status reconciliation (100k files) | ≤ 1s with fsmonitor (git ≥2.55 Linux / ≥2.36 Win / ≥2.37 macOS); ≤ 5s fallback without — runtime capability detection | Fixture monorepo |
| merge-tree gate (PR-sized, ≤2k lines) | p95 ≤ 500ms | Fixture branch pairs |
| Validation scheduling overhead (excluding check runtime) | ≤ 200ms | Worktree reuse + spawn timing |
| Outbox drain after reconnect (10k events) | ≤ 10s | Kill-network sim |
| Memory growth over 24h soak | ≤ 5% (no unbounded retention) | Heap snapshots hourly |

### Server
| Metric | Target |
|---|---|
| Ingest batch ack (500 events) | p95 ≤ 50ms (LAN, Postgres local) |
| Event → team UI (LAN) | p95 ≤ 250ms end-to-end |
| SSE fan-out | 100 concurrent listeners, ≤ 1% CPU at 500 events/s |
| Stream catch-up query (10k events) | ≤ 100ms |
| Task claim CAS | p95 ≤ 20ms |
| Coordination propagation (server→daemon SSE) | ≤ 1s p95 (reservation acquire → enforcement copy fresh) |
| Conflict aggregation (40 active tasks) | ≤ 2s full sweep; incremental ≤ 100ms |
| Idle RSS | < 300MB |

### Frontend
| Metric | Target |
|---|---|
| Initial JS (gzip) | ≤ 300KB; CI bundle budget |
| Cold load → interactive (LAN) | ≤ 1.5s |
| Stream scroll, 10k rows | 60fps (≤16.7ms frames), zero layout shift on prepend |
| INP under 500 events/s | ≤ 200ms |
| One event delta → re-render scope | exactly affected row(s); asserted in tests |
| Diff expand (2k lines) | ≤ 100ms to first paint; word-level lazy |
| Palette open → results | ≤ 50ms (local store) |

## 3. Benchmarking and profiling methodology

- **Harness in-repo from M0** (`bench/`): synthetic adapters emitting protocol-v1 events at controlled rates; fixture repos (small 1k / medium 10k / monorepo 100k+ files, generated deterministically); fixture branch pairs (clean merge, textual conflict, same-symbol overlap, signature change).
- **Microbenchmarks**: hook path, redaction, batch insert, symbol extract, merge-tree gate, overlap sweep. Run per-PR on representative hardware; results stored as JSON artifacts; CI fails on >10% regression vs rolling baseline.
- **End-to-end traces**: event_id timestamps at adapter→queue→SQLite→shipper→server→SSE→UI render; p50/p95/p99 reported per hop.
- **Load simulations** (§4) run nightly; **soak tests** (24h) weekly for memory/FD leaks.
- **Profiling**: Node `--cpu-prof`/heap snapshots on budget violation; Chrome Performance panel for UI (long tasks, render counts via React Profiler); `perf`/ETW for git child-process cost. flamegraphs attached to benchmark artifacts.
- **UI render-count assertions**: component tests assert a single event delta re-renders only its row (Linear "one delta = one cell" invariant).
- **Real-world validation**: dogfood on this repo's own development from M1; every milestone exits with a benchmark report, not a claim.

## 4. Load simulation scenarios

| Scenario | Shape | Pass criteria |
|---|---|---|
| Burst ingest | 500 events/s × 60s, 40 sessions | No hook blocking; no loss; p99 hook ≤25ms |
| Steady team | 20 devs, 40 sessions, 10 events/s, 8h | RSS/CPU within budget; zero leaks |
| Monorepo | 400k files, fsmonitor on; watcher overflow injected | status ≤1s; correct rescan after ERROR_NOTIFY_ENUM_DIR |
| Conflict storm | 40 tasks, 20% file overlap, signature changes | Incremental sweep ≤100ms; no duplicate conflict cards |
| Disconnect/reconnect | Kill network 10 min mid-burst, restore | Outbox drains ≤10s; zero loss/dup (dedup verified) |
| Crash recovery | SIGKILL daemon mid-transaction; agent mid-edit | Atomic batches; auto-WIP intact; stale locks recovered |
| UI flood | 500 events/s rendered, user scrolling | 60fps; pause-on-scroll holds; INP ≤200ms |
| Large diff | 50k-line diff expand | Line-only mode; ≤100ms first paint; no jank |
| Server fan-out | 100 SSE clients, 500 events/s | ≤1% CPU; all clients converge (seq-verified) |
| Queue executor failover | Kill executor mid-advance; lease expires | Successor re-reads origin; CAS push never overwrites; no double-merge |
| Stale enforcement copy | Sever server→daemon SSE during active hard reservation | Hard edits fail closed within grace; soft fail open; recovery on reconnect |

## 5. Optimization rules (enforced in review)

1. No full re-index on change — git-diff-driven invalidation only.
2. No full-state network transfers — deltas + cursors; batch ≤50–100ms flush.
3. No polling where push exists (hooks/SSE/NOTIFY); polling intervals documented where unavoidable (git status reconciliation ≤2s debounce).
4. No LLM calls in hot paths; deterministic summaries.
5. No unbounded caches/queues — every buffer has a cap and a compaction policy.
6. No N+1 queries; keyset pagination everywhere; JSONB payloads capped.
7. No main-thread heavy work in UI — diff parse/highlight lazy + chunked; virtualization mandatory >200 rows.
8. Every optimization lands with a before/after benchmark artifact.

## 6. Budgets per subsystem (idle/active)

| Subsystem | Idle CPU | Active CPU | RSS cap |
|---|---|---|---|
| Hook receiver + redaction | ~0% | ≤5% | 30MB |
| Watcher + git reconciliation | <0.5% | ≤3% | 40MB |
| Indexer | 0% (event-driven) | ≤5% | 80MB |
| Validator supervisor | 0% | ≤2% (checks are child processes) | 20MB |
| Shipper + SSE | ~0% | ≤2% | 30MB |
| **Daemon total** | **<1%** | **≤15%** | **<300MB** |

Child check processes are bounded by semaphore (≈cores−1) and timeouts; their cost is the project's own test suite, not platform overhead — measured and reported separately as "validation execution time".