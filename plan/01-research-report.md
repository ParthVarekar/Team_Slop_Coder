# Weft — Research Report

**Working codename:** Weft (the thread that binds parallel yarns into one fabric).
**Date:** 2026-11-07 · **Status:** Research complete; awaiting implementation approval.
**Method:** Five parallel research workstreams (market, agent integrations, git/code intelligence, infrastructure, UI/UX), primary sources preferred (official docs, repositories, engineering publications). Load-bearing claims spot-verified: Claude Code hook catalog confirmed against official docs; `git merge-tree --write-tree` confirmed on installed git 2.53. Claims not verifiable from primary sources are marked UNKNOWN.

---

## 1. Market landscape

### 1.1 Structural shifts (2025–2026)

The standalone "parallel agent runner" category is consolidating rapidly:

| Event | Date | Consequence |
|---|---|---|
| Vibe Kanban's company (bloop) shut down; cloud/team layer deleted, project continues as community OSS | Apr 2026 | Best reusable adapter code survives (Apache-2.0), but the product retreated to single-user local |
| Terragon shut down; as-is OSS snapshot | Jan 2026 | Cloud-sandbox orchestrator category losing independents |
| Google Jules winding down (read-only Nov 11, end Dec 31) | Oct 2026 announcement | Folded into Google Antigravity |
| Conductor acquired by Meta | Nov 4, 2026 | Strongest parallel-agent UX now inside a platform company |
| Roo Code discontinued (extension + cloud) | May 15, 2026 | Do not build an adapter; community fork "ZooCode" exists |
| Coder AgentAPI archived | 2026 | HTTP-wrapper pattern deprecated by its author |
| Crystal → Nimbalyst, dormant | Feb 2026 | — |
| GitHub Agent HQ shipped (Agents tab, Copilot desktop app, Claude/Codex on GitHub, Copilot Projects) | Oct 2025 → Oct 2026 | The closest big-platform competitor to this spec — but GitHub-cloud-only |
| Amp "Spaces" (team-shared agent coordination) | Nov 6, 2026 | Closed, Amp-only; validates the team-coordination direction |
| OpenHands repositioned as "Agent Canvas" (self-hosted multi-agent control center) | 2026 | Healthiest extensible OSS base, but conversation-centric |

