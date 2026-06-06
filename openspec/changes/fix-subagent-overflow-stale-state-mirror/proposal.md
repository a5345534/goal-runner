## Why

Pi subagent sessions can append `agent-goal-runtime-state` custom entries after the last real assistant/tool event. When a subagent hits `context_length_exceeded`, those runtime mirror entries were updating the parsed `lastActivityAt`, so the controller kept reporting `Pi context overflow recovery pending` indefinitely instead of classifying the overflow recovery as stale and triggering fallback recovery.

This was observed on live Goal `0c3af931`: two subagents had no non-custom transcript activity for about an hour, but their state mirror entries continued every few seconds and prevented stale recovery.

## What Changes

- Ignore `agent-goal-runtime-state` custom/custom_message entries when computing Pi subagent transcript activity.
- Preserve entry counts, but do not let runtime mirror bookkeeping refresh `lastActivityAt` or hide stale context-overflow failures.
- Add regression coverage for context-overflow stale recovery with later runtime mirror timestamps.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- Pi subagent session inspection and recovery classification.

## Impact

- Directly affected: `src/adapters/pi/subagent-adapter.ts`, `src/tests/pi-subagent-adapter.test.ts`.
- Runtime behavior: stale context-overflow sessions can now transition out of indefinite recovery and allow controller fallback/recovery policy to run.

## Scope

### In
- Treat runtime mirror custom entries as bookkeeping for stale detection.
- Keep user/model/tool/compaction entries as real activity.

### Out
- Changing context fallback model routing.
- Persisting separate attempt/error records.
- Redesigning controller poller ownership.
