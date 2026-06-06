## Why

Goal DAG execution currently treats a subagent node as complete when the subagent self-reports completion and controller validation passes in that subagent workspace. That is not sufficient for multi-branch execution: completed subagent work can remain isolated on per-node branches/worktrees while the controller goal branch and later audit nodes continue from an unintegrated baseline.

Goal `6968fef0` exposed this gap: all DAG nodes reached `complete`, but final audit observed that many common-module violations remained because subagent branches had not been merged/cherry-picked into the controller workspace before the audit and goal-level completion.

## What Changes

- Add an explicit subagent branch integration gate between node validation and node completion.
- Persist and display integration state for subagents/nodes.
- Prevent final audit and goal completion until required subagent changes are integrated into the controller workspace or intentionally marked as no-op/documentation-only.
- Make final audit validators assert the integrated controller workspace state, not only the subagent workspace state or self-report transcript.
- Preserve existing DAG parsing/scheduling responsibilities; planner remains responsible for DAG production.

## Capabilities

### New Capabilities
- Subagent branch integration gate
- Integrated-workspace final audit enforcement

### Modified Capabilities
- Goal DAG controller loop
- Pi subagent adapter/workspace integration
- Controller validation runner
- Goal monitor/status presentation

## Impact

- Directly affected: `src/core/controller-loop.ts`, `src/core/git-workspace.ts`, `src/core/types.ts`, stores, Pi/OpenCode adapters, Pi monitor, validation runner, docs.
- Related but unchanged: planner DAG generation.

## Scope

### In
- Track integration status for subagent output branches.
- Integrate native-git subagent branches into the controller workspace before marking implementation nodes complete.
- Block downstream dependent nodes, final audit, and goal completion on failed or pending required integration.
- Add validators/tests for unintegrated branch prevention and final-audit enforcement.
- Document expected behavior and manual recovery paths.

### Out
- Fully automatic conflict resolution beyond safe merge/cherry-pick attempts.
- Planner changes to generate new integration nodes.
- Cross-adapter integration beyond native-git workspace adapters.