Sources: [VK shutdown](https://www.vibekanban.com/blog/shutdown), [VK releases](https://github.com/BloopAI/vibe-kanban/releases), [Conductor](https://www.conductor.build/), [Jules changelog](https://jules.google/docs/changelog/), [Roo Code repo](https://github.com/RooCodeInc/Roo-Code), [AgentAPI](https://github.com/coder/agentapi), [Agent HQ announcement](https://github.blog/news-insights/company-news/welcome-home-agents/), [Agents tab](https://github.blog/changelog/2026-01-26-introducing-the-agents-tab-in-your-repository/), [Claude/Codex on GitHub](https://github.blog/changelog/2026-02-04-claude-and-codex-are-now-available-in-public-preview-on-github/), [Copilot app changelog](https://github.com/github/app/blob/main/changelog.md), [Amp Spaces](https://ampcode.com/news/spaces), [OpenHands](https://github.com/OpenHands/openhands).

### 1.2 Product findings (condensed)

- **Vibe Kanban** — Rust backend crates: `executors` (per-agent adapters: claude/codex/gemini/amp/copilot/cursor/droid/opencode/qwen + ACP module), `worktree-manager`, `git`, `db` (SQLx/SQLite), `mcp`, `review`; React frontend. Spawns agent CLIs in per-task worktrees; Claude via `--output-format=stream-json`; stdout normalized into a unified `NormalizedEntry` log store. **Highest reuse value** (Apache-2.0): executor adapters, worktree lifecycle, log normalization. No cross-workspace conflict detection, no independent validation. [crates](https://github.com/BloopAI/vibe-kanban/tree/main/crates), [claude.rs](https://github.com/BloopAI/vibe-kanban/blob/main/crates/executors/src/executors/claude.rs)
- **Conductor** — worktree+branch per workspace; cloud workspaces in Firecracker microVMs; "multiplayer" shared workspaces; API + MCP server; user-configured test "Actions". Closed, cloud-centric, now Meta. UX benchmark only. [worktrees](https://www.conductor.build/docs/concepts/git-worktrees), [API](https://www.conductor.build/docs/api)
- **Paradev (ex-Superset)** — MIT Electron app, very active; worktree+branch+terminals per task; any CLI agent; PR pane, browser, automations (GitHub/Slack/Linear/Sentry triggers). macOS-primary; team = shared hosts, not a coordination plane; no conflict detection or independent validation. [repo](https://github.com/paradevai/paradev), [docs](https://docs.paradev.com)
- **OpenHands / Agent Canvas** — MIT, near-daily releases; runs own agent + Claude/Codex/Gemini/OpenCode/any ACP agent; Docker-per-conversation; append-only type-safe event stream drives execution/state (SDK); shared team agent-server. Conversation-centric; no worktrees, git intelligence, or verification. [events architecture](https://docs.openhands.dev/sdk/arch/events), [SDK paper](https://arxiv.org/html/2511.03690v2)
- **GitHub Agent HQ / Copilot app / Copilot Projects** — team mission control across GitHub/VS Code/mobile/desktop; Copilot coding agent runs in ephemeral Actions environments (self-hosted runners supported); validation = repo CI + Copilot review; Copilot app has a git conflicts view (reactive) and Autofix for failed checks. Cloud-locked, PR-centric; no symbol-level conflict prediction, no neutral re-verification of agent claims. [mission control](https://github.blog/changelog/2025-10-28-a-mission-control-to-assign-steer-and-track-copilot-coding-agent-tasks/), [runners](https://github.blog/changelog/2025-10-28-copilot-coding-agent-now-supports-self-hosted-runners/), [Universe 2026 recap](https://globalai.community/blog/github-universe-2026-day-1)
- **Cursor Cloud Agents** — isolated cloud VMs (self-hosted worker pools possible); full API (create/steer/stream/cancel, artifacts, webhooks). Single-provider. [API](https://cursor.com/docs/cloud-agent/api/endpoints)
- **Devin** — cloud VM per session (SSH-able), CLI with local sandbox + lifecycle hooks; Teams budgets/IP lists. Closed SaaS. [docs](https://docs.devin.ai/get-started/devin-intro)
- **Claude Code agent teams** — experimental; lead + teammates, shared task list + JSON mailboxes in `~/.claude/teams/`; **teammates share one working directory** (no isolation); single-user/single-machine. Cloud sessions + Projects beta coordinate one user's parallel cloud sessions. [agent teams](https://code.claude.com/docs/en/agent-teams), [web](https://code.claude.com/docs/en/claude-code-on-the-web)
- **Codex app/cloud** — macOS/Windows command center with built-in worktrees; cloud tasks in isolated environments; review queue. OpenAI-only. [app](https://openai.com/index/introducing-the-codex-app/)
- **Omnara** — Apache-2.0 Go/Postgres managed-agent platform (orgs/RBAC, machines, sandboxes, event streaming); pivoted away from coding mission control. Good runtime-substrate reference. [repo](https://github.com/omnara-ai/omnara)
- **Secondary**: Claude Squad (Go TUI, tmux+worktrees, slowing), Container Use (Dagger; MCP server, container-per-agent on own branch, full command history — "what agents actually did, not what they claim"), opcode (Tauri Claude Code GUI, AGPL), Happy Coder (MIT, E2E-encrypted remote control, any ACP agent), Sculptor (Imbue, MIT, isolated copies + merge-back), Backlog.md (git-native markdown task board pattern), Zed's **Agent Client Protocol (ACP)** — the emerging editor↔agent interop standard (Apache-2.0), now used by OpenHands, VK, Happy, Gemini CLI. [ACP](https://github.com/zed-industries/agent-client-protocol), [Container Use](https://github.com/dagger/container-use), [Backlog.md](https://github.com/MrLesk/Backlog.md)

### 1.3 Capability matrix

**Y** = documented/shipped · **P** = partial · **N** = absent in inspected docs/source · **?** = UNKNOWN.

| Product | Team | Conc. agents | Multi-provider | Session mon. | Real-time | Task coord. | Worktree isolation | File conflicts | Symbol conflicts | Deps analysis | API contracts | Independent validation | Regression detect. | Merge workflow | Self-host | Local-first | Extensible |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Vibe Kanban | P¹ | Y | Y | Y | Y | Y | Y | N | N | N | N | N | N | Y | Y | Y | Y |
| Conductor | Y | Y | Y | Y | Y | P | Y² | N | N | N | N | P | N | Y | N | P | P |
| Paradev | P | Y | Y | Y | Y | P | Y | N | N | N | N | P | N | Y | Y | Y | Y |
| OpenHands Canvas | P | Y | Y | Y | Y | Y | N³ | N | N | N | N | P | N | P | Y | Y | Y |
| Devin | Y | Y | N | Y | Y | P | N⁴ | ? | ? | ? | ? | P | ? | Y | N | P | P |
| Cursor Cloud | P | Y | N | Y | Y | P | N⁴ | ? | ? | ? | ? | P | ? | Y | P⁵ | N | Y |
| GitHub Agent HQ | Y | Y | Y⁶ | Y | Y | Y | N³ | P⁷ | N | N | N | P | P | Y | P⁸ | N | Y |
| Omnara | Y | Y | Y | Y | Y | P | N | N | N | N | N | P | N | ? | Y | P | Y |
| Claude Code teams/cloud | N⁹ | Y | N | Y | Y | Y | N¹⁰ | N | N | N | N | P | N | P | N | P | Y |
| Codex app/cloud | P | Y | N | Y | Y | P | Y | N | N | N | N | P | ? | Y | N | P | Y |
| Amp Spaces | Y | Y | N | Y | Y | Y | N | ? | ? | ? | ? | P | ? | ? | P¹¹ | N | P |
| Container Use | N | Y | Y | Y | Y | N | Y | N | N | N | N | N | N | Y | Y | Y | Y |

¹ cloud team layer deleted at sunset. ² local worktrees; cloud Firecracker. ³ containers/Actions runners. ⁴ VM per session. ⁵ self-hosted worker pools. ⁶ Copilot + Claude + Codex (preview). ⁷ reactive git-conflict view in Copilot app, not cross-agent prediction. ⁸ self-hosted Actions runners only. ⁹ one user's sessions. ¹⁰ teammates share one directory. ¹¹ self-hosted orbs.

### 1.4 Market gaps (the product opportunity)

1. **Cross-developer coordination on one repo, local-first: nobody ships it.** Every team-capable product is cloud-locked (GitHub, Amp, Conductor) or single-provider. No product coordinates *different developers' independently run agents* (Claude Code + Codex + Cursor mixed) against a shared task/ownership model on self-hosted infra.
2. **Symbol/function-level conflict detection: no product.** All isolation is file-level; semantic collisions surface only at merge/CI. Exists only in research ([symbol-level locking paper](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=7357900), [AgenticFlict dataset](https://arxiv.org/html/2604.03551v1)).
3. **Independent validation: effectively nobody.** Everyone trusts agent-run tests or user-configured commands. No platform re-verifies agent claims in a neutral environment or maintains a health baseline.
4. **Failure attribution: nobody.** No product attributes a regression to the specific agent session/developer across concurrent workstreams.
5. **Live dependency/API-contract awareness between concurrent agents: nobody.**
6. **Structural gap:** healthy OSS bases are conversation/runtime-centric (OpenHands, Omnara); git-intelligence tools are single-developer-centric (VK, Paradev, Claude Squad). The intersection — team + git/code intelligence + verification, self-hosted — is empty.

---

## 2. Agent integration research

**Cross-cutting finding:** the market converged on a *Claude-Code-shaped* contract. Claude Code, Codex, Qoder, and Cursor all ship (a) lifecycle **hooks** with near-identical JSON (`session_id`, `transcript_path`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`; exit 0/2; `continue`/`decision`/`hookSpecificOutput`) and (b) headless `-p`/`exec` + `--output-format stream-json` NDJSON. One internal schema can be fed by native hooks for ~6 of 8 target agents.

| Agent | Lifecycle | Tool calls | File mods | Session ID | Completion | Error | Push vs poll | Fidelity |
|---|---|---|---|---|---|---|---|---|
| Claude Code | ~33 events incl. SessionStart/End, Stop, StopFailure, Subagent*, Task*, TeammateIdle | Pre/PostToolUse, PostToolUseFailure, PostToolBatch, PermissionRequest | **FileChanged** (fs-watcher, any writer), WorktreeCreate/Remove | `session_id` | Stop / SessionEnd | StopFailure, PostToolUseFailure | Push (hooks incl. **http + async**, OTLP, stream-json) | High |
| Codex CLI | SessionStart/End, Stop, Interrupt, Subagent*, Pre/PostModelRequest | Pre/PostToolUse, PermissionRequest | apply_patch hooks; `turn/diff/updated`, `fileChange` items | `thread_id`/`turn_id` | `turn.completed` | `turn.failed`, `error` | Push (hooks, app-server JSON-RPC, exec --json, notify) | High |
| OpenCode | session.execution.*, session.status/idle | session.tool.*, tool.execute.before/after | **filesystem.changed**, session diff API | `sessionID` | execution.succeeded | execution.failed, tool.failed | Push (SSE `/event`, plugin bus, SDK) | High |
| Qoder | Claude-compatible catalog | Pre/PostToolUse etc. | FileChanged | `session_id` | Stop | StopFailure | Push (hooks, SDK TS/Python/Java, stream-json) | High |
| Cursor | sessionStart/End, stop, subagent* | pre/postToolUse, shell/MCP execution hooks | **afterFileEdit** (`file_path`, `edits[]`) | `conversation_id` | stop(`status`) | postToolUseFailure, stop.status | Push (hooks, stream-json, Cloud API SSE/webhooks) | High |
| Cline | task.created/completed (OTel), SDK events | SDK content/tool events | via tool events | `sessionId` | SDK `done` | SDK `error` | Push (SDK, OTLP, CLI --json, ACP) | High (SDK) / Med (CLI) |
| Roo Code | — | — | — | — | — | — | **Discontinued May 2026 — no adapter** | N/A |
| Aider | none | none | git auto-commits + history files | none | process exit | exit code | Poll (history/analytics files, git) | Low |
| Generic CLI | none | none | fs watch + git | assigned | process exit / idle heuristic | exit code | Wrap (PTY) + poll | Low |

**Verification status (2026-11-07):** Claude Code hook catalog, Codex hooks, and Qoder hooks re-verified directly against primary docs this session (`learn.chatgpt.com` is the official Codex docs domain — permanent 308 redirect from `developers.openai.com/codex`). Cursor/Cline/OpenCode rows are cited from primary docs by the research workstream but are flagged for re-verification at adapter design freeze (risk T1). `git merge-tree --write-tree` verified on the installed git 2.53.

Key mechanisms and limits:
- **Claude Code**: `http` hooks POST JSON directly to a collector; `async:true` for non-blocking telemetry; hooks fire identically in terminal/IDE/desktop/cloud. OTLP env is stripped from subprocesses and cannot be enabled from repo settings (opt-in per developer). Transcript JSONL lags in-memory state. Agent teams don't spawn in `-p`/SDK mode. [hooks](https://code.claude.com/docs/en/hooks) *(verified)*, [monitoring](https://code.claude.com/docs/en/monitoring-usage), [Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview)
- **Codex**: hooks require trust review; app-server is experimental; `codex mcp-server` (server mode) **removed** — Codex is an MCP client only; transcript format explicitly unstable. [hooks](https://learn.chatgpt.com/docs/hooks), [app-server](https://learn.chatgpt.com/docs/app-server), [MCP removal](https://learn.chatgpt.com/docs/mcp-server)
- **OpenCode**: `opencode serve` headless HTTP (OpenAPI at `/doc`), SSE `/event` with durable envelope `{id, type, created, data, durable:{aggregateID, seq, version}}`; v2 plugin API broke v1 compatibility. [server](https://opencode.ai/docs/server/), [event schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/session-event.ts)
- **Cursor**: cloud agents run command hooks only; HTTP-MCP postToolUse output redacted in cloud. [hooks](https://cursor.com/docs/hooks)
- **MCP as coordination channel: proven pattern.** Precedent: [agent-coord](https://github.com/ThatHunky/agent-coord) — MCP server + PreToolUse hook giving any MCP agent shared file locks (glob), task claims, status broadcast; the hook *hard-blocks* edits to locked files. MCP clients: Claude/Codex/OpenCode/Qoder/Cursor/Cline all support stdio+HTTP. Claude Code additionally supports MCP **channels** (push messages into a session) — ideal for "another agent changed X" notifications. MCP tool calls are model-mediated/cooperative → pair with PreToolUse hooks for hard enforcement. [A2A](https://a2a-protocol.org/latest/specification/) (agent↔agent federation) deferred; [ACP](https://agentclientprotocol.com) (editor↔agent) relevant for launched-session support later.

---

## 3. Git coordination research

- **Worktrees**: one object DB, per-worktree HEAD/index; same branch can't be checked out twice; submodule support incomplete; `gc.worktreePruneExpire` can prune missing worktrees → lock long-lived agent worktrees. Git's lockfile protocol: writers mutually exclude, readers never block; SIGKILL leaves stale `.lock` files (daemon must detect/recover). Per-worktree indexes make parallel commit/status safe; serialize shared-ref ops (fetch/gc/same-branch updates). [git-worktree](https://git-scm.com/docs/git-worktree), [lockfile.h](https://github.com/git/git/blob/master/lockfile.h)
- **Conflict detection without checkout**: `git merge-tree --write-tree` (≥2.38, verified on 2.53) runs the ort merge in-core; exit 0 clean / 1 conflicts / >1 error; outputs tree OID + conflicted paths; resulting tree can be committed via `commit-tree` → full server-side merges with zero checkout. GitHub measured ort vs recursive: **P50 7.74ms vs 71.07ms; P99 329ms vs 1.63s**; fleet rebase 512h→33h. [docs](https://git-scm.com/docs/git-merge-tree), [GitHub engineering](https://github.blog/engineering/infrastructure/scaling-merge-ort-across-github/)
- **Textual ≠ semantic**: merge-tree reports textual conflicts only. "Both branches edited `foo()`" detection = `git diff -U0 base..branch` line ranges → map to enclosing symbols via tree-sitter → intersect symbol sets across branches. Clean merge + shared symbol = semantic-overlap warning tier.
- **Merge queues**: GitHub (test on temp merge refs against base + queued-ahead; `merge_group` CI event; eject-and-requeue), Graphite (stack-aware, speculative parallel CI, vendor 1.5–2.5× faster), Mergify (speculative checks), Aviator (monorepo/build-tool aware). Copy: speculative integration tree via merge-tree chains, batch disjoint-footprint tasks, test the exact merged tree, serialize final ref advance with CAS (`git update-ref <branch> <new> <old>`). [GitHub queue](https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue), [Graphite](https://graphite.com/docs/merge-queue-optimizations), [Mergify](https://mergify.com/learn/merge-queue/speculative-merging)
- **GitButler**: hunk→branch ownership with ordered line ranges tagged by commit/stack IDs; intersecting hunks create dependency edges; oplog undo. **FSL-1.1-MIT forbids competing use — study the model, do not copy code.** [hunk-dependency crate](https://github.com/gitbutlerapp/gitbutler/tree/master/crates/but-hunk-dependency), [license](https://github.com/gitbutlerapp/gitbutler/blob/master/LICENSE.md)
- **Git libraries**: nodegit effectively unmaintained (last release 2020); isomorphic-git volunteer-only, no worktrees; libgit2 lacks ort parity; gitoxide merge incomplete. **Recommendation: git CLI plumbing as system of record** (only option with merge-tree/rerere/worktree parity); gitoxide for hot reads only if a Rust component ever exists. [gitoxide status](https://github.com/GitoxideLabs/gitoxide/blob/main/crate-status.md), [nodegit](https://github.com/nodegit/nodegit/issues/2002)
- **Never lose uncommitted work**: auto-WIP commits to task branch or hidden `refs/wip/<task>` (durable, diffable, reflog-recoverable); reject stash as primary (shared `refs/stash` interleaves across worktrees); dir snapshots only as last resort. Jujutsu's working-copy-as-commit + oplog are the right ideas — steal ideas, defer jj as storage. [jj](https://docs.jj-vcs.dev/latest/working-copy/)

## 4. Code intelligence research

- **Tree-sitter**: incremental parsing, query-based symbol extraction; native node bindings for the daemon (WASM "considerably slower" per official README). Benchmark (500 files/75k LOC): ast-grep **43ms/11MB** vs semgrep 7,535ms/250MB vs jscodeshift 754ms/153MB. ast-grep's 2026 Rust tree-sitter rewrite (+29.7% parser throughput) **dropped incremental parsing** for snapshot analysis — evidence that fresh full-file parses are cheap for daemons; incremental parse matters for editors, not indexers. [benchmark](https://github.com/codemod/benchmark), [ast-grep blog](https://ast-grep.github.io/blog/tree-sitter-rust-rewrite)
- **Cross-file references**: GitHub stack-graphs = best incremental architecture (per-file partial graphs, cheap stitching) but **officially unsupported/unmaintained** — reference only. SCIP: 8× smaller/3× faster than LSIF; scip-typescript indexes 1k–5k LOC/s (typechecker-bound). LSP servers: precise on-demand references; gopls typed ASTs ≈30× source size, v0.12 cut memory ~75% — run **one server per repo, never per worktree**. TS Compiler API `findAllReferences` = precise in-process TS resolution. [stack-graphs paper](https://arxiv.org/abs/2211.01224), [SCIP](https://sourcegraph.com/blog/announcing-scip), [scip-typescript](https://sourcegraph.com/blog/announcing-scip-typescript), [gopls](https://go.dev/blog/gopls-scalability)
- **Incremental indexing**: git diff is the authoritative change source (already needed for coordination); re-parse only changed files; content-hash-keyed SQLite symbol store; invalidate reference edges lazily for changed exported symbols (gopls export-summary pruning pattern).
- **Test impact analysis**: Jest `--findRelatedTests` (static, file-level, no dynamic requires), Nx affected (over-approximates via shared deps), Bazel rdeps (precise, requires Bazel), pytest-testmon (coverage-based; blind to config/data deps). Keep periodic full-suite runs as safety net. [Jest](https://jestjs.io/docs/cli), [Nx](https://nx.dev/docs/features/ci-features/affected), [testmon](https://www.testmon.org/)
- **Contract/migration gates**: oasdiff (Apache-2.0, 778 breaking-change rules), buf breaking (Apache-2.0), graphql-inspector (license UNKNOWN), squawk (Apache-2.0 Postgres migration lint), prisma migrate diff (Apache-2.0). **Atlas migrate lint reportedly paywalled in 2026 — avoid.** [oasdiff](https://www.oasdiff.com/docs/breaking-changes), [squawk](https://github.com/sbdchd/squawk), [Atlas report](https://dev.to/mickelsamuel/atlas-paywalled-their-migration-linter-here-are-your-free-alternatives-4god)
- **Licensing traps**: CodeQL engine cannot scan private code in a commercial product without GitHub Code Security ([terms](https://github.com/github/codeql-cli-binaries/blob/main/LICENSE.md)); Semgrep registry rules are internal-use-only ([license](https://semgrep.dev/legal/rules-license/)); GitButler FSL competing-use clause; Atlas lint. Safe: tree-sitter/ast-grep/dependency-cruiser/madge/Jest/Nx MIT; oasdiff/buf/squawk/prisma Apache-2.0.
- **Fidelity ladder** (effort estimates): L0 file-level (worktrees + merge-tree gate + queue + auto-WIP + Jest related-tests) 1–2 wk → L1 symbol-level (tree-sitter signatures, hunk→symbol overlap, module graph) +2–4 wk → L2 reference-level (Compiler-API/LSP call sites, contract gates, coverage mapping) +4–8 wk → L3 full semantic (stack-graphs-style) — research-grade, defer.

## 5. Infrastructure research

Scale reality check: 5–20 devs, dozens of sessions, bursts of hundreds of events/sec ≈ **<1 MB/s ingest** — 100–1000× headroom in every candidate technology. Design goal: minimize operational surface.

- **Transport**: SSE for server→client streams (free `Last-Event-ID` resume = SQL cursor catch-up; heartbeats; HTTP/2 multiplexing avoids the 6-connection cap) + plain POST for RPC. WebSocket justified only for high-rate client mutation (Linear/Liveblocks pattern) — not our case. WebTransport: fresh Baseline, HTTP/3 infra, no resume — reject. [SSE spec](https://html.spec.whatwg.org/multipage/server-sent-events.html), [Vercel AI SDK SSE](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol), [Linear sync](https://linear.app/now/scaling-the-linear-sync-engine)
- **Storage**: SQLite WAL locally (batched transactions; official: 35% faster reads than files for 10KB blobs; <100K hits/day guidance with 10× demonstrated); Postgres centrally (monthly range partitions; `DETACH/DROP PARTITION` retention; LISTEN/NOTIFY <8000 bytes as wake-up signal only). Kafka/Redis/NATS rejected at this scale (each is an extra daemon + failure mode for zero benefit). [SQLite WAL](https://www.sqlite.org/wal.html), [fasterthanfs](https://www.sqlite.org/fasterthanfs.html), [NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html), [partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html)
- **Runtime**: Node LTS + Fastify + better-sqlite3 for both daemon and server (one codebase, one language; Fastify official benchmark ~89.7K req/s illustrative; `node:sqlite` still RC → better-sqlite3). Bun's 3–6× sqlite claim is vendor-disputed; Windows long-running-daemon maturity unproven. Go/Rust rejected on velocity; revisit Go only if single-binary distribution becomes a hard requirement. Node 26 is active LTS (2026-10-28); 24 maintenance LTS. [Fastify benchmarks](https://fastify.dev/benchmarks/), [Node releases](https://nodejs.org/en/about/previous-releases), [better-sqlite3](https://www.npmjs.com/package/better-sqlite3), [Bun dispute](https://github.com/oven-sh/bun/issues/4776)
- **FS watching**: @parcel/watcher (native FSEvents/ReadDirectoryChangesW/inotify, coalescing). Windows `ERROR_NOTIFY_ENUM_DIR` discards the buffer → **watcher events are hints; `git status` is truth**; rescan on overflow/restart. Git complements: `core.fsmonitor` (Linux since git 2.55), `core.untrackedCache`, `feature.manyFiles` — Chromium 393K-file `git status` **17.9s → ~0.8s**. [watcher](https://github.com/parcel-bundler/watcher), [MS docs](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-readdirectorychangesw), [GitHub fsmonitor](https://github.blog/engineering/infrastructure/improve-git-monorepo-performance-with-a-file-system-monitor/)
- **Validation execution**: direct child processes in dedicated worktrees locally (timeouts, semaphore ≈cores−1, scrubbed env); Docker per validation on Linux servers; Firecracker Linux/KVM-only — future hosted option, reject for team server. Cross-platform native resource limits are weak (UNKNOWN/limited) → timeouts + caps. Turborepo/Nx hash-keyed cache concepts without requiring adoption. [Firecracker](https://firecracker-microvm.github.io/), [Turborepo cache](https://turborepo.dev/docs/core-concepts/remote-caching)
- **Security**: redact at ingest before persist/broadcast (gitleaks-style regex + entropy; TruffleHog live verification is offline-only); OS keychain via @napi-rs/keyring (keytar unmaintained since 2022); project-scoped tokens + RBAC + append-only audit; **metadata-only sync by default** (paths, hashes, durations, exit codes, signatures — no source blobs/full diffs unless enabled). [gitleaks](https://github.com/gitleaks/gitleaks), [keyring](https://github.com/Brooooooklyn/keyring-node)
- **Sync**: transactional outbox + idempotency keys + `(device_id, event_id)` dedup + cursor catch-up (one mechanism powers SSE resume and daemon catch-up). CRDTs solve concurrent rich-text editing — overkill for append-only events + versioned task state. Electric read-path-only; PowerSync closest off-the-shelf but adds a service — hand-rolled outbox is smaller. [outbox](https://microservices.io/patterns/data/transactional-outbox.html), [Stripe idempotency](https://stripe.com/blog/idempotency), [Automerge overhead](https://automerge.org/blog/automerge-2/)

## 6. UI/UX research

- **Claude Code**: approval fatigue is the design enemy; permission = preview + scoped choices + Tab-to-steer-while-approving; subagents return summaries not transcripts; `/recap` ≤400-char summaries; queued input rendered muted; Esc interrupts without submitting. [permissions](https://code.claude.com/docs/en/permissions), [interactive mode](https://code.claude.com/docs/en/interactive-mode), [auto mode](https://www.anthropic.com/research/claude-code-auto-mode)
- **Linear**: "don't compete for attention you haven't earned" (dimmed sidebar, compact tabs); warmer desaturated grays; keyboard-first (`/` search, `G`+key nav, triage exits 1/2/3/H); per-property observables + IndexedDB-local UI database; **one delta = one cell re-render**; ⌘K searches the local pool; render-first/auth-second; pre-paint theme restore; motion: enter 0ms / exit 150ms, transform/opacity only, no row transitions. [design refresh](https://linear.app/now/behind-the-latest-design-refresh), [technical breakdown](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown), [triage](https://linear.app/docs/triage)
- **Cursor**: agent-centered (not file-centered) layout; per-hunk Keep/Undo adjudication; checkpoints restore files only, never conversation. [2.0](https://cursor.com/blog/2-0), [checkpoints](https://cursor.com/docs/agent/chat/checkpoints)
- **GitHub**: Files Changed rebuild — virtualization to 3,000 files, split↔unified without reload, collapsible annotations, `a` hides annotations; Inbox/Saved/Done triage. [discussion](https://github.com/orgs/community/discussions/163932), [inbox](https://docs.github.com/en/subscriptions-and-notifications/how-tos/viewing-and-triaging-notifications/managing-notifications-from-your-inbox)
- **Stream patterns**: actor+window run grouping ("made 3 changes" disclosure), unread divider inside the timeline, pause-on-scroll + jump-to-latest, prepend stability with skeletons, static play marks in history (spinners only on live status), diff folding >6 unchanged lines, >200KB line-only / >1MB refuse. [VegaStack activity feed](https://design.vegastack.com/docs/components/activity-feed), [diff view](https://design.vegastack.com/docs/components/diff-view), [Grafana live tail](https://grafana.com/docs/grafana-cloud/learn-and-build/visualizations/explore/logs-integration/)
- **Stack evidence**: React 19 CSR (Linear's choice; ecosystem gravity) + Zustand (491B gzip, per-row selectors) + TanStack Query (13.3KB gzip, keep the hot log OUT of it) + react-virtuoso (19.7KB gzip, built-in followOutput/prepend semantics) + cmdk (16.7KB gzip) + Tailwind v4 (zero runtime JS) + Radix. Monaco = 3.02MB gzip → escape hatch only; jsdiff + custom virtualized rows lazy-loaded. Primer dark tokens as the base (4.5:1 text contrast, semantic tokens, density axis). [Bundlephobia](https://bundlephobia.com), [Primer tokens](https://github.com/primer/primitives/blob/main/DESIGN_TOKENS_GUIDE.md), [Tailwind v4](https://tailwindcss.com/blog/tailwindcss-v4)
- **IA correction to the brief**: nine flat nav items violates Linear's hierarchy principle. Land on **Inbox/Triage** ("what needs a human now"); Projects becomes a scope dimension; Conflicts becomes a saved filter of Changes + resolution workspace; Settings behind ⌘K. Central workspace = stream + inline adjudication (diffs/checks/approvals as expandable rows), not chat-only.

## 7. Reuse / build / avoid decisions

| Reuse (component or pattern) | Source | License |
|---|---|---|
| Executor adapter patterns (stream-json normalization), worktree lifecycle | Vibe Kanban crates | Apache-2.0 |
| Append-only event-stream architecture reference | OpenHands SDK | MIT |
| ACP for future launched-session support | Zed ACP | Apache-2.0 |
| MCP coordination + PreToolUse hard-lock hybrid pattern | agent-coord | OSS |
| Git-native task storage pattern | Backlog.md | MIT |
| Hunk-ownership + oplog *model* (not code) | GitButler | FSL — study only |
| ort merge-tree, CAS refs, auto-WIP | git itself | GPL (usage, not linking) |
| Symbol extraction | tree-sitter (+ ast-grep for structural search) | MIT |
| Contract gates | oasdiff / buf / squawk / prisma diff | Apache-2.0 |
| UI primitives / tokens | Radix, cmdk, Primer token methodology | MIT / MIT / MIT |

**Avoid**: CodeQL engine, Semgrep registry rules, GitButler code, Atlas lint, nodegit, isomorphic-git, stack-graphs as dependency, Kafka/Redis/NATS at this scale, CRDTs, WebTransport, microservices, Docker/Firecracker on dev machines, Monaco in the initial bundle.

**Build ourselves** (the actual product): cross-developer task/ownership coordination, symbol-level conflict engine, independent validation + health baseline, failure attribution, merge queue, event protocol + adapters, the UI.

## 8. Verdict — extend vs build

**Do not fork a full product.** The differentiators exist in no product, so no fork shortcuts them; the commodity layers are permissively licensed and liftable. VK's architecture inherits a deliberate retreat to single-user; OpenHands' conversation-centric model would require fighting its abstractions for ~70% of the differentiator. **Build the coordination/verification core new; aggressively reuse OSS components; integrate agents via native hooks + MCP (+ ACP later).** Position against GitHub Agent HQ (validates the category, cloud-locked) into the gap left by VK/Terragon/Jules exits. Speed matters: platform gravity (GitHub/Anthropic/OpenAI absorbing orchestration) is the main strategic risk.