# add-periodic-controller-audit

## Why

Issue [#39](https://github.com/a5345534/goal-runner/issues/39) exposed a higher-level controller gap: the controller can execute state transitions, but it does not periodically ask whether the run is still healthy.

In the observed `final-verification` retry loop, the deterministic controller loop kept issuing identical follow-up prompts and spawning new subagents, consuming tokens without ever reaching a different outcome. While Phase 1 (`close-required-evidence-contract`) closes the known invalid-contract class, it does not protect against *unknown* failure patterns in the future:

- same node repeatedly self-reports complete but fails validation
- retry subagent names accumulate `retry-1-retry-1-...`
- token usage rises while completed node count stays flat
- validators pass but controller never reaches node completion
- integration repeatedly fails with the same summary
- goal remains active but no meaningful progress happens for a long window

A periodic diagnostic layer is needed: the controller should safely pause or escalate when it detects no-progress or excessive-cost patterns, even when the deterministic loop is not designed to recognize them.

## Value Gate

- Outcome: `proceed_to_spec`
- No-build considered: Rejected. Deterministic rules alone cannot detect unknown future failure patterns by definition; those patterns are, by design, what the audit agent is built to catch.
- Smaller-scope considered: Selected. This change implements a minimum viable audit: bounded structured snapshot, schema-validated model output, and `pause-goal` as the only automatic protective action. Other actions (`cap-retries`, `stop-launching-new-subagents`, `mark-node-blocked`) are either deferred or gated behind deterministic confirmation.
- Assumption posture: Confirmed from the follow-up design spec in Issue #39 comment #5/#6. All audit behavior constraints are explicitly stated.

## What Changes

- Add a low-frequency periodic controller audit path (`runGoalControllerAudit()`) separate from the deterministic execution loop.
- Build a bounded structured audit snapshot from trusted runtime state (not full transcripts).
- Invoke a controller audit model with a strict system prompt and JSON output schema.
- Validate returned audit decision JSON; ignore invalid output.
- Apply `pause-goal` automatically when audit risk is `critical` with high confidence, gated behind configurable policy.
- Record audit events durably in controller ledger/events.
- Surface latest audit findings in goal monitor/status display.
- Keep all audit actions reversible: no complete, no merge, no code modification, no DAG modification, no replanning.

## Impact

- Affected specs: `controller-audit-agent`
- Affected modules/repos: `goal-runner` core runtime, controller loop, monitor UI, ledger store.
- Affected APIs/events/data: New controller event types for audit lifecycle; new monitor display lines for audit findings.
- Migration/deployment impact: Optional and configurable; disabled by default or default interval of 30 minutes. No DB migration required for new event types; existing events unchanged.
- User-visible impact: Monitor shows latest audit summary; paused goals display audit-triggered reason.

## Non-Goals

- Do not generate or rewrite DAG plans.
- Do not modify source code.
- Do not mark a node or goal complete.
- Do not merge branches.
- Do not delete workspaces.
- Do not override deterministic validation.
- Do not satisfy validation evidence by self-report or transcript matching.
- Do not replace Phase 1 deterministic contract closure; that remains a separate change.
- Do not implement `cap-retries`, `stop-launching-new-subagents`, `mark-node-blocked` as automatic actions in this change; those require deterministic confirmation.

## Pipeline Handoff Boundary

- Stage 1 output: governed OpenSpec sources only.
- Downstream consumer: `goal-dag` reads `source-manifest.json` plus the authoritative markdown/spec sources.
- No Goal DAG JSON or execution runtime plan is produced by this package.

## Success Signal

A simulated retry-loop scenario produces a controller audit with risk `critical`, the audit decision recommends `pause-goal`, the runtime automatically pauses the goal when `pauseOnCritical` is enabled, the ledger records the audit event, and the monitor shows the audit finding. Healthy progress scenarios produce `noop` or low-risk results.

## Assumptions

- [ASSUMPTION] Default audit interval of 30 minutes is appropriate for cost-sensitive production use; tuning may be needed.
- [ASSUMPTION] The controller audit model (e.g., deepseek/deepseek-v4-pro) can reliably detect retry-loop and no-progress patterns from the bounded snapshot shape; prompt engineering may need iteration.

## Open Questions

- [ ] Should `pauseOnCritical` default to `true` or `false`? Current design defaults to `true` (safe), but user feedback may prefer opt-in.
- [ ] Should the audit agent be able to resume a paused goal after the condition clears, or must a human resume it?
