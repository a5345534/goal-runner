# Adapter contract

A full adapter connects the portable runtime to a host harness.

## Required responsibilities

1. Register `/goal` command forms.
2. Resolve a stable materialized session key.
3. Wire a persistent store.
4. Register model-visible `get_goal`, `create_goal`, and `update_goal` tools.
5. Map host lifecycle events into runtime hooks.
6. Implement hidden continuation through `startHiddenGoalTurn`.
7. Show visible goal update/clear/status feedback.
8. Classify meaningful progress so automatic continuation does not loop after pure chat/status turns.
9. Enforce same-turn post-stop tool guarding where the host can intercept tool calls.
10. Persist goal-session metadata and expose goal registry/listing/target-resolution UX without adding model-visible cross-goal tools.
11. For harnesses that support goal-owned sessions, bind each new execution session to an explicit prepared workspace and verify branch/ref bindings read-only.
12. Optionally provide a completion auditor behind `update_goal({"status":"complete"})`.
13. Provide a smoke/conformance report.

## Hidden turn callback

`startHiddenGoalTurn(request)` receives:

- `attemptId` — runtime idempotency key
- `sessionKey`
- `goalId`
- `goalUpdatedAt` observed during eligibility checks
- `attemptCount`
- `hiddenContextKind: "goal_continuation"`
- `renderedPrompt`
- optional `policyContext`

It returns one of:

- `started`
- `alreadyStarted`
- `skipped`
- `retryableFailure`
- `fatalFailure`

Rules:

- At most one hidden continuation reservation may be outstanding per session.
- The adapter must treat `attemptId` as idempotent.
- User input wins: queued user input returns `skipped` and is not retried until a later lifecycle event.
- Retryable failures use bounded retry. V0 default: max 3 attempts per reservation.
- Fatal/skipped outcomes do not mark a goal complete or blocked.
- Stale goal versions must not launch hidden continuation.

## Completion audit callback

`update_goal({"status":"complete"})` remains the model-visible completion path. A runtime or adapter may provide:

- `collectCompletionEvidence(goal)` — extracts out-of-band evidence from transcript, tool results, host state, or policy context.
- `getCompletionPolicyContext(goal)` — supplies host/workspace policy such as OpenSpec validation expectations.
- `auditCompletion(request)` — approves or rejects terminal completion.

If the auditor rejects, the goal remains non-terminal and the runtime records the rejection in the ledger. Adapters should report the rejection and prevent immediate same-turn mutation/continuation.

## Progress-gated continuation

`toolCompleted(context)` accepts optional `toolName`, `meaningfulProgress`, and `progressSummary` fields. Full adapters should set `meaningfulProgress=false` for status-only or bookkeeping tools such as `get_goal`, and true for task-relevant read/write/edit/bash/test activity. `turnFinished(..., true)` only schedules another hidden continuation when the just-finished turn made meaningful progress.

## Token usage snapshots

The portable runtime accepts normalized token usage snapshots; it does not depend on host-specific usage objects. Adapters should normalize their host usage before calling runtime hooks.

The Pi adapter counts completed assistant `input + output` channels when available and deliberately excludes provider cache accounting channels such as `cacheRead` / `cacheWrite` from goal budget usage. If a usage object lacks input/output channels but exposes a finite positive `totalTokens` value, the Pi adapter may use that total as a fallback. The core runtime still owns delta accounting and `budgetLimited` transitions.

## Execution ledger

Stores must persist goal ledger events through `appendLedgerEvent` and `listLedgerEvents`. The default SQLite store uses a `goal_ledger` table. Alternate stores should preserve equivalent event semantics so compaction, handoff, and audit can inspect lifecycle and evidence without relying only on chat transcript.

## Goal registry and workspace binding

The portable store contract includes goal summaries, metadata, and workspace profiles. Adapters may expose those through UI commands such as `/goal list` and targeted lifecycle operations, but model-visible tools remain `get_goal`, `create_goal`, and `update_goal` only.

Pi goal-owned sessions require explicit workspace binding. For git-backed workspaces, a branch or ref must be provided inline or by a named profile. The adapter validates paths, allowed-root policy (`AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` when configured), and git state with read-only inspection and must not create worktrees, create branches, delete workspaces, or switch branches. Legacy session-bound goals remain visible in registry output with `legacy` workspace status.

## Pi adapter status

The included Pi adapter maps:

- slash commands through `pi.registerCommand("goal", ...)`, including `/goal --tokens <budget> --workspace <path-or-profile> --branch <branch> <objective>` with `k` / `m` suffix parsing
- model tools through `pi.registerTool(...)`
- turn/tool lifecycle through Pi events
- ordinary-turn active goal reminders through `before_agent_start`
- goal registry/list commands, targeted status/monitor/pause/resume/clear/edit/budget commands, and named workspace profile commands
- explicit workspace/branch/ref binding validation without filesystem mutation, branch creation, or branch switching
- Pi custom session-entry mirroring through append-only `agent-goal-runtime-state` entries while the portable store remains canonical
- hidden continuation through `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })` in the materialized goal session`
- stale hidden continuation rewriting through the Pi `context` hook, including non-runnable stale bookkeeping and superseding older duplicate active-goal continuations
- stale hidden continuation abort suppression in `before_agent_start` / `turn_end` so cancelled old-goal continuations do not pause the current goal
- failed-turn recovery context that preserves bounded partial assistant output/tool traces as untrusted hidden transcript evidence for a later `/goal resume`
- aborted/error turn handling by pausing the active goal until `/goal resume`
- blocked updates through transcript-aware evidence derived from recent failed tool results or explicit blocked/cannot-proceed assistant text
- completion audit through a lightweight Pi transcript heuristic unless `AGENT_GOAL_COMPLETION_AUDIT=off` or `PI_GOAL_COMPLETION_AUDIT=off`
- same-turn post-stop tool guarding through Pi `tool_call` interception when available
- progress-gated continuation by classifying task-relevant tool completions

The blocked and completion audits do not add model-visible fields to `update_goal`; the tool still only accepts `complete` or `blocked`. The adapter computes evidence out-of-band and passes it to the runtime so a first failure, mismatched recent blockers, or completion without task evidence cannot silently become terminal.

Other harness adapters are intentionally deferred to separate changes.
