# Weft — Technology Decision Report

**Date:** 2026-11-07 · Every selection answers: *is this the most efficient, reliable, sound way?* Evidence links in [01-research-report.md](01-research-report.md). Vendor/disputed numbers are labeled.

## 1. Decision summary

| Layer | Selection | Runner-up (rejected) | Decisive reason |
|---|---|---|---|
| Language/runtime | TypeScript, Node LTS (26; 24 supported) | Go; Rust; Bun | One language for daemon+server+UI; best ecosystem for tree-sitter/child-process/fs-watch; velocity |
| HTTP framework | Fastify | Hono; Express | Plugin ecosystem (SSE/auth/validation), ~89.7K req/s official illustrative benchmark |
| Local store | SQLite WAL + better-sqlite3 | node:sqlite (RC); DuckDB | Synchronous batched txns; proven; `node:sqlite` still stability 1.2 |
| Central store | Postgres 16+ | SQLite-on-server; MySQL | Partitioning, NOTIFY wake-up, concurrent writers, RBAC-friendly |
| Event bus | In-process + DB outbox | Kafka/Redis/NATS | <1MB/s ingest; brokers = extra daemon + failure mode for zero benefit |
| Real-time | SSE + POST RPC | WebSocket; WebTransport | Last-Event-ID resume = SQL cursor; HTTP/2; no custom resume protocol |
| Agent telemetry | Native hooks (Claude-shaped) + OpenCode SSE | Log tailing; PTY scraping | Push, structured, full-fidelity; tailing is fallback only |
| Agent coordination | MCP server + PreToolUse hard locks | A2A; custom API | Universal MCP client support; proven agent-coord pattern; A2A = federation, not needed |
| Git access | git CLI plumbing (execFile) | nodegit; isomorphic-git; libgit2; gitoxide | Only option with merge-tree/rerere/worktree parity; nodegit abandoned |
| Conflict gate | `git merge-tree --write-tree` (ort) | Working-tree trial merges | In-core, no checkout; GitHub P50 7.74ms |
| Symbol parsing | tree-sitter (native bindings) + ast-grep | LSP-everything; SCIP-everything; Babel/recast | 43ms/75k LOC class; incremental invalidation via git diff; LSP reserved for reference resolution |
| TS references | TypeScript Compiler API (one program/repo) | tsserver per worktree; SCIP batch | Precise, in-process; scip-typescript throughput (1–5k LOC/s) is typechecker-bound anyway |
| Module graph | dependency-cruiser | madge; Nx required | Rules+graph, MIT, uses installed TS |
| Test selection | Jest --findRelatedTests / project-configured affected | Bazel rdeps; testmon everywhere | Zero adoption cost; full-suite safety net retained |
| Contract gates | oasdiff / buf / squawk / prisma migrate diff | Atlas lint; Semgrep rules; CodeQL | Apache-2.0; Atlas paywalled, Semgrep rules restrictive, CodeQL engine license forbids |
| FS watching | @parcel/watcher + git status reconciliation | chokidar; Watchman | Native backends + coalescing; Watchman = extra daemon |
| Git perf | core.fsmonitor + untrackedCache + feature.manyFiles | — | Chromium status 17.9s→0.8s (documented) |
| Validation isolation | Child processes + worktrees + timeouts (local); Docker (server, P2) | Firecracker; Docker everywhere | Agent code already runs locally; Firecracker Linux/KVM-only; Docker tax on dev machines |
| Frontend | React 19 + TS, CSR SPA | Svelte 5; Solid | Ecosystem gravity (all chosen libs React-first); Linear's proven model |
| Stream state | Zustand normalized store, per-row selectors | MobX; Jotai; Redux | 491B gzip; "one delta = one cell re-render" |
| Server cache | TanStack Query (hot log excluded) | SWR; manual | Optimistic mutations, 13.3KB gzip |
| Virtualization | react-virtuoso (stream) + TanStack Virtual (tables) | react-window; virtua | Only lib with followOutput/prepend-stability semantics built in |
| Diff rendering | jsdiff + custom virtualized rows, lazy chunk | Monaco; diff2html; react-diff-viewer | Monaco 3.02MB gzip; per-hunk control needed |
| Command palette | cmdk | custom | Accessible combobox, 16.7KB gzip |
| Styling | Tailwind v4 + semantic CSS vars | CSS-in-JS; vanilla only | Zero runtime JS; token↔utility bridge |
| Primitives | Radix UI | Headless UI | Inside cmdk already; focus management |
| Design tokens | Primer-derived dark semantic tokens | invent from scratch | Verified contrast rules; methodology MIT |
| Secrets | gitleaks-style rules + entropy at ingest; @napi-rs/keyring | TruffleHog live verify; keytar | Hot-path speed; keytar unmaintained |
| Sync | Transactional outbox + idempotency + cursor catch-up | PowerSync; Electric; CRDTs | Exact fit for append-only; no extra service |
| Testing | Vitest + Playwright + custom load harness | Jest-only | Speed, ESM, browser tests for UI |
| Distribution | npm (daemon), Docker+bare Node (server) | Go single binary; Electron | No Electron tax; Node SEA immature; revisit if demanded |

## 2. Key decisions explained

