## Context

Native-git orchestration currently creates a controller goal worktree/branch and subagent worktrees/branches. Subagent completion requires integration into the controller branch, but goal finalization only checks DAG terminal state and required subagent integration. It does not promote the controller branch into the project target branch.

Users reasonably expect `complete` to mean the requested repository state is present on the normal target branch and transient goal worktrees/branches are cleaned up.

## Goals

- Make `complete` mean promoted, validated, and cleaned up for native-git goals.
- Fail closed on dirty target worktrees, merge conflicts, or post-promotion validation failures.
- Keep diagnostic artifacts when promotion fails.
- Avoid changing planner responsibilities.

## Decisions

### D1. Add a controller-branch promotion gate before final complete

**Choice**
- Native-git finalization must merge the controller branch into the target branch before setting the goal status to `complete`.
- If promotion cannot run safely, finalization returns/records `blocked` with diagnostics.

**Rationale**
- Aligns terminal status with user-visible repository state.
- Prevents branch-complete work from being mistaken for project-complete work.

**Alternative rejected**
- Keep current branch-complete semantics and document it. This is misleading for downstream validation and second-session review.

### D2. Cleanup only after successful promotion

**Choice**
- Remove controller/subagent worktrees and completed temporary branches only after promotion and final validation succeed.
- Preserve artifacts when blocked.

**Rationale**
- Successful closeout should leave the repo clean.
- Blocked closeout needs worktree/branch evidence for troubleshooting.

### D3. Dirty target or conflicts block, never force

**Choice**
- Promotion must reject dirty target worktrees and merge conflicts.

**Rationale**
- Matches native-git fail-closed policy and avoids overwriting unrelated user work.

## Risks / Trade-offs

- Some goals that are currently considered complete will become blocked until promotion succeeds.
- Promotion can expose semantic divergence between the goal branch and a target branch that advanced independently.
- Cleanup removes convenient local artifacts after success, so final commit/branch metadata must be recorded before deletion.

## Migration Plan

1. Add promotion/cleanup primitives to native git workspace utilities.
2. Persist the promotion target ref for auto-allocated Pi controller branches.
3. Wire Pi DAG terminal finalization through the promotion gate.
4. Add tests for successful promotion, dirty target blocking, and Pi closeout cleanup behavior.
5. Build dist and validate OpenSpec artifacts.

## Open Questions

- Should final validators rerun on target branch after promotion in a future change?
