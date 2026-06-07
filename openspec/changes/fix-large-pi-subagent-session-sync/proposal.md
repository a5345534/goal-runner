## Why

Some Pi subagent JSONL session files can grow very large because runtime state mirror custom entries are appended frequently. Goal `65f61476` produced a 558MB subagent session file. The Pi subagent adapter read the entire JSONL file into one JavaScript string before skipping mirror entries, which hit V8's string limit:

```text
Cannot create a string longer than 0x1fffffe8 characters
```

The controller then could not sync the subagent transcript, could not observe later `SUBAGENT_RESULT` markers, exhausted recovery attempts, and kept the node blocked while the parent goal remained active.

## What Changes

- Parse Pi subagent session JSONL from disk incrementally instead of reading the whole file into a single string.
- Skip `agent-goal-runtime-state` mirror entries before JSON parsing where possible.
- Preserve test injection via `readFile` for small synthetic transcripts.
- Add regression coverage for large session files with many runtime state mirrors after a valid result marker.

## Impact

- Directly affected: `src/adapters/pi/subagent-adapter.ts` and Pi subagent adapter tests.
- No change to controller scheduling semantics, validation policy, or workspace policy.
