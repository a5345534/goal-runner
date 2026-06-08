## Why

Live goals can still become noisy or stuck after recovery when Pi background runner directories accumulate. A single durable subagent may have multiple detached runners alive, terminal subagents may keep running after the controller has already marked them complete/blocked/failed, and repeated Pi `terminated` errors after huge transcripts currently exhaust same-session retries and block the node without a clean replacement attempt.

The observed operational failures were:

- duplicate live runners for the same subagent after recovery/reload;
- terminal subagents continuing to produce session noise;
- blocked active nodes repeating the same `recovery.blocked` ledger entries every poll;
- closeout validators that are branch-sensitive but implicitly run in the subagent workspace;
- large Pi transcripts repeatedly ending with `terminated` instead of a resumable outcome.

## What Changes

- Add Pi controller runner preflight that stops/archive terminal runner temp dirs and stops duplicate live runners for the same durable subagent.
- Add a bounded replacement path for repeated `terminated` failures after same-session recovery is exhausted.
- Suppress repeated identical `recovery.blocked` ledger spam within a short cooldown window.
- Document validator cwd contract work as an explicit follow-up backlog item.

## Capabilities

### New Capabilities
- Runner inventory preflight and duplicate-runner convergence.
- Bounded terminated-session replacement recovery.
- Recovery blocked ledger cooldown.

### Modified Capabilities
- Pi controller poll pre-processing.
- Core failed-subagent recovery routing.

## Impact

- Affected: `src/adapters/pi/index.ts`, `src/core/controller-loop.ts`, Pi adapter/controller tests, committed `dist/`.
- Follow-up required: structured validator command cwd contract for target/controller/subagent workspace execution.

## Scope

### In
- Stop terminal live runners and archive stopped terminal/duplicate temp dirs.
- Keep one live runner per non-terminal subagent.
- Start one replacement subagent for repeated `terminated` errors after same-session recovery is exhausted.
- Avoid repeated identical recovery.blocked ledger spam.

### Out
- Full validator cwd schema migration.
- Automatic repair of already-lost worktrees/branches.
- Semantic implementation completion of current business goals.
