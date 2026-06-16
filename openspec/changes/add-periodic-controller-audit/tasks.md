# Tasks: add-periodic-controller-audit

## 1. Spec and Contract

- [ ] 1.1 Add `GoalControllerAuditOptions`, `GoalControllerAuditSnapshot`, `GoalControllerAuditDecision` types to `src/core/types.ts` or a new `src/core/controller-audit.ts`.
- [ ] 1.2 Define audit-ledger event type constants (`controller_audit_started`, `controller_audit_finished`, `controller_audit_invalid_output`, `controller_audit_action_applied`, `goal_paused_by_controller_audit`).
- [ ] 1.3 Confirm no new DB migration is required; existing ledger event model accommodates new types.

## 2. Audit Snapshot and Decision Validation

- [ ] 2.1 Add `buildControllerAuditSnapshot()` to construct a bounded snapshot from `GoalOrchestrationState` and recent ledger events.
- [ ] 2.2 Add `validateControllerAuditDecision()` to validate returned JSON against the audit decision schema.
- [ ] 2.3 Add `isAuditDue()` to check whether enough time has passed since the last audit for the current goal.

## 3. Safe Action Policy

- [ ] 3.1 Add `applyAuditActions()` that evaluates validated audit decisions against policy.
- [ ] 3.2 Implement `pause-goal` auto-action when risk is `critical`, confidence is `high`, and `pauseOnCritical` is enabled.
- [ ] 3.3 Record skipped actions (non-pause or below-threshold) as `controller_audit_action_skipped`.
- [ ] 3.4 Ensure all other action types (cap-retries, mark-node-blocked, etc.) require explicit deterministic confirmation before auto-applying.

## 4. Controller Loop Integration

- [ ] 4.1 Add audit scheduling gate at the end of the controller tick/poller loop.
- [ ] 4.2 Invoke `buildControllerAuditSnapshot()` only when audit is due and a goal is active.
- [ ] 4.3 Pass the snapshot to the configured audit model through the harness adapter interface.
- [ ] 4.4 Validate the returned audit decision, apply safe actions, and record events.
- [ ] 4.5 Update `lastAuditAt` timestamp after each audit run.

## 5. Controller Audit Model Prompt

- [ ] 5.1 Write a strict controller audit system prompt in `src/core/prompts.ts` or similar.
- [ ] 5.2 The prompt must state: audit role is diagnostic only; no planning/completion/merge authority; return only JSON matching the schema; subagent self-reports are not validation authority.
- [ ] 5.3 Include examples of key patterns: retry-loop, no-progress, cost-spike, healthy-progress.

## 6. Ledger and Monitor

- [ ] 6.1 Record audit lifecycle events in the durable goal ledger/store.
- [ ] 6.2 Surface latest audit summary in Pi goal monitor/status display.
- [ ] 6.3 Surface latest audit summary in OpenCode monitor/status display.
- [ ] 6.4 Format audit summary compactly: `Controller audit: <risk> <finding kind> on <nodeId>; <applied actions>`.

## 7. Tests

- [ ] 7.1 Add unit tests for `isAuditDue()` scheduling respecting `intervalMs`.
- [ ] 7.2 Add unit tests for `buildControllerAuditSnapshot()` producing bounded structured output without full transcripts.
- [ ] 7.3 Add unit tests for `validateControllerAuditDecision()` accepting valid and rejecting invalid JSON.
- [ ] 7.4 Add unit tests for `applyAuditActions()`: pause on critical+high-confidence, skip otherwise.
- [ ] 7.5 Add unit tests proving `pause-goal` does not mark nodes or goals complete.
- [ ] 7.6 Add scenario tests: simulated retry-loop triggers pause; cost-spike triggers pause; healthy progress returns noop.
- [ ] 7.7 Add monitor display tests for audit summary rendering.

## 8. Verification / Closeout

- [ ] 8.1 Run focused controller audit tests.
- [ ] 8.2 Run `npm run check`.
- [ ] 8.3 Rebuild and commit affected `dist/` artifacts required by package consumers.
- [ ] 8.4 Refresh `source-manifest.json`.
- [ ] 8.5 Generate and validate `change-explainer.html` with the decision-review validator.
- [ ] 8.6 Confirm Stage 1 produced only OpenSpec package sources and did not generate downstream execution-plan artifacts.

## Backlog / Follow-ups

- [ ] [BACKLOG] Enable `cap-retries` and `stop-launching-new-subagents` as automatic actions after deterministic retry-cap configuration lands.
- [ ] [BACKLOG] Add `mark-node-blocked` auto-action after deterministic contract re-check is implemented.
- [ ] [BACKLOG] Support per-goal audit config instead of global-only.
- [ ] [BACKLOG] Add cost-budget tracking to audit agent so it can throttle itself when token cost exceeds a budget.
