## Context

`readPiSubagentSessionState()` previously called `readFileSync(sessionFile, "utf8")` and then split the full content into lines. This is unsafe for live Pi sessions that accumulate many large custom state mirror entries. Even though the parser skipped mirror entries after JSON parsing, the full string allocation happened first.

Goal `65f61476` demonstrated this failure mode with a 558MB JSONL file containing thousands of `agent-goal-runtime-state` custom entries and valid `SUBAGENT_RESULT` messages earlier in the transcript.

## Design

### Incremental disk parser

When no test `readFile` override is provided, the adapter now opens the session file and reads it in fixed-size chunks. It uses `StringDecoder` to preserve UTF-8 boundaries and processes complete lines incrementally.

This avoids creating a single giant transcript string.

### Mirror fast-skip

Before JSON parsing a line, the parser checks whether it looks like a runtime state mirror entry (`agent-goal-runtime-state` + custom). Such lines are counted for `entryCount` but skipped without JSON parsing or timestamp updates, matching prior semantic behavior while reducing cost.

### Existing parser compatibility

`parsePiSessionFile(content)` remains available internally for test injection via `readFile`, preserving existing tests that supply small transcript strings.

## Risks

- Incremental parsing still scans the file from the beginning. This is acceptable as a correctness fix and avoids the hard V8 limit; future work can add offset caching or bounded reverse scanning for very large live files.
- If an individual JSONL line itself exceeds memory limits, parsing that single line can still fail. Current observed mirror lines are large but far below the full-string limit.

## Validation

- Regression test creates a multi-megabyte JSONL file with a valid `SUBAGENT_RESULT` followed by many large state mirror lines and verifies the adapter still returns `selfReportedComplete`.
- Full project check and build are run.
