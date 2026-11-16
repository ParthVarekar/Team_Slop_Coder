# Weft — Event Protocol v1

**Date:** 2026-11-07 · The normalized contract every adapter translates into. Spine field names follow the de-facto Claude Code hook shape (`session_id`, `tool_name`, `tool_input`, `cwd`) to minimize adapter translation loss.

## 1. Envelope

```json
{
  "v": 1,
  "event_id": "01J9ZK4M7NQ8R3XW5V2B6C8D9E",
  "device_id": "dev_01J9ZJXY0A4B7C8D9E0F1G2H3",
  "project_id": "proj_01J9ZJQX8B2C4D6E8F0G1H2J3",
  "repo_id": "repo_01J9ZJRV9C3D5E7F9G0H1J2K3",
  "session_id": "ses_01J9ZK0P5E8F0G2H4J6K8M0N1",
  "provider_session_id": "abc123-claude-native",
  "task_id": "task_01J9ZJZT6D4E6F8G0H2J4K6M8",
  "seq": 42,
  "ts": "2026-11-07T21:30:00.123Z",
  "type": "tool.post",
  "actor": {
    "user_id": "user_01J9ZJPM3A6B8C0D2E4F6G8H0",
    "agent": { "provider": "claude-code", "model": "claude-opus-4-6", "adapter": "hooks@1.4.0" }
  },
  "privacy": "metadata",
  "payload": { }
}
```

| Field | Required | Rules |
|---|---|---|
| v | yes | Protocol version; server rejects unknown major versions with upgrade hint |
| event_id | yes | ULID, client-generated; dedup key with device_id |
| device_id | yes | Registered device keypair identity |
| project_id / repo_id | yes / no | Repo-less events (project-level task ops) omit repo_id |
| session_id | no | Platform session ULID; mapping to provider_session_id established by session.started |
| provider_session_id | no | Native id (Claude session_id, Codex thread_id, OpenCode sessionID, Cursor conversation_id) |
| task_id | no | Attached when known (MCP claim, branch trailer, workspace binding) |
| seq | yes (session events) | Monotonic per (device, session); gaps detect loss |
| ts | yes | Client UTC; server records received_at separately (clock skew tolerated) |
| type | yes | Catalog below; unknown types stored as `unknown` payload, never rejected (forward compatibility) |
| actor | yes | Human + agent provenance; system events use `{"system":"daemon"}` |
| privacy | yes | `metadata` (default) or `full`; server enforces project sync_scope ceiling |
| payload | yes | Type-specific; all string content redacted before emission |

Server adds: `global_seq` (per-project monotonic), `received_at`. Server never mutates client fields.

## 2. Event catalog

### Session lifecycle
| Type | Payload essentials | Emitted by |
|---|---|---|
| session.started | cwd, workspace_id?, model, prompt_summary?, provider_version, fidelity | All adapters |
| session.status | status(running\|idle\|waiting_permission), detail? | Hook/heartbeat |
| session.ended | reason(completed\|failed\|interrupted\|crashed), duration_ms, tool_counts, files_touched_count | Stop/SessionEnd/process-exit |
| prompt.submitted | prompt_summary (redacted, ≤400 chars), prompt_hash | UserPromptSubmit |

### Tool and command activity
| Type | Payload essentials |
|---|---|
| tool.pre | tool_name, tool_input_summary (redacted; full input only in `full` mode), tool_use_id, reservation_check(pass\|blocked\|warn)? |
| tool.post | tool_name, tool_use_id, duration_ms, success, output_digest, output_excerpt (capped 2KB, redacted) |
| tool.failed | tool_name, tool_use_id, error_class, error_excerpt (redacted) |
| command.executed | command_display (redacted), exit_code?, duration_ms?, cwd — derived from Bash/shell tool events; exit code joined from tool.post |