### 2.1 One runtime (Node LTS) for daemon and server
Alternatives: Go (best single-binary, but cgo-or-slow SQLite and weaker tree-sitter ecosystem), Rust (lowest memory, slowest velocity, gix-merge incomplete), Bun (disputed 3–6× sqlite claim, Windows daemon maturity unproven). At <1MB/s ingest, Fastify's ~90K req/s headroom is ~1000×; runtime perf is not the bottleneck — **developer velocity and ecosystem fit are**. One language across daemon/server/UI removes an entire class of context-switching and lets the event protocol types be shared verbatim. Revisit Go only if single-binary distribution becomes a hard requirement.

### 2.2 SSE, not WebSocket
Our traffic is ~99% server→client. SSE gives reconnection + `Last-Event-ID` replay for free, and our event log makes replay a SQL `WHERE global_seq > $cursor` — the same cursor powers daemon catch-up. WebSocket would make us rebuild resume, heartbeats, and ordering (Linear's sync engine is a multi-quarter engineering artifact — justified for bidirectional mutation at their scale, not ours). Client RPC is plain POST. HTTP/2 avoids the 6-connection/origin cap. WebTransport adds HTTP/3 infra for datagrams we don't need.

### 2.3 SQLite local / Postgres central — and why no broker
Local: WAL + batched transactions amortize fsync; official SQLite guidance covers our write volume with 10× demonstrated headroom; better-sqlite3's synchronous API is ideal for the hook hot path (no async overhead per event). Central: monthly range partitions make retention a `DROP PARTITION` (no vacuum bloat); NOTIFY (<8000B) is a wake-up signal, never a transport. Brokers (Kafka 2M writes/s capability, NATS >10M msg/s vendor claim) are three orders of magnitude beyond need — each would add a daemon, a failure mode, and ops burden. pgmq only if server-side validation jobs later need a durable queue.

### 2.4 Git CLI as system of record
merge-tree (ort), rerere, worktree, fsmonitor, CAS update-ref: only the CLI has all, always current. Library options fail on maintenance (nodegit 2020, isomorphic-git volunteer-only), parity (libgit2 no ort, gix-merge partial), or process model (in-process crashes take the daemon down; CLI crashes are containable). Spawn cost (ms) is irrelevant at our operation rates; we batch via `--stdin` where available. GitButler's hunk-ownership/oplog **model** is borrowed; its FSL code is not.

### 2.5 Tree-sitter first, compilers on demand
Fresh full-file parses are millisecond-cheap (ast-grep benchmark: 43ms/500 files; ast-grep's Rust rewrite dropped incremental parsing entirely for snapshot work). So: git-diff-driven re-parse of changed files only, content-hash-keyed symbol store. Precise references come from one TS Compiler API program per repo (gopls lesson: typed ASTs ≈30× source size — never one server per worktree). SCIP batch indexing and stack-graphs are deferred (stack-graphs is officially unmaintained). This is the L0→L2 fidelity ladder; L3 semantic resolution is research-grade and explicitly out of scope.

### 2.6 MCP for coordination, hooks for enforcement
MCP tool calls are model-mediated (cooperative) — an agent can ignore them. The agent-coord pattern pairs the MCP board with a PreToolUse hook that **hard-blocks** edits to reserved files. Claude/Codex/Qoder/Cursor all support both; OpenCode via plugin hooks; Aider/generic via external git/fs enforcement only (labeled lower fidelity). Claude channels allow pushing "concurrent change" notices into a live session. A2A solves cross-organization agent federation — not our problem.

### 2.7 React + Zustand + Virtuoso: the Linear model, minus MobX
Linear's public architecture (per-property observables, IndexedDB-local, one-delta-one-cell) is the right target. Zustand per-row selectors achieve the same render granularity at 491B gzip without MobX's learning curve. The hot event log lives in the external store, **not** TanStack Query (Query is for request/response state). react-virtuoso is the only virtualizer with built-in follow-output, pause-on-scroll, and prepend stability — the exact semantics our stream spec requires. Svelte 5's INP advantage is real but bought with ecosystem loss; every other chosen library is React-first.

### 2.8 No LLM in the hot path
Activity summaries ("8 files in auth; 3 functions changed; signature of `foo()` changed") are **deterministic templates over structured events** — zero cost, zero latency, zero hallucination risk. Optional LLM recap (Claude Code `/recap` style, ≤400 chars) is a P2 background feature, off by default, clearly labeled as generated.

## 3. Operational cost profile

| Component | Idle cost | Notes |
|---|---|---|
| Daemon | <1% CPU, <150MB RSS target | One process; watcher + hook listener + shipper |
| Server | <1% CPU (team idle), <300MB RSS target | One process; SSE connections are cheap |
| Postgres | Small shared instance | Monthly partitions bound storage; retention configurable |
| External services | **Zero required** beyond existing git origin | No broker, no object store, no Redis |

## 4. Revisit triggers (measured, not hypothetical)

- Broker → only if sustained ingest >5k events/s/server or >3 independent consumer services.
- Go/Rust component → only if profiling shows Node GC/process overhead violating budgets.
- PowerSync/Electric → only if shared mutable editing emerges.
- Graph DB → only if reference queries exceed 100ms p95 at real repo scale.
- Monaco → only as lazy "open in editor" escape hatch.
- Bun → re-evaluate when Windows daemon maturity + independent benchmarks exist.