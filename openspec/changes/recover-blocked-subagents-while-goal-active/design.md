## Context

Controller ticks currently sync only non-terminal subagent statuses (`sessionStarted`, `running`, `idle`). Once a subagent is saved as `blocked`, later transcript changes are invisible to the controller. `reconcileSubagentOutcomes()` also immediately re-saves the node as `blocked`, so an active DAG goal can stall permanently even when the same session later reports success.

This is not a workspace-specific issue. It is a generic orchestration state-machine issue: active goals should continue best-effort reconciliation until the parent goal becomes paused/blocked/complete or the runtime reaches a bounded recovery stop condition.

## Goals

- Active goal controller ticks keep reconciling blocked subagent sessions.
- Late `SUBAGENT_RESULT` after a previous blocked state is accepted and sent through validation/integration.
- Still-blocked subagents receive bounded same-session recovery prompts.
- Quota/provider blockers remain fail-closed and do not trigger repeated prompts.

## Non-Goals

- Infinite retry loops.
- Workspace-specific unblock policy.
- Replacing the existing explicit user-owned `pause` / terminal goal statuses.

## Decisions

### D1. Treat blocked subagents as syncable

Add `blocked` to the controller syncable status set. This allows the adapter to re-read the session transcript and observe late state transitions such as `selfReportedComplete`.

### D2. Recover blocked subagents while the controller is active

When a subagent remains `blocked` after sync, the controller sends a same-session recovery prompt if retry count is below `maxAutoRetries`. The prompt tells the subagent to inspect minimally, continue if the blocker is already resolved or fixable, and otherwise re-report `SUBAGENT_BLOCKED` with the external input/state needed.

This keeps recovery session-first and bounded.

### D3. Preserve provider/quota stops

Provider/quota/billing blockers are considered external abnormal conditions. The controller records/keeps the blocked state and does not continue prompting or spawn replacement sessions.

## Risks

- A genuine blocker may receive one or two additional prompts before remaining blocked. This is bounded by the existing auto-retry cap and preferable to silent active-goal stalls.
- Adapters that map stopped sessions to `complete` may surface old outcomes during blocked sync; validation/integration still guards completion.

## Validation

- Regression test: blocked subagent later syncs as `selfReportedComplete` and completes after validation.
- Regression test: still-blocked subagent receives an active-goal same-session recovery prompt.
- Regression test: provider quota blocker does not receive recovery prompts.
