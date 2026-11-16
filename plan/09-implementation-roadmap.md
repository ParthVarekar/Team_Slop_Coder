# Weft — Implementation Roadmap

**Date:** 2026-11-07 · Strategy: a complete end-to-end vertical slice first (one developer, one agent, real events, real UI), then widen. The brief's phase hypothesis is adjusted: basic validation evidence moves earlier (it's the product's honesty core); MCP coordination and symbol intelligence follow the team server; the merge queue lands with attribution.

## Milestone overview

| Milestone | Theme | Outcome | Depends on |
|---|---|---|---|
| M0 | Foundation + benchmark harness | Repo, protocol types, CI, benchmarks exist before features | — |
| M1 | **Vertical slice: observe one agent** | Claude Code → daemon → local UI, tasks, solo mode | M0 |
| M2 | Team + git coordination | Server, multi-dev sync, Codex adapter, worktrees, file conflicts, basic validation evidence | M1 |
| M3 | Code intelligence + agent coordination | Symbol index, signature-impact warnings, MCP coordination + hard locks, OpenCode adapter | M2 |
| M4 | Verification + integration | Merge queue, health baseline, failure attribution, TIA, contract gates | M3 |
| M5 | Hardening + breadth | Benchmark-driven optimization, Cursor/Qoder/Cline/generic adapters, retention, handoffs | M4 |

---

## M0 — Foundation and measurement (≈1 week)

**Scope:** monorepo scaffold (pnpm workspaces: `protocol`, `daemon`, `server`, `ui`, `adapters/*`, `bench`); TypeScript strict; shared protocol-v1 types + zod schemas; SQLite/Postgres migration tooling; CI (lint, typecheck, unit, benchmark smoke); fixture repos + synthetic adapter harness; logging/metrics skeleton; **git version capability matrix** (merge-tree floor 2.38; fsmonitor availability detection + fallback).

**Components:** protocol package (envelope, catalog, zod), config system, ULID, redaction module (gitleaks-style rules + entropy, test corpus with planted secrets), bench harness v0.

**Acceptance:** CI green; `bench` runs and produces JSON artifacts; redaction corpus passes 100% (no planted secret survives); protocol round-trip property tests pass.

**Performance:** establish baseline numbers for hook path, batch insert, redaction throughput — before features exist.

**Tests:** unit + property-based (protocol), redaction corpus, migration up/down tests.

## M1 — Vertical slice: observe one agent, solo (≈2–3 weeks)

**Scope:** daemon with Claude Code hooks adapter (http + command, async); collector → redact → SQLite(events+outbox) → local SSE; local UI: activity stream with deterministic grouping, session list/timeline, filters, palette, dark tokens; basic tasks (local CRUD + state machine); observe-mode (no worktree required); auto-WIP safety on registered repos.

**Components:** hook receiver, Claude adapter + capability manifest, event pipeline, local SSE server, UI shell (rail/list/stream/inspector), ActivityStream + StreamGroup + EventRow, task store (local), watcher + git status reconciliation.

**Dependencies:** M0. **Outcome:** a developer sees their real Claude Code sessions grouped in a fast local UI with zero workflow change; tasks track state locally.

**Acceptance:** PRD §6 criteria 1, 5, 6 (local scope); hook p50 ≤5ms; event→UI p95 ≤100ms; 60fps/10k rows; daemon idle <1% CPU/<150MB; kill/restart loses no events.

**Performance:** burst sim 500/s; UI flood sim; idle soak.

**Tests:** adapter contract tests (recorded real hook payloads → expected events); pipeline crash-recovery tests; UI render-count assertions; Playwright golden path (register repo → run agent → see grouped activity → create/complete task).

## M2 — Team server and git coordination (≈3–4 weeks)

**Scope:** server (ingest dedup + global_seq, Postgres partitions on received_at + coordination_events, SSE fan-out, RBAC, audit); outbox shipper + cursor catch-up + min_seq watermark resync; **server→daemon coordination SSE channel**; team UI (shared stream, sessions across developers); Codex hooks adapter; worktree provisioning per task (opt-in, gated on claim-ack) + branch-per-task + device-namespaced auto-WIP + stale-lock recovery; file-level conflict detection (merge-tree gate + overlap warnings, daemon pairwise, **server canonical-key dedup + minted ids**); offline claim quarantine + rejection compensation; basic validation runner (configured checks in worktree, evidence attached, claims vs verified distinction); Inbox/triage (platform approvals).

**Components:** server ingest/query/fan-out, auth/token/RBAC, shipper, Codex adapter, worktree manager, conflict engine L0, validation supervisor + check_results, Inbox UI, task CAS claims.

**Dependencies:** M1. **Outcome:** two developers, two providers, one repo: shared visibility, no double-claims, file-conflict warnings before merge, completion requires evidence.

**Acceptance:** PRD §6 criteria 2, 3, 4; disconnect/reconnect sim zero loss/dup; **conflict dedup property test (two daemons, one logical conflict → one card)**; **offline double-claim → deterministic rejection + quarantine discarded**; merge-tree gate p95 ≤500ms; claim CAS p95 ≤20ms; event→team-UI p95 ≤250ms; coordination propagation ≤1s p95.

**Performance:** fan-out sim (100 clients); conflict storm sim (L0); outbox drain ≤10s.

**Tests:** sync chaos tests (kill network/server/daemon at every pipeline stage); dedup property tests; merge-tree fixture matrix (clean/textual/rename); RBAC penetration tests (cross-project access denied); partition-resume test (cursor below watermark → resync, no silent skip); Playwright two-developer scenario.

## M3 — Code intelligence and agent coordination (≈3–4 weeks)

