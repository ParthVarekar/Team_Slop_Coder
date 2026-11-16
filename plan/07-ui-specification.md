# Weft — UI Specification

**Date:** 2026-11-07 · Direction: Claude Code interaction philosophy + Linear restraint + Cursor adjudication + GitHub review patterns. Minimal, fast, information-dense, keyboard-first, dark-theme excellence. No card grids, no decorative gradients/shadows/animation.

## 1. Information architecture

Research correction to the brief's nine-item flat nav: **Inbox/Triage is the landing view** ("what needs a human now"); Projects is a scope dimension, not a destination; Conflicts is a saved filter of Changes + a resolution workspace; Settings lives behind ⌘K.

```
┌─ scope rail (56px) ─┬─ list pane (280–320px) ─┬─ workspace (flex) ────────┬─ inspector (0–380px) ─┐
│ team/repo switcher  │ Inbox (badge)           │ conversation stream       │ selection-driven:     │
│ ⌘K search           │ Sessions                │  ├ developer turn         │ file → diff           │
│ Inbox               │ Tasks                   │  ├ agent run group        │ check → logs          │
│ Sessions            │ Changes                 │  ├ inline diff row        │ session → detail      │
│ Tasks               │ Validation              │  ├ approval card          │ task → metadata       │
│ Changes             │ ──────────              │  ├ conflict card          │ conflict → both sides │
│ Validation          │ saved filters           │  └ status line            │                       │
│ ⋯ (Projects,        │                         │ composer (sticky)         │                       │
│    Settings)        │                         │                           │                       │
└─────────────────────┴─────────────────────────┴───────────────────────────┴───────────────────────┘
```

- Rail: icon-only, dimmed "a few notches" (Linear: don't compete for attention you haven't earned); collapsible to zero.
- List pane: dense rows (28–32px), never cards; per-view filters; collapsible.
- Workspace: **stream + inline adjudication** — diffs, checks, approvals are expandable rows in the stream, not separate screens (Cursor 2.0 lesson: agent-centered, not file-centered).
- Inspector: contextual, default-closed below 1440px; opens with origin-referencing motion.

## 2. Screens

| Screen | Content | Key behaviors |
|---|---|---|
| **Inbox** (default) | **Platform approvals** (merge admission, reservation overrides, task transitions), failures, conflicts, mentions; agent permission-requests/questions shown as *informational* in observe mode; Inbox/Saved/Done | Triage exits: `1` accept, `2` decline, `3` snooze; auto-advance; bulk select |
| **Sessions** | Active/historical sessions: agent-for-developer naming ("Claude Code for Priya"), state, task, duration, files touched | Live status line only; history rows static; open → session timeline |
| **Session timeline** | Grouped activity stream for one session; prompt turns; tool groups; diffs; validation evidence | `{`/`}` jump between turns; expand groups to raw evidence |
| **Tasks** | Dense list: state, priority, assignee, deps, branch; board view optional, never default | Quick assign (`A`), state transitions via palette; dependency chips |
| **Task detail** (workspace) | Description, acceptance criteria, stream of task-scoped activity, evidence, discussion/handoffs | Claim, start worktree, request validation — all inline |
| **Changes** | File tree (resizable) + unified/split diff; per-hunk Keep/Undo where actionable; conflict filter saved view | Virtualized to 3k files; `a` toggles annotations; split↔unified without reload |
| **Conflict resolution** | Both sides + base, symbol overlap evidence, affected tasks/call sites, resolution actions | Never auto-applies; every resolution is an explicit, audited action |
| **Validation** | Checks matrix: required vs optional × candidate vs merged tree; run history; baseline health | Expand check → redacted logs, exit code, duration, artifacts |
| **Dependency explorer** (P2) | Module/symbol graph around selection; impact list | Lazy-loaded chunk; canvas/SVG, virtualized labels |
| **Settings** | Project sync scope, retention, validation commands, adapters, tokens, members | Behind ⌘K / `⌘,`; never a rail icon |

## 3. Component hierarchy (selected)

```
AppShell
├── ScopeRail (TeamRepoSwitcher, NavList, PaletteTrigger)
├── ListPane (view-specific: InboxList, SessionList, TaskList, ChangesTree, ChecksMatrix)
├── Workspace
│   ├── ActivityStream (Virtuoso)
│   │   ├── StreamGroup (actor+module+window coalescing, "made 3 changes" disclosure)
│   │   │   ├── EventRow (icon 14px, actor, sentence w/ inline values, relative time)
│   │   │   ├── InlineDiffRow (collapsed +42 −7 → expand virtualized hunks)
│   │   │   ├── ApprovalCard (platform actions; preview + Yes / Yes-for-scope / No + Tab-to-comment)
│   │   │   ├── ConflictCard (tier, evidence, actions)
│   │   │   └── StatusLine (borderless, role=status; spinner only here)
│   │   ├── UnreadDivider (in-timeline, ack on half-visible)
│   │   └── JumpToLatest (floating, off-screen+scrolling only)
│   └── Composer (task discussion; agent input only for launched sessions, P2)
├── Inspector (FileDiff, CheckDetail, SessionDetail, TaskMeta, ConflictSides)
└── CommandPalette (cmdk; local-store search; nav=search=create=action)
```

## 4. Interaction patterns

**Control-scope rule (honesty):** in observe mode the platform *watches* sessions running in the developer's own terminal/IDE — it cannot approve their permission prompts, interrupt them, or steer them. Approval cards therefore act on **platform actions only** (merge admission, reservation overrides, task transitions). Agent steering/interrupt/permission control is offered **only for launched sessions** (P2, via SDK/ACP) and is visibly labeled as such; agent permission requests in observe mode render as informational notifications linking to the session, never as actionable buttons the backend can't honor.

