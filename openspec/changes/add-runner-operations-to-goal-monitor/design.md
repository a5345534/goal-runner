## Context

Background Pi subagents are launched through detached runner processes with temp directories like `/tmp/agent-goal-runtime-bg-*`. Each temp dir contains `config.json` and, after startup, `ready.json` with runner/child PIDs and session file metadata. Existing durable subagent records contain session/workspace/branch data, but not a direct temp-dir index. The monitor therefore needs to derive runner inventory by matching temp-dir metadata to subagent records.

## Goals

- Let users operate runners from the runner list instead of shelling out.
- Keep operations row-scoped and explicit.
- Avoid deleting valuable artifacts: session transcript, worktree, branch.
- Fail safe when a runner cannot be matched or is still live.

## Decisions

### D1. Inventory scans temp runner dirs

**Choice**
- Scan `os.tmpdir()` for `agent-goal-runtime-bg-*` directories.
- Read `config.json` and `ready.json`.
- Match records to subagents by session name, session file, workspace path, or session id.
- Include only records related to the target goal or matched subagents.

**Rationale**
- No schema migration is required.
- Existing runtime already writes enough metadata to derive the mapping.

### D2. Stop/kill signal PIDs, not sessions/files

**Choice**
- `stop` sends SIGTERM to matching runner/child PIDs.
- `kill` sends SIGKILL after confirmation.
- Neither operation deletes transcripts, worktrees, or branches.

**Rationale**
- Stopping process loops is operationally necessary, but preserving artifacts is critical for recovery.

### D3. Archive skips live runner dirs

**Choice**
- `archive` moves stopped temp dirs to runtime state `runner-archives`.
- Live dirs are skipped.
- Operation is confirmed before execution.

**Rationale**
- Archiving temp dirs reduces clutter while avoiding mutation of active processes.

### D4. Open session is a runner operation

**Choice**
- Runner rows expose `openSession` when a session file exists.
- The operation calls `ctx.switchSession()` for that runner transcript.

**Rationale**
- It aligns with row-scoped operations and keeps runner inspection in monitor flow.

## Safety

- No worktree deletion.
- No branch deletion.
- No transcript deletion.
- SIGKILL requires confirmation.
- Archive requires confirmation and skips live PIDs.
- Missing runner inventory reports a warning instead of guessing.

## Follow-up

- Add DB reconcile row operations with automatic SQLite backups.
- Add duplicate-runner bulk operations once runner identity confidence is higher.