**Scope:** tree-sitter symbol index (TS/JS), git-diff invalidation, signature normalization/diff; symbol-overlap warnings ("both modified foo()"); TS Compiler API reference resolution (one program/repo) → affected call sites/tasks; MCP coordination server (get_task/claim/report_progress/get_concurrent_changes/reserve_files) + PreToolUse hard-lock enforcement + Claude channels push; OpenCode SSE adapter; dependency-cruiser module graph.

**Components:** indexer, symbols/symbol_edges stores, overlap engine L1/L2, MCP server, reservation leases, OpenCode adapter, context-budget assembler (deterministic, ≤2KB).

**Dependencies:** M2. **Outcome:** agents receive relevant concurrent-change context; signature changes surface affected tasks before merge; reservations hard-block collisions.

**Acceptance:** signature-change fixture produces correct call-site list (precision ≥95% on fixture, recall labeled); incremental update ≤50ms/file p95; full index 10k files ≤60s; **resolver process RSS ≤1GB @10k files (exit benchmark)**; hard-lock blocks reserved-file edit in integration test **only on capability-supported adapters (auto-downgrade verified elsewhere)**; **lease renewal/expiry-grace test (no mid-edit lock steal)**; context payload ≤2KB and contains no raw event dumps.

**Performance:** monorepo sim (index memory ≤80MB; resolver benchmark); conflict storm L1/L2 incremental sweep ≤100ms.

**Tests:** symbol-extraction golden fixtures per grammar; reference-resolution accuracy fixtures; **branch-scoped index isolation test (two branches, no overwrite)**; reservation race tests (concurrent claims, renewal, lease expiry); MCP tool contract tests; prompt-injection corpus (agent-origin content never becomes instructions).

## M4 — Verification, integration, attribution (≈3–4 weeks)

**Scope:** merge queue (**lease-elected queue-executor daemon**: fetch → merge-tree chain → commit-tree → cross-device exact-tree validation → origin push with old-OID precondition; protected-branch strategy via host merge API or promotion ref); health baselines (full-suite safety net); failure attribution (changes-since-healthy ranking, confirmed via revert-test vs suspected); safe revert recovery; TIA (Jest related-tests/affected); contract gates (oasdiff/buf/squawk/prisma where configured); validation result cache (input_hash + toolchain fingerprint + TTL + flake quarantine).

**Components:** queue coordinator, baseline manager, attribution engine, revert workflows, TIA selector, contract gate runners, cache.

**Dependencies:** M3. **Outcome:** merges are gated on independent validation of the exact merged tree; regressions are attributed with evidence; recovery never discards others' work.

**Acceptance:** queue never merges unvalidated tree (property test over failure injections); ejected entry requeues correctly; **executor failover: kill mid-advance → successor re-reads origin, CAS push never overwrites, no double-merge**; **queue-gating validation runs on device ≠ claimant**; protected-branch path never bypasses host rules; attribution fixture: planted regression → correct top-ranked change (confirmed) ≥90% of fixtures; revert preserves unrelated work (git-level assertions); cache hit skips identical re-run; **flake quarantine invalidates cached pass on subsequent failure**.

**Performance:** queue overhead ≤200ms excluding checks; attribution sweep ≤2s/40 tasks.

**Tests:** queue chaos (fail mid-test, crash mid-advance, executor failover — CAS invariant); attribution fixture suite; revert safety tests; cache correctness (fingerprint mismatch, TTL expiry, collision tests); end-to-end: two agents → conflict warned → validated → merged → regression planted → attributed → reverted.

## M5 — Hardening and breadth (≈2–3 weeks + ongoing)

**Scope:** benchmark-driven optimization (top 3 measured bottlenecks only); Cursor + Qoder adapters; Cline SDK adapter; generic CLI wrapper (PTY+fs+git) + Aider fallback; retention/compaction UI + partition automation; deterministic handoff summaries; optional LLM recap (off by default); notification webhooks; docs + self-host packaging (Docker image, daemon npm).

**Dependencies:** M4. **Outcome:** production-ready self-hosted beta; adapter breadth; measured optimization report.

**Acceptance:** all §4 load sims pass; 24h soak ≤5% memory growth; bundle ≤300KB gzip; each new adapter passes contract tests + fidelity manifest honesty; optimization report shows before/after for every change.

**Tests:** full sim matrix nightly; adapter contract suites; upgrade/migration tests; packaging smoke (clean-machine install).

---

## Cross-cutting test strategy

- **Unit/property**: protocol, redaction, state machines, CAS, dedup, overlap math.
- **Contract**: every adapter against recorded real provider payloads (checked-in fixtures, refreshed per provider release).
- **Integration**: fixture repos + real git (no mocks for git semantics); real Claude Code/Codex smoke runs in CI where credentials allow, recorded otherwise.
- **Chaos**: kill/network-partition at every pipeline boundary; assert zero loss/dup, work preserved.
- **UI**: Playwright golden paths + render-count assertions + axe accessibility checks.
- **Security**: redaction corpus, RBAC penetration, prompt-injection corpus, token/audit tests.
- **Performance**: per-PR microbenchmarks (10% regression gate), nightly sims, weekly soak.

## Deferred (explicitly out until measured need)

ACP launched sessions, Python/Go indexers, server Docker runners, coverage-based test mapping, multi-repo projects, dependency-explorer view, mobile, L3 semantic graphs, CRDTs, brokers, hosted cloud. Each has a revisit trigger in [04](04-technology-decisions.md) §4 or [10](10-risk-register.md).

## Effort honesty

Estimates are engineer-weeks for a focused senior engineer with agent assistance, validated against the research fidelity ladder (L0 1–2wk, L1 +2–4wk, L2 +4–8wk). Total to M4: ≈12–16 weeks. The vertical slice (M1) is deliberately usable in ≈3–4 weeks from kickoff.