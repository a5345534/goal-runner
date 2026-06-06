## Context

Goal runtime currently persists subagent and DAG node statuses. A subagent `failed` state can propagate into a DAG node `failed` state, and controller recovery can start a new subagent attempt. This worked for simple retry scenarios, but it violates the controller model for complex coding work: useful context and partial progress live in the original session/workspace and should be preserved.

Recent live goals exposed two failure modes:

1. A recoverable Pi context-overflow state caused replacement subagents while the original session was compacting.
2. Provider/model errors and brittle validators created multiple subagent attempts even though the same session/workspace contained useful diagnostic context.

## Goals

- Make controller recovery session-first.
- Avoid terminal DAG `failed` for normal recoverable or unclassified subagent errors.
- Convert provider quota/usage/billing limits into explicit blocked resource diagnostics.
- Preserve context by sending recovery prompts to the original session whenever possible.
- Keep replacement subagents only for deliberate last-resort workflows.

## Decisions

### D1. Treat `failed` as attempt diagnostic, not normal DAG terminal outcome

**Choice**
- The controller will avoid marking DAG nodes `failed` for subagent error states that can be recovered, diagnosed, or escalated as blocked.
- Existing `failed` enum values remain for backward compatibility and genuine terminal/system records, but normal controller flow moves nodes back to `running` or to `blocked` with diagnostics.

**Rationale**
- Users expect the controller to troubleshoot, not abandon work.
- Completion guards already reject failed nodes; minimizing terminal failed reduces false dead-ends.

**Alternative rejected**
- Remove `failed` from the type/schema immediately. That would be a larger migration and could break existing stores/tests.

### D2. Same-session recovery is preferred

**Choice**
- For transient or unknown subagent errors, controller sends a recovery prompt to the same subagent session via `sendGoalSubagentPrompt()`.
- The subagent/node return to `running` with a diagnostic `integrationStatus`/`lastValidationSummary` explaining the recovery.

**Rationale**
- Preserves transcript context, Pi compaction summaries, and workspace state.
- Avoids duplicate branches/worktrees and repeated file discovery.

**Alternative rejected**
- Always create `-2`, `-3` replacement subagents. This wastes context and caused runner duplication.

### D3. Quota/provider-limit errors block instead of fail

**Choice**
- Known provider quota/billing/usage-limit signatures are classified as blocked resource conditions.
- The DAG node becomes `blocked` with a diagnostic summary; it is not `failed` and does not spawn replacement subagents.

**Rationale**
- Quota exhaustion is not an implementation failure. It requires model/account/config intervention.
- Repeated retries consume time and can generate noisy sessions.

**Alternative rejected**
- Treat quota as transient retry. Provider limit errors are usually non-retryable until external state changes.

### D4. Context fallback remains a deliberate exception

**Choice**
- Existing context fallback may still start a larger-context replacement subagent when the adapter reports a genuinely terminal/stale context failure and a larger model exists.
- The prior compaction-race fix prevents this path while Pi is live/recovering.

**Rationale**
- Some sessions may be unrecoverable on the current model, and a larger-context model can be useful.
- This path should be rare and justified by stale/terminal evidence.

**Alternative rejected**
- Forbid replacement subagents entirely. That would leave no escape hatch for genuinely broken sessions.

## Risks / Trade-offs

- In-place recovery can keep a bad session alive longer than replacement would.
- Unknown errors may require developer follow-up; the controller will preserve context but may not solve every unhandled scenario.
- Historical `failed` records remain visible until a larger status-model migration is implemented.

## Migration Plan

1. Add error classification helpers for quota and recoverable/unknown errors.
2. Change controller recovery to send same-session prompts for transient/unknown errors.
3. Convert quota/provider-limit errors to blocked diagnostics.
4. Keep context fallback only for explicit larger-model recovery.
5. Add regression tests.
6. Build, test, regenerate OpenSpec artifacts.

## Open Questions

- Should persistent schema gain an explicit attempt/error table instead of overloading subagent statuses?
- Should model-catalog quota fallback be implemented as a follow-up with user-configurable fallback chains?
