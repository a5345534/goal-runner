## Context

The runtime schedules DAG nodes in isolated subagent workspaces. Validation can pass inside a subagent workspace even when the controller workspace has not incorporated the subagent branch. Downstream audit nodes and the goal completion guard currently reason over DAG node status, not integrated repository state. This creates a false-complete risk for goals whose actual deliverable is the controller branch.

## Goals

- Ensure node completion means both validated and integrated when a node produces repository changes.
- Ensure final audit runs against the integrated controller workspace.
- Make unintegrated or conflicted branches visible and recoverable.
- Avoid changing planner responsibilities or requiring DAG authors to manually add integration nodes.

## Decisions

### D1. Integration is a controller responsibility, not a planner node

**Choice**
- The controller performs an integration step after subagent self-report validation and before node completion.
- The scheduler treats nodes with pending/failed integration as non-complete for dependency and goal-completion purposes.

**Rationale**
- Integration is runtime stateful behavior tied to workspaces, branches, merge bases, and conflict handling.
- Requiring planners to synthesize integration nodes would duplicate generic orchestration mechanics in every DAG.

**Alternative rejected**
- Add explicit `integrate-*` DAG nodes. This is flexible but easy to omit and does not protect existing DAGs.

### D2. Native-git integration is first-class and explicit

**Choice**
- For `workspaceStrategy=native-git-worktree`, persist subagent branch/ref/head metadata and integration status.
- Attempt a deterministic integration operation into the controller workspace using a native `git merge --no-ff --no-edit <sourceHead>` strategy.
- If conflicts or validation failures occur, leave the node in `needsFollowup`/integration-failed state with a recovery prompt and evidence.

**Rationale**
- Existing Pi subagents already use native git worktrees and per-node branches.
- A persisted integration status lets `/goal status` and `/goal monitor` explain what is blocking progress.

**Alternative rejected**
- Trust subagent self-report plus per-worktree validation. This caused the observed false complete.

### D3. Final audit must validate integrated controller state

**Choice**
- Final audit nodes must run after all required integrations are complete.
- Final audit validators must inspect the controller workspace state, not only a detached audit worktree seeded from stale base.
- Audit outputs reporting unresolved violations must fail validation unless the DAG/spec explicitly declares those violations accepted.

**Rationale**
- Final audit is the last defense against repository-level false completion.
- If audit report says violations remain, controller validation should not pass on report existence alone.

**Alternative rejected**
- Treat audit-report presence as sufficient evidence. That proves an audit was written, not that the goal succeeded.

### D4. Manual recovery remains supported

**Choice**
- If automatic integration fails, the controller records blocker metadata and prompts a subagent/controller follow-up to resolve conflicts or mark the branch as intentionally no-op.

**Rationale**
- Repository merges can require human/design decisions. The runtime should expose the blocker instead of silently skipping integration.

## Risks / Trade-offs

- Merge conflicts can slow DAG progress and require manual intervention.
- Integrating multiple subagent branches changes branch topology and may need careful ordering.
- Some nodes produce docs/reports only; the implementation must avoid over-blocking intentional no-op nodes while still preventing false success.
- Existing goals may need migration or repair if they completed before integration metadata existed.

## Migration Plan

1. Add integration metadata fields and store migrations.
2. Implement native-git integration attempts in controller completion flow.
3. Update validation runner/final audit contracts to require integrated-state evidence.
4. Update Pi monitor/status/docs.
5. Add tests for unintegrated complete prevention, conflict handling, and audit-report failure when violations remain.
6. Provide a manual repair path for already-completed goals with unintegrated subagent branches.

## Open Questions

- Resolved: native-git integration uses merge commits/no-ff rather than cherry-pick so branch provenance is preserved and multiple subagent branches can be integrated in order.
- Resolved: required/no-op integration decisions are recorded with `integrationState` (`pending`, `integrating`, `complete`, `failed`, `not-required`) plus source branch/ref/head, controller integration commit, error, completion timestamp, and human-readable status.
- Open: richer final-audit validators may still need project-specific machine-checkable acceptance criteria beyond the generic "report says violations remain" heuristic.