### File and symbol activity
| Type | Payload essentials |
|---|---|
| file.changed | path, change_kind, old_hash?, new_hash?, lines_added?, lines_removed?, source(agent_tool\|watcher\|git) |
| symbols.changed | path, symbols[{name, kind, change_kind, old_signature?, new_signature?}], content_hash |
| commit.created | oid, branch, parents[], message_summary, files_changed_count, task_trailer? |
| branch.created / branch.updated | name, head_oid, task_id?, kind |
| worktree.created / worktree.removed | path (device-local), branch, task_id |

### Coordination (durable — stored in coordination_events, never expire)
| Type | Payload essentials |
|---|---|
| task.created / updated / assigned | version, changed_fields (field-level merge), task snapshot digest |
| task.claimed / released | version, claimant(user+agent), provisional(bool, offline) |
| task.claim_rejected | version, winner_claimant, reason — server-emitted; losing daemon discards its untouched quarantine and notifies |
| task.state_changed | from, to, version, reason? — state machine enforced server-side |
| task.progress | summary (≤400 chars, wrapped as untrusted data), percent?, evidence_refs[] |
| task.completion_claimed | claim_text, evidence_state=unverified — never transitions state alone |
| task.commented / task.handed_off | author + provenance, body / deterministic handoff_bundle |
| reservation.acquired / renewed / released / denied | path_glob, mode, expires_at, grace_until, holder_task_id |
| conflict.detected / resolved / dismissed | canonical_key (kind + sorted task_ids + normalized paths/symbols; **server mints conflict_id** on ingest), evidence (append-only union), detection_epoch |
| merge.queued / testing / merged / ejected | entry_id, position, base_oid, tree_oid?, executor_device_id, lease_epoch, reason? |
| summary.compacted | range [seq_start, seq_end], dropped_types, reason — tombstone marking intentionally compacted telemetry |

### Verification and health
| Type | Payload essentials |
|---|---|
| validation.started | run_id, trigger, candidate_oid, checks[], selection(full\|affected) |
| check.completed | run_id, check_id, exit_code, duration_ms, log_digest, newly_failing? |
| validation.completed | run_id, state(passed\|failed\|error), input_hash, cache_hit |
| health.baseline_established | branch, commit_oid, checks_summary |
| health.regression | baseline_id, failure_fingerprint, suspected_changes[] |
| notification.created | kind, subject, target_user_id |

## 3. Ordering, idempotency, dedup

- **Ordering**: per-session `seq` is the causal order; project stream orders by server `global_seq`. Cross-session ordering is arrival order — the UI never implies cross-session causality it can't prove.
- **Delivery**: at-least-once. Ingest dedups on `(device_id, event_id, received_at)` (partition-key-safe) with replay-safe upsert; replays are safe. Server ack = last durable global_seq; shipper advances outbox cursor only on ack.
- **Gap detection**: consumer tracks per-session seq; a gap triggers `GET /sessions/{id}/events?after=seq` catch-up. Compacted ranges return `summary.compacted` tombstones (explicit "history was compacted", never silent absence). Project streams expose a `min_seq` watermark; cursor < watermark → full resync of current state + retained history.
- **Actor semantics**: agent-tool events carry `{user_id, agent}`; watcher/git-sourced human edits carry `{user_id: device owner, agent: null}` — the UI always distinguishes human from agent activity.
- **Clock skew**: display uses client ts; ordering and partitioning never use client ts (server received_at). Skew > 5 min flagged in the session inspector.

## 4. Offline buffering and retry

