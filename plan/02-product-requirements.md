# Weft — Product Requirements Document

**Date:** 2026-11-07 · **Status:** Proposed; awaiting approval.

## 1. Vision

A local-first, self-hostable coordination, observability, and verification platform that makes independently operating developers and their AI coding agents behave like one coordinated engineering team — without asking anyone to abandon their preferred agent or environment.

**One-line:** Mission control + agent observability + git intelligence + code intelligence + independent verification for human+agent teams.

**Not:** another coding agent, a generic SaaS dashboard, or a glue layer of existing tools.

## 2. Target users and roles

| Role | Description | Primary needs |
|---|---|---|
| Developer (member) | Runs 1+ coding agents locally (Claude Code, Codex, OpenCode, Cursor, Qoder, generic CLI) | See what other agents are changing; avoid conflicts; get tasks done with verified results |
| Tech lead / maintainer (admin) | Owns repo health, integration, review | Triage what needs a human; gate merges on independent validation; attribute failures |
| Team / org | 2–20 developers, shared repositories | Self-hosted coordination; access control; audit |
| Observer (viewer) | PM, reviewer | Read-only activity, task state, validation evidence |

## 3. Core workflows

1. **Observe any session (zero workflow change):** developer installs daemon, registers repo; existing agent sessions (any supported provider) appear in the activity stream with grouped summaries. No worktree required.
2. **Coordinate a task:** lead creates task with acceptance criteria + expected modules → assigns to developer/agent → agent claims via MCP or UI → worktree+branch provisioned → agent works; platform streams grouped activity, warns on overlaps with concurrent tasks → agent reports done → independent validation runs → evidence attached → human reviews → merge queue integrates.
3. **Avoid a collision:** agent A changes `getUserById()` signature; platform detects agent B's task calls it; B's agent receives a contextual notice via MCP channel + B sees a conflict card with affected call sites — before merge.
4. **Recover a regression:** integration branch health turns red; platform lists changes since last healthy baseline, ranks likely causes (confirmed vs suspected), links sessions/commits/tasks; offers safe revert of the offending merge without touching other work.
5. **Triage:** inbox shows approvals, agent questions, failures, conflicts; keyboard-driven accept/decline/snooze; auto-advance.

## 4. Feature requirements (prioritized)

**P0 — essential (MVP):**
- F1 Daemon: repo registration, developer/device registration, local SQLite event store, offline-capable.
- F2 Claude Code adapter via native hooks (http/command, async) — full-fidelity sessions, tool calls, file changes, completion/errors.
- F3 Normalized event protocol v1 (envelope, ordering, idempotency, offline outbox, dedup).
- F4 Real-time activity UI: grouped/coalesced stream ("modified 8 files in auth; 3 functions changed"), expandable evidence, session timelines, filters (developer/agent/task/module/severity), search, replay, virtualized.
- F5 Tasks: full state machine (BACKLOG→READY→CLAIMED→IN_PROGRESS→REVIEW→VALIDATION→COMPLETED; BLOCKED/FAILED/CANCELLED), assignment (single primary; multi-assignee P1), dependencies, acceptance criteria, per-task validation requirements, append-only discussion, completion evidence. Handoffs P1.
- F6 Team server: multi-developer ingest, SSE fan-out, RBAC (viewer/member/admin), project isolation, audit log.
- F7 Metadata-only sync by default; ingest-time secret redaction; configurable diff/source upload.
- F8 Git worktree provisioning per task (opt-in), branch-per-task, auto-WIP protection, stale-lock recovery.
- F9 File-level conflict detection: merge-tree gate + overlapping-file warnings across active tasks.
- F10 Basic validation runner: configured project checks (typecheck/lint/test/build) executed in the task worktree; results attached to task as evidence; agent-reported completion visibly distinguished from verified completion.
- F11 Inbox/triage landing view; command palette; keyboard navigation; dark theme.
- F12 Local solo mode (daemon only) with full personal functionality.

**P1 — important:**
- F13 Codex + OpenCode adapters (hooks; SSE).
- F14 MCP coordination server: task claim/progress, project-context queries, file reservations with renewal leases; PreToolUse hard-lock enforcement **capability-gated per adapter** (auto-downgrade to soft where sync enforcement is unavailable, labeled); Claude channels push for concurrent-change notices.
- F15 Symbol-level intelligence: tree-sitter symbol/signature index (TS/JS first), git-diff-driven incremental updates, signature-change detection, same-symbol overlap warnings.
- F16 Reference-level impact: TS Compiler API call sites for changed exports; affected-task identification.
- F17 Merge queue: speculative integration trees (merge-tree), validation gating, eject-and-requeue, CAS ref advance.
- F18 Health baseline + failure attribution: changes-since-healthy correlation, confirmed/suspected ranking, safe revert.
- F19 Test impact analysis: Jest related-tests / affected-only selection with periodic full-suite safety net.
- F20 Contract gates: oasdiff / buf breaking / squawk / prisma migrate diff where applicable.
- F21 Cursor + Qoder adapters; generic CLI wrapper (PTY + fs + git) fallback.
- F22 Event retention policies; partition-based compaction; historical search.

