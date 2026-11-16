# Weft — Risk Register

**Date:** 2026-11-07 · Scoring: likelihood (L/M/H) × impact (L/M/H). Every risk has an owner-subsystem and a mitigation that is designed-in, not aspirational.

## 1. Technical risks

| # | Risk | L×I | Mitigation | Trigger to revisit |
|---|---|---|---|---|
| T1 | **Provider hook APIs drift** (Codex app-server "experimental"; transcripts "not stable"; OpenCode v1→v2 plugin break) | H×M | Adapters isolated per provider with capability manifests + contract fixtures refreshed per release; protocol upcasters; fidelity labels in UI; never depend on undocumented formats in the core | Any provider release breaks contract tests |
| T2 | **Semantic analysis over-promises**: name-based edges ≠ ground truth; dynamic languages limit precision | H×M | Fidelity ladder L0→L2 with precision labels (exact vs name_based); warnings never block merges except textual conflicts; L3 explicitly deferred; accuracy fixtures with published precision/recall | Fixture precision <95% (L2) |
| T3 | **Windows filesystem quirks** (ReadDirectoryChangesW buffer overflow discards events) | M×M | Watcher events are hints; git status is truth; full rescan on overflow/restart; chaos sim injects ERROR_NOTIFY_ENUM_DIR | Rescan cost >1s on 100k files |
| T4 | **Monorepo scale** (index memory, status time) | M×M | fsmonitor+untrackedCache+manyFiles with **version capability detection + no-fsmonitor fallback (≤5s)**; git-diff-driven invalidation; **out-of-process resolver (≤1GB, idle eviction)**; indexer RSS cap 80MB; 400k-file sim in CI | Sim fails |
| T5 | **Git edge cases** (submodules incomplete worktree support, stale locks from SIGKILL, gc pruning worktrees) | M×H | Lock agent worktrees; stale-lock detection/recovery; submodule repos flagged "limited support" in v1; never force; auto-WIP refs | Data-loss incident in chaos tests |
| T6 | **Node daemon distribution maturity** (no clean single binary; SEA immature) | M×L | npm distribution + documented Node LTS requirement; revisit Go only if single-binary becomes a hard requirement | User demand evidence |
| T7 | **SSE proxy buffering/idle timeouts** in corporate networks | M×L | 15s heartbeats; `X-Accel-Buffering: no`; resume via Last-Event-ID; reconnect chaos tests | Field reports |
| T8 | **Summary grouping hides important events** | M×M | Deterministic templates; severity bypass (failures/conflicts never coalesced away); expand-to-evidence always available; grouping rules tested | User misses a critical event in dogfood |