1. Hook/adapter emits → redact → single SQLite transaction writes `events` + `outbox` rows (batched ≤100 events or ≤50ms).
2. Shipper POSTs `/v1/ingest` batches (≤500 events, ≤256KB, gzip) with `Idempotency-Key: {device_id}:{batch_first_event_id}` and device signature.
3. On failure: exponential backoff (1s→60s cap, jitter); outbox persists across restarts.
4. **Bounded outbox** (default 500MB): compaction drops oldest *telemetry* (tool.post/file.changed) first, replacing ranges with `summary.compacted` tombstones; coordination events (task ops, claims, validation evidence, commits) are **never dropped** — they spill to a capped overflow segment (default 100MB); at the cap the daemon applies explicit backpressure (pauses new session registration, alerts loudly) rather than growing unbounded or losing coordination data.
5. Reconnect: ship outbox, then cursor catch-up `GET /v1/events?after={global_seq}` for server-side changes (tasks, reservations, conflicts from other developers).

## 5. Versioning and evolution

- `v` = major; additive payload fields are minor (consumers ignore unknown fields). Unknown event **types** are stored, not rejected.
- Adapter capability manifest (`agent_providers.capability_manifest`) declares emitted types + fidelity; UI labels partial telemetry ("file events only — no tool calls").
- Breaking changes require v+1 with server-side upcasters for one deprecation cycle.

## 6. Failure recovery

| Failure | Recovery |
|---|---|
| Daemon crash mid-batch | SQLite txn atomicity: no partial batches; outbox replays on boot; dedup makes replays safe |
| Agent killed (SIGKILL) | session.ended(reason=crashed) inferred by daemon heartbeat loss; auto-WIP ref preserves work; stale git locks detected/cleared on next op |
| Server down | Daemons buffer (above); local UI fully functional; claims provisional |
| Hook receiver overwhelmed | Bounded queue; telemetry coalesces to summaries (labeled); hooks return immediately (async) — agent never blocked |
| Redaction uncertainty | Fail closed: unknown high-entropy tokens replaced; false-positive rate tracked in metrics |
| Protocol mismatch | Server rejects unknown major v with upgrade hint; daemon surfaces "update required" notification |

## 7. Realistic payload examples

**Claude Code PostToolUse → tool.post** (Edit tool):
```json
{
  "v": 1, "type": "tool.post", "seq": 43,
  "event_id": "01J9ZK4M7NQ8R3XW5V2B6C8D9F",
  "device_id": "dev_01J9ZJXY0A4B7C8D9E0F1G2H3",
  "project_id": "proj_01J9ZJQX8B2C4D6E8F0G1H2J3",
  "repo_id": "repo_01J9ZJRV9C3D5E7F9G0H1J2K3",
  "session_id": "ses_01J9ZK0P5E8F0G2H4J6K8M0N1",
  "provider_session_id": "abc123-claude-native",
  "task_id": "task_01J9ZJZT6D4E6F8G0H2J4K6M8",
  "ts": "2026-11-07T21:30:00.456Z",
  "actor": {"user_id": "user_01J9ZJPM3A6B8C0D2E4F6G8H0",
            "agent": {"provider": "claude-code", "model": "claude-opus-4-6", "adapter": "hooks@1.4.0"}},
  "privacy": "metadata",
  "payload": {"tool_name": "Edit", "tool_use_id": "toolu_01ABC",
              "duration_ms": 12, "success": true,
              "output_digest": "sha256:9f2c…", "output_excerpt": "The file src/auth/token.ts has been updated."}
}
```

**Derived symbols.changed** (daemon indexer, same session):
```json
{
  "v": 1, "type": "symbols.changed", "seq": 44,
  "event_id": "01J9ZK4M7NQ8R3XW5V2B6C8D9G",
  "device_id": "dev_01J9ZJXY0A4B7C8D9E0F1G2H3",
  "project_id": "proj_01J9ZJQX8B2C4D6E8F0G1H2J3",
  "repo_id": "repo_01J9ZJRV9C3D5E7F9G0H1J2K3",
  "session_id": "ses_01J9ZK0P5E8F0G2H4J6K8M0N1",
  "task_id": "task_01J9ZJZT6D4E6F8G0H2J4K6M8",
  "ts": "2026-11-07T21:30:00.789Z",
  "actor": {"system": "daemon-indexer"},
  "privacy": "metadata",
  "payload": {"path": "src/auth/token.ts", "content_hash": "sha256:7ab1…",
              "symbols": [{"name": "getUserById", "kind": "function", "change_kind": "signature",
                           "old_signature": "(id: string) => User",
                           "new_signature": "(id: string) => User | null"}]}
}
```

