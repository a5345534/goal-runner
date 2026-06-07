## Why

Current DAG goal completion means all DAG nodes completed and subagent branches were integrated into the controller goal branch. It does not guarantee that the controller goal branch was merged back into the target/base branch, nor that controller worktrees/branches were cleaned up.

That creates a misleading `complete` state: a second session inspecting the normal project branch may still see broken downstream code because the finished work remains isolated in the goal branch.

## What Changes

- Redefine native-git DAG completion so `complete` requires promotion of the controller goal branch into the configured target/base branch.
- Fail closed when the target worktree is dirty or when merge conflicts occur.
- Clean completed controller/subagent worktrees and temporary goal branches only after successful promotion.
- Preserve the goal branch/worktree when promotion is blocked for diagnosis.

## Capabilities

### New Capabilities
- Goal branch promotion gate before terminal `complete`.
- Controller worktree/branch cleanup after successful promotion.

### Modified Capabilities
- DAG terminal finalization semantics for native-git Pi goals.

## Impact

- Affected: Pi finalization/closeout path, native git workspace/integration utilities, runtime tests, dist artifacts.
- Related unchanged: planner DAG production, subagent branch integration into controller branch, validator execution.

## Scope

### In
- Promote controller branch into target branch before marking native-git DAG goals `complete`.
- Block rather than complete when promotion cannot be performed safely.
- Remove completed goal worktrees/branches after successful promotion.

### Out
- Force-merging dirty target worktrees.
- Automatically resolving semantic conflicts across divergent submodule contracts.
- Rerunning a full post-promotion validation suite on the target branch; this remains follow-up work.
- Changing non-native-git adapters in this change.
