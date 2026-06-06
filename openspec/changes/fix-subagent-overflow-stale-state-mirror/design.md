## Context

`readPiSubagentSessionState()` scans the Pi session JSONL and tracks `lastActivityAt`, `lastMessageRole`, and sticky assistant errors. The parser previously updated `lastActivityAt` for every parsed entry before checking the entry type. Runtime state mirror entries (`type=custom`, `customType=agent-goal-runtime-state`) are appended by goal-runtime bookkeeping and can continue after the model has stopped making progress.

For context overflow recovery, `isRecoverableContextOverflow()` uses `lastActivityAt` to decide whether Pi may still compact/retry. Runtime mirror entries therefore made the recovery window move forward forever.

## Decision

### D1. Ignore runtime mirror entries for activity classification

**Choice**
- During Pi session parsing, increment `entryCount` for all well-formed entries.
- If an entry is `agent-goal-runtime-state` with `type=custom` or `type=custom_message`, skip it before updating `lastActivityAt` or message/error state.

**Rationale**
- Runtime mirror entries are observability/bookkeeping, not evidence of subagent model/tool progress.
- Compaction entries remain real recovery evidence and still clear sticky context errors.
- User, assistant, and toolResult messages continue to drive stale detection.

## Risks / Trade-offs

- A session that only receives runtime mirror entries after a real toolResult can now become stale and receive follow-up/recovery. That is desired because the subagent itself did not progress.
- Entry counts still include mirror entries, so monitor/debug counts remain faithful to the raw file.

## Validation

- Focused Pi subagent adapter tests cover stale context overflow with later runtime mirror entries.
- Full project validation remains required before archiving.

## Open Questions

- None.