## 2. Integration risks

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| I1 | **Agents ignore cooperative MCP coordination**; hard-lock coverage gaps (Codex trust review, Cursor cloud command-hooks-only, shell writes bypass Edit matchers) | H×M | Hybrid enforcement capability-gated per adapter/session (auto-downgrade to soft, labeled); intercepted tool set includes shell file-write detection; renewal leases + expiry grace; git-level fallback for non-MCP agents |
| I2 | **Provider absorbs the category** (GitHub Agent HQ, Claude teams/Projects, Codex app worktrees, Amp Spaces) | H×H | Cross-provider + local-first + self-hosted wedge (none of them do all three); speed to M4; integrate rather than compete where possible (origin-agnostic) |
| I3 | **Roo Code dead, others may follow** (VK sunset, Jules, Terragon, Conductor→Meta) | M×L | Adapter architecture makes provider death a contained event; no core dependency on any single provider; market scan quarterly |
| I4 | **Hook installation friction** (developers must opt in; OTel can't be repo-configured) | M×M | One-command setup (`weft init` writes user-level hook config); observe-mode value visible in <5 min; fallback watcher mode works with zero config (lower fidelity, labeled) |
| I5 | **Cursor cloud redactions / command-hooks-only limits** | M×L | Manifest declares gaps; cloud sessions treated as medium fidelity; local Cursor hooks full fidelity |

## 3. Security risks

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| S1 | **Prompt injection via event content** (agent output rendered in UI; context fed back to agents) | H×H | All agent-origin content is untrusted data: text-only rendering, provenance labels, context assembler emits structured facts never raw instructions; injection corpus in CI; no auto-execution of anything event-derived |
| S2 | **Secret leakage in events/logs/diffs** | M×H | Redaction before persistence/broadcast (fail closed); planted-secret corpus 100% gate; metadata-only default; diffs opt-in; retention caps |
| S3 | **Daemon token theft / LAN exposure / hook-receiver forgery** | L×H | Localhost bind default; OS keychain; device keypairs sign batches; hook receiver auth (rotatable secret / IPC peer creds); same-user forgery is a documented solo-mode residual — team-mode evidence weight from cross-device validation; explicit LAN opt-in; rotation + audit |
| S4 | **Cross-project data access on server** | L×H | project_id predicate on every query (lint-enforced); RBAC penetration tests; append-only audit |
| S5 | **Validation executes malicious project commands** | M×H | Commands are project-configured by admins (not agent-supplied); timeouts/semaphore/scrubbed env; server-side runners explicitly registered + scoped; never execute event-derived commands |
| S6 | **Supply chain / licensing** (CodeQL, Semgrep rules, GitButler FSL, Atlas) | L×H | Allowlist of permissive licenses only (MIT/Apache-2.0); no GitButler code; license check in CI; dependency audit per release |

## 4. Operational risks

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| O1 | **Server SPOF** for team coordination | M×M | Daemons fully functional offline (provisional claims); server restart recovers from Postgres; no in-memory authoritative state; optional Litestream for SQLite solo backup |
| O2 | **Event storage growth** | M×M | Monthly partitions + DROP retention; outbox compaction (telemetry first, never task ops/evidence); storage metrics + alerts |
| O3 | **Clock skew across devices** | M×L | Ordering never uses client ts; skew >5min flagged; server received_at recorded |
| O4 | **Git origin variance** (auth, branch protection forbids direct push) | M×M | Origin-agnostic plumbing; protection detection picks host merge API or unprotected integration ref + promotion PR (never bypass); executor push uses old-OID precondition; integration matrix tests; self-hosted Gitea in CI |
| O5 | **Upgrade/migration breakage** | L×M | Protocol versioning + upcasters; migration up/down tests; daemon/server version handshake; N-1 compatibility window |
| O6 | **Queue-executor daemon failure mid-advance** | M×M | Fenced renewable lease; successor re-reads origin truth; CAS push (old-OID precondition) makes partial execution safe; failover chaos test in M4 |

## 5. Product/adoption risks

| # | Risk | L×I | Mitigation |
|---|---|---|---|
| P1 | **Approval/notification fatigue** (the Claude Code lesson) | H×M | Inbox triage with four exits; severity bypass only for true blockers; grouping defaults conservative; configurable notification budget |
| P2 | **"Another dashboard" perception** | M×H | Land on Inbox (what needs you now), not metrics; zero-config observe mode; keyboard-first; no card grids |
| P3 | **Trust gap: users don't believe validation** | M×H | Evidence always inspectable; claims vs verified visually distinct; independence labeled (self / cross-device / server); queue-gating runs on device ≠ claimant in team mode; no fabricated results ever |
| P4 | **Scope creep into agent-building** | M×H | PRD boundary: not a coding agent; launched sessions P2 at earliest; every feature must justify against coordination/verification mission |

## 6. Top 5 risks to watch weekly

1. **I2 platform gravity** — strategic; speed + cross-provider/self-hosted wedge.
2. **T1 hook drift** — contract fixtures per provider release.
3. **S1 prompt injection** — corpus + provenance discipline.
4. **T2 semantic over-promise** — precision labels + fixtures; never block on heuristics.
5. **P1 approval fatigue** — dogfood triage metrics (time-to-inbox-zero).