**P2 — later:**
- F23 Cline adapter (SDK/CLI); ACP launched-session support (run agents from the platform via SDKs).
- F24 Python/Go symbol extraction + per-language LSP resolvers.
- F25 Server-side Docker validation runners; hash-keyed validation cache.
- F26 Context-aware handoffs (deterministic summaries; optional LLM summarization, off by default).
- F27 Dependency explorer view; project architecture map.
- F28 Notifications integrations (Slack/webhooks); mobile-responsive read view.
- F29 Coverage-based test mapping; multi-repo projects.

**P3 — optional / deferred:**
- F30 Full semantic call graphs / stack-graphs-style resolution (research-grade).
- F31 CRDT collaborative editing; Electric/PowerSync sync.
- F32 Hosted multi-tenant cloud (Firecracker); A2A federation.
- F33 Risk-based task scheduling; advanced analytics (DuckDB/Parquet).
- F34 Rich database-entity and test knowledge graph (beyond contract/migration gates and check results); full semantic call graphs.

## 5. Non-functional requirements

| Category | Requirement |
|---|---|
| Performance | See [08-performance-plan.md](08-performance-plan.md); all targets benchmark-verified, not assumed |
| Privacy | No source blobs leave the machine by default; redaction before persist/broadcast; configurable sync scopes |
| Reliability | No silent overwrites; no unvalidated merges; at-least-once event delivery with dedup; offline buffering; crash recovery (stale locks, outbox replay); never lose uncommitted work (auto-WIP) |
| Compatibility | Windows / macOS / Linux daemons; git ≥ 2.38 (merge-tree); fsmonitor where available (≥2.55 Linux / ≥2.36 Win / ≥2.37 macOS) with detected fallback; Node LTS runtime |
| Extensibility | New agent = new adapter package, no core changes; versioned event protocol |
| Security | Project-scoped tokens, RBAC, audit, workspace isolation, safe command execution (timeouts/semaphores/scrubbed env), agent-origin content treated as untrusted data |
| Operability | Single server process + Postgres; daemon auto-start; zero mandatory external services beyond git hosting |
| Honesty | No fabricated activity or results; every completion claim carries evidence or is marked unverified |

## 6. Acceptance criteria (MVP-level)

1. A developer running Claude Code in their own checkout sees grouped, accurate activity in the local UI within 250ms p95 of hook firing, with zero workflow changes.
2. Two developers on one repo see each other's sessions/tasks in the team UI; events survive daemon restart and network disconnection without loss or duplication (verified by kill/reconnect tests).
3. Two tasks editing the same file produce a warning before either merges; a clean merge-tree result is required before queue admission.
4. A task cannot display "verified complete" without a passing validation run whose exit codes, durations, and log digests are inspectable.
5. A command containing a planted secret never appears unredacted in any stored event, stream, or UI (redaction test suite).
6. Killing an agent mid-edit leaves recoverable work (auto-WIP ref) and a resumable session record.
7. All P0 UI flows are keyboard-operable; stream remains 60fps with 10k rows under simulated load.
8. Benchmarks in 08 run in CI and fail on regression beyond budget.

## 7. MVP scope boundary

MVP = P0 (F1–F12) **plus the Codex portion of F13** (marginal cost: it shares the Claude-shaped hook path and proves multi-provider early): Claude Code + Codex, observe-mode + opt-in worktrees, file-level conflicts, basic validation evidence, solo + team modes. MVP activity templates are **degraded to file/line counts** ("modified 8 files in auth"); function/contract clauses activate with M3/M4 intelligence. Symbol intelligence, MCP coordination, merge queue, and attribution are P1 fast-follows (M3/M4). Rationale in [09-implementation-roadmap.md](09-implementation-roadmap.md): a complete end-to-end vertical slice first.

## 8. Performance and reliability objectives (summary)

- Event-to-UI p95 ≤ 250ms (LAN); ingest p50 ≤ 5ms local; ≥5k events/s daemon headroom.
- Daemon idle CPU < 1%, RSS < 150MB idle / < 300MB active; startup < 2s.
- UI initial load ≤ 1.5s, initial JS ≤ 300KB gzip; 60fps streaming scroll.
- Incremental symbol update ≤ 50ms/file p95; merge-tree gate ≤ 500ms p95 (PR-sized diffs).
- Zero event loss on crash/disconnect (outbox + dedup); RPO ≈ 0 for acknowledged events, server partition retention configurable.