**OpenCode session.tool.called → tool.pre** (adapter translation):
```json
{
  "v": 1, "type": "tool.pre", "seq": 7,
  "event_id": "01J9ZK5N8PR9S4YX6W3C7D9E0F",
  "device_id": "dev_01J9ZJXY0A4B7C8D9E0F1G2H4",
  "project_id": "proj_01J9ZJQX8B2C4D6E8F0G1H2J3",
  "repo_id": "repo_01J9ZJRV9C3D5E7F9G0H1J2K3",
  "session_id": "ses_01J9ZK2Q6F9G1H3J5L7M9N1P2",
  "provider_session_id": "ses_opencode_7f3a",
  "ts": "2026-11-07T21:31:10.001Z",
  "actor": {"user_id": "user_01J9ZJPN4B7C9D1E3F5G7H9J1",
            "agent": {"provider": "opencode", "model": "anthropic/claude-sonnet-4-5", "adapter": "sse@1.1.0"}},
  "privacy": "metadata",
  "payload": {"tool_name": "edit", "tool_use_id": "tool_1",
              "tool_input_summary": {"filePath": "src/dashboard/UserCard.tsx"},
              "reservation_check": "warn"}
}
```

**validation.completed** (evidence):
```json
{
  "v": 1, "type": "validation.completed", "seq": 120,
  "event_id": "01J9ZK6P9QS0T5ZY7X4D8E0F1G",
  "device_id": "dev_01J9ZJXY0A4B7C8D9E0F1G2H3",
  "project_id": "proj_01J9ZJQX8B2C4D6E8F0G1H2J3",
  "repo_id": "repo_01J9ZJRV9C3D5E7F9G0H1J2K3",
  "task_id": "task_01J9ZJZT6D4E6F8G0H2J4K6M8",
  "ts": "2026-11-07T21:35:42.100Z",
  "actor": {"system": "daemon-validator"},
  "privacy": "metadata",
  "payload": {"run_id": "val_01J9ZK6J2H4G6F8D0S2A4Q6W8",
              "state": "passed", "candidate_oid": "a1b2c3d…",
              "input_hash": "sha256:5ef0…", "cache_hit": false,
              "checks": [{"check_id": "typecheck", "exit_code": 0, "duration_ms": 4210},
                         {"check_id": "unit", "exit_code": 0, "duration_ms": 18340, "selection": "affected"}]}
}
```

## 8. Transport summary

| Hop | Mechanism | Bounds |
|---|---|---|
| Agent → daemon (telemetry) | localhost HTTP hook (**async**), SSE client, stdio stream | ≤5ms p50; never blocks the agent |
| Agent → daemon (enforcement) | PreToolUse hook (**sync**, reservation check) | p99 ≤50ms local; hard mode fails closed on stale copy, soft fails open |
| Daemon internal | bounded in-process queue → SQLite txn | ≤100 events / ≤50ms batch |
| Daemon → server | HTTPS POST batch, gzip, idempotent, signed | ≤500 events / ≤256KB; backoff 1–60s |
| **Server → daemon** | device-authenticated SSE (coordination events: task/reservation/conflict/merge), Last-Event-ID resume | propagation ≤1s p95; keeps enforcement copies fresh |
| Server → UI | SSE, 50–100ms batched flush, heartbeat 15s, Last-Event-ID resume | per-project stream; backpressure via drain |
| Daemon → UI (local) | SSE, same protocol | works offline |

Hook receiver authentication: per-device rotatable bearer secret (user-level hook config) or local IPC with peer-credential checks where available; same-user read access is a documented residual risk (team-mode evidence weight comes from cross-device validation).