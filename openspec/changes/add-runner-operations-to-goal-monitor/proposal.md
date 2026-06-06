## Why

Runner-list UX now exposes the selected runner's live transcript, but runner rows only supported `view` and `back`. Users still had to leave the monitor and run shell commands to stop duplicate/stale background runners or archive temporary runner directories. That is error-prone and contradicts the goal of making the monitor the operational surface for a goal.

## What Changes

- Add runner process inventory by scanning `agent-goal-runtime-bg-*` temp directories and matching them to durable subagent records.
- Display runner process counts and representative PID on runner rows.
- Add runner row operations:
  - `openSession`
  - `stop` (SIGTERM)
  - `kill` (SIGKILL with confirmation)
  - `archive` stopped runner temp dirs (with confirmation; live dirs skipped)
  - existing `view` and `back`
- Handle runner operations from `/goal monitor <id>` without deleting session transcripts, worktrees, or branches.

## Capabilities

### New Capabilities
- Goal monitor runner process inventory.
- Goal monitor runner stop/kill/archive/openSession operations.

### Modified Capabilities
- Pi goal monitor runner row operations.

## Impact

- Directly affected:
  - `src/adapters/pi/runner-ops.ts`
  - `src/adapters/pi/monitor-ui.ts`
  - `src/adapters/pi/index.ts`
  - `src/tests/pi-runner-ops.test.ts`
  - `src/tests/pi-monitor-ui.test.ts`
  - built `dist/` output
- Related but unchanged:
  - DB schema
  - controller scheduling/recovery
  - subagent worktree cleanup policy

## Scope

### In
- Read-only inventory of background runner temp dirs and PIDs.
- Row operations for open session, graceful stop, force kill, and archive stopped temp dirs.
- Confirmation prompts for force/destructive operations.
- Tests for inventory, archive safety, and monitor row operation selection.

### Out
- DB reconcile actions.
- Removing worktrees or branches.
- Deleting session transcripts.
- Automatically choosing duplicate runners to stop without user selection.
