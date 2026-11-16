# Weft — Architecture Plan Package

**Working codename:** Weft · **Date:** 2026-11-07 · **Status:** Research and planning complete. **No application code has been written. Awaiting explicit approval to implement.**

A local-first, self-hostable coordination, observability, and verification platform for teams of developers and their AI coding agents working on the same repository.

## The package

| # | Document | Contents |
|---|---|---|
| 01 | [Research Report](01-research-report.md) | Market landscape + capability matrix, agent integration research, git/code-intelligence research, infrastructure research, UI/UX references, reuse/build/avoid decisions, sources |
| 02 | [Product Requirements](02-product-requirements.md) | Vision, users, workflows, P0–P3 features, NFRs, acceptance criteria, MVP boundary |
| 03 | [Architecture](03-architecture.md) | Three-way architecture comparison, selected design, Mermaid diagrams, subsystems, data/event flows, privacy modes, deployment |
| 04 | [Technology Decisions](04-technology-decisions.md) | Every selection vs alternatives, trade-offs, ops cost, measured revisit triggers |
| 05 | [Data Model](05-data-model.md) | Entities, fields, ER diagram, local vs central locality rules, indexing plan |
| 06 | [Event Protocol v1](06-event-protocol.md) | Envelope, catalog, ordering/idempotency/dedup, offline buffering, versioning, recovery, payload examples |
| 07 | [UI Specification](07-ui-specification.md) | Information architecture, screens, components, interactions, keyboard map, design tokens, performance contract |
| 08 | [Performance Plan](08-performance-plan.md) | Measurable SLOs, benchmark methodology, load simulations, per-subsystem budgets |
| 09 | [Implementation Roadmap](09-implementation-roadmap.md) | M0–M5 milestones with scope, acceptance criteria, test strategy; vertical slice first |
| 10 | [Risk Register](10-risk-register.md) | Technical/integration/security/operational/product risks with designed-in mitigations |

## Key decisions (one paragraph each)

- **Build the core, reuse the commodity.** No product does cross-developer coordination + symbol-level conflicts + independent validation + failure attribution, local-first. Forking shortcuts nothing; lift Apache-2.0/MIT components (VK executor patterns, tree-sitter, oasdiff/buf/squawk, Radix/cmdk) and build the differentiators.
- **Local-first modular monolith, two deployments.** One TypeScript codebase: daemon per developer (collection, redaction, indexing, worktrees, validation, MCP coordination; fully offline-capable) + one team server (tasks, conflict aggregation, merge queue, baselines, RBAC). SQLite locally, Postgres centrally. No brokers, no microservices, no CRDTs — the scale (<1MB/s ingest) doesn't justify them.
- **Native hooks + MCP hybrid.** Claude-shaped hooks are the de-facto standard (Claude/Codex/Qoder/Cursor); OpenCode via SSE. MCP server for cooperative coordination; PreToolUse hooks for hard enforcement. Agents never leave their native environments.
- **Git CLI plumbing + ort merge-tree.** Worktree per task, auto-WIP protection, in-core conflict gates (P50 ~8ms), speculative merge queue with CAS ref advance. Never force, never discard uncommitted work.
- **Evidence, not claims.** Agent completion is a claim; "verified" requires independently executed checks with inspectable evidence. Health baselines + failure attribution close the loop.
- **SSE + outbox sync.** Last-Event-ID resume is a SQL cursor; transactional outbox + idempotency gives zero loss/dup across crashes and disconnects.
- **Claude Code × Linear UI.** Inbox/triage landing, stream + inline adjudication, per-row rendering, dark Primer-derived tokens, ≤300KB initial JS, keyboard-first.

## Stage 6 self-review (completed)

An independent principal-engineer review found 18 issues (3 critical, 10 major, 5 minor); **all were fixed** in this package before presentation. The substantive corrections:

- **Merge queue now executable in every privacy mode:** a lease-elected queue-executor daemon does fetch → merge-tree → commit-tree → cross-device validation → origin push with an old-OID precondition (CAS, fail-on-moved); protected branches use the host merge API or a promotion ref. The server coordinates state without ever needing blobs.
- **Server→daemon coordination channel added** (device-authenticated SSE, ≤1s propagation) so reservation/claim enforcement copies stay fresh; hard locks fail closed when stale.
- **Symbol index is branch-scoped** `(repo, tree_oid, path, qualified_name)` with branch-owner authority — concurrent branches no longer overwrite each other.
- **Conflict identity is server-minted** from a canonical key (sorted tasks + kind + normalized symbols), with append-only evidence and epoch-based resolution — no duplicate cards, no flapping.
- **Offline claims are quarantined** until server ack; losing claims get `task.claim_rejected` + compensation; task edits merge field-level with explicit edit-conflicts (no silent loss).
- **Event storage is partition-safe:** partition on server `received_at`, partition-key-inclusive dedup, `min_seq` watermark resync, never-expiring coordination_events table.
- **Validation independence is honest:** team-mode queue gates run on a device ≠ the claimant; solo is labeled self-validation; cache has toolchain fingerprints, TTL, and flake quarantine.
- **UI control claims scoped to reality:** observe mode cannot steer/interrupt/approve agent prompts — approval cards act on platform actions; agent control is launched-session-only (P2).
- Plus: out-of-process TS resolver (memory budget), reservation renewal leases + capability-gated enforcement, sync-vs-async hook classes, device-namespaced WIP refs, missing discussion/handoff/validation-requirement entities, git-version capability matrix, and primary-source re-verification of Claude/Codex/Qoder hooks.

## Execution order honored

Stage 0 reconnaissance (empty workspace; git 2.53, Node 24, Bun, Python, Docker available) → Stage 1 market research → Stage 2 technical research → Stage 3 UI/UX research → Stage 4 architecture comparison → Stage 5 this package → Stage 6 critical self-review → **Stage 7: stopped for approval.**