| Pattern | Spec |
|---|---|
| Stream grouping | Same actor + module within 10-min window → one group; broken by comment/day/unread line; `summarizeAt=3` → "made 3 changes"; deterministic templates ("modified 8 files in auth; 3 functions changed; 1 API contract possibly affected") |
| Live vs history | Spinner only on the live status line; history rows use static marks — a history line never spins |
| Pause-on-scroll | Scrolling up pauses follow; Jump-to-latest appears only while boundary off-screen AND scrolling; fades 1.5s after settle; focus transfers on arrival |
| Prepend stability | Older pages preserve visible row; skeletons hold height; stable ids survive regrouping |
| Approval (platform actions) | Preview of exact action; Yes / Yes-don't-ask-again-for-this-scope / No; **Tab opens a comment**; one-time-only when scope can't be shown (Claude Code pattern). Agent permission prompts: informational only in observe mode |
| Inline diff | Collapsed row `auth/token.ts +42 −7`; expand → word-level `<ins>`/`<del>`; unchanged runs >6 lines fold; >200KB line-only; >1MB refuse with "open raw" |
| Diff adjudication | Per-hunk Keep/Undo + Keep All/Undo All (Cursor); never a single global yes/no |
| Checkpoints | Timeline node per run; restore **files only**, never conversation; confirm scope |
| Agent naming | Agent-first: "Claude Code for Priya"; no "AI" badge; provenance always visible |
| Composer | Observe mode: task discussion (posts `task.commented`, human-authored). Launched sessions (P2): agent input with muted queued render, Ctrl+Enter sends now, Esc interrupts without submitting draft |
| Unverified claims | Completion claims show evidence state chip: unverified / pending / passed / failed / human-required — visually distinct from verified completion |
| Motion | Enter 0ms, exit 150ms; transform/opacity only; **no list-row transitions**; origin-referencing (popover scales from its pill); honor prefers-reduced-motion |

## 5. Keyboard map

| Keys | Action |
|---|---|
| ⌘K / `/` | Command palette / search (local store) |
| G then I/S/T/C/V | Go: Inbox / Sessions / Tasks / Changes / Validation |
| J/K | Next/prev row |
| { / } | Jump between developer turns in stream |
| X, Shift+↑/↓, ⌘A, Esc | Select / range / all / clear |
| 1 / 2 / 3 | Triage: accept / decline / snooze |
| A | Assign focused task |
| E | Expand/collapse focused group |
| Ctrl+O-equivalent (`V`) | Verbose transcript toggle |
| Tab (in approval) | Add a comment |
| Shift+Tab | Cycle permission mode — **launched sessions only (P2)**; hidden in observe mode |
| ? | Shortcut overlay |
| ⌘, | Settings |

## 6. Search

Palette searches the **local normalized store** (sessions, tasks, files, symbols, checks) — zero network for navigation. Server search endpoint for history beyond the local window (keyset-paginated, redacted snippets only). Filters: developer, agent/provider, task, module, severity, time range — composable, saved as views.

## 7. Design tokens (dark-first, Primer-derived)

| Token | Value | Role |
|---|---|---|
| canvas.default | #0D1117 | page |
| canvas.muted | #151B23 | list pane, wells, grouped rows |
| canvas.inset | #010409 | code/terminal inset |
| border.default / muted | #3D444D / #2F3742 | hairlines, sparingly |
| fg.default / muted | #F0F6FC / #9198A1 | primary / metadata |
| fg.accent | #4493F8 | the only chromatic UI accent |
| fg.success / attention / danger | #3FB950 / #D29922 / #F85149 | passed / needs-you / failed |
| fg.agent | #AB7DF8 | agent-authored provenance |

Rules: semantic tokens only; text contrast ≥4.5:1 (UI ≥3:1); state layers = translucent foreground (hover 4%, pressed 9%, selected 7%); dark surfaces lift one step only; syntax colors Primer dark (keyword #FF7B72, entity #D2A8FF, string #A5D6FF, constant #79C0FF); diff bg #04260F/#490202 with `<ins>`/`<del>` semantics (color never the only cue).

Type: Inter Variable + Geist-Mono-class; copy tier 12/14/16, body 14px/20; mono for code/identifiers/hashes/counts/durations only. Density: 4px base; rows 28/32/40 (condensed/normal/spacious); stream events 4px apart, groups 12px; rail 56px; list pane 280–320px. Radius: one `--radius: 10px` with derivatives. Motion: 0/100/150/200/300ms, ease cubic-bezier(0.2,0,0,1), never >500ms, never decorative. Focus: always-visible 2px accent ring; roving tabindex; stream `role=log` aria-live=polite, status lines `live=false` inside it.

## 8. Frontend performance contract

- Initial JS ≤300KB gzip; route-level code splitting; one chunk per vendor; modulepreload; pre-paint theme restore from localStorage; render-first/auth-second.
- Hot log in Zustand external store, per-row selectors — **one delta = one row re-render**, never list re-render; deltas coalesced per animation frame.
- TanStack Query for request/response state only; optimistic task mutations with version rollback.
- Virtuoso for the stream (followOutput, prepend stability); TanStack Virtual for dense tables; `content-visibility: auto` first pass.
- jsdiff lazy chunk behind "Comparing…" status; Shiki per-language lazy; Monaco only as explicit "open in editor" escape hatch.
- 60fps scroll with 10k rows; INP ≤200ms under simulated event load (budget in [08](08-performance-plan.md)).

## 9. Responsiveness

≥1440px: full four-column shell. 1024–1440px: inspector default-closed, list pane collapsible. <1024px: single column with bottom nav (read-focused; triage + stream + task actions); full editing flows recommend desktop. Mobile read view is P2.