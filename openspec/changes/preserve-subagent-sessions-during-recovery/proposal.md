## Why

The current controller can treat a single subagent/session error as a terminal failure, start replacement subagents, and abandon useful context already accumulated in the original session. This is wasteful and makes debugging harder: Pi sessions may contain read-file context, tool results, partial fixes, compaction summaries, and committed/uncommitted workspace work. A controller should troubleshoot first, preserve working context, and only escalate to a human-visible blocked/paused/bug state when no defined recovery policy applies.

## What Changes

- Prefer same-session recovery prompts over spawning replacement subagents for recoverable subagent errors.
- Reclassify controller-visible failures as recovery, blocked, or unhandled-scenario diagnostics instead of terminal DAG node failure whenever possible.
- Add quota/provider-limit detection and convert it into a blocked/paused diagnostic instead of repeated replacement attempts.
- Preserve previous session context by sending a recovery prompt to the existing Pi session for transient and unknown errors.
- Keep replacement subagent creation as last resort for context fallback/new workspace cases where same-session recovery is not viable.
- Add tests that failed subagents are recovered in-place and that unknown/quota errors do not terminally fail DAG nodes.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- Controller subagent recovery policy
- Pi/OpenCode harness subagent orchestration semantics
- Goal monitor diagnostics indirectly through persisted node/subagent state

## Impact

- Directly affected:
  - `src/core/controller-loop.ts`
  - subagent recovery tests
- Related but unchanged:
  - Pi core compaction lifecycle
  - Git integration gate
  - DAG parser/schema

## Scope

### In
- In-place recovery for transient and unknown subagent errors.
- Quota/provider-limit classification as blocked resource condition.
- Avoiding DAG node terminal `failed` for ordinary subagent errors.
- Tests and built `dist/` output.

### Out
- Removing the `failed` enum entirely from persistent schema.
- Rewriting all historical DB records.
- Implementing cross-provider credential/billing remediation.
- Full model-catalog fallback chain for quota (backlog; this change blocks cleanly rather than failing).
