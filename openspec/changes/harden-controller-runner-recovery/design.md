## Context

The controller is deterministic, but Pi subagent execution is mediated by detached background runner processes and durable JSONL session files. Recovery/reload can leave more than one runner alive for a single durable subagent. It can also leave terminal subagents with still-running detached Pi processes. When a transcript grows very large, Pi may report repeated assistant `terminated` errors; the core controller currently spends same-session retries and then blocks the node as an unhandled scenario.

## Goals

- Keep runner inventory consistent with durable subagent state before each Pi controller poll.
- Prevent terminal subagents from continuing to mutate transcripts/workspaces.
- Prevent duplicate live runners for the same subagent from racing.
- Preserve same-session recovery first, but start one fresh replacement session after repeated `terminated` errors exhaust same-session retries.
- Reduce repeated identical recovery.blocked ledger spam.

## Decisions

### D1. Pi poll preflight owns runner convergence

**Choice**
- Before each Pi controller poll, read background-runner inventory for the goal.
- If a runner belongs to a terminal subagent (`complete`, `blocked`, `failed`), send SIGTERM and archive stopped dirs.
- If multiple live runners belong to a non-terminal subagent, keep the newest runner dir and SIGTERM the rest.

**Rationale**
- The Pi adapter has access to `/tmp/agent-goal-runtime-bg-*` inventory; the core controller should remain adapter-agnostic.
- Terminal subagent runners cannot produce useful durable state and can create misleading transcript noise.

**Alternative rejected**
- Only expose monitor manual stop/archive actions. This leaves active goals dependent on operator vigilance.

### D2. Terminated recovery gets one replacement after same-session retries

**Choice**
- Same-session recovery remains first choice for unhandled errors.
- If the error is `terminated` and the subagent has exactly reached `maxAutoRetries`, the controller terminalizes the old attempt and starts one replacement subagent in the same workspace/branch/ref when possible.
- The replacement carries `retryCount=maxAutoRetries+1`; if it fails again, normal blocked handling applies.

**Rationale**
- Repeated `terminated` after huge transcripts is often a transcript/session pressure problem, not a workspace problem.
- A fresh session can continue from the repository state without pulling the huge transcript forward.
- The one-replacement rule prevents infinite restart loops.

**Alternative rejected**
- Immediately replace every `terminated` error. That would discard resumable sessions too eagerly.

### D3. Recovery blocked ledger entries use a cooldown

**Choice**
- Keep state unchanged, but suppress repeated identical `recovery.blocked` ledger events for the same goal/node/subagent/reason within a short cooldown.

**Rationale**
- The monitor already pins the current blocker; repeated ledger spam makes history unreadable.

**Alternative rejected**
- Stop polling blocked active goals entirely. Active goals should keep best-effort recovery opportunities visible.

### D4. Validator cwd contract remains a follow-up

**Choice**
- Record branch-sensitive validator cwd as a follow-up change rather than ad hoc hidden behavior.

**Rationale**
- Structured validator commands affect schemas, parser compatibility, docs, and planner output. They should be designed as a separate governed change.

## Risks / Trade-offs

- Stopping duplicate runners could terminate a still-working duplicate. Keeping the newest runner dir is deterministic and preserves one active attempt.
- Replacement after `terminated` may continue from a dirty workspace; the recovery prompt requires workspace inspection first.
- Cooldown can hide repeated unchanged blocker events, but state and pinned diagnostics remain available.

## Migration Plan

1. Implement Pi runner preflight and call it before controller poll loops.
2. Extend core failed-subagent recovery for bounded `terminated` replacement.
3. Add unit tests for runner preflight and terminated replacement.
4. Rebuild `dist/` and validate.

## Open Questions

- What schema should structured validators use for `cwd: subagent-workspace | controller-workspace | target-workspace`?
- Should runner preflight eventually expose an operator-configurable keep policy?
