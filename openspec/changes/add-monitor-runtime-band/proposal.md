# add-monitor-runtime-band

## Why

Issue [#40](https://github.com/a5345534/goal-runner/issues/40) identifies a monitor UX gap: the `/goal monitor` first screen currently shows raw DAG state without clearly separating the three runtime layers — original controller session activity, hidden continuation status, and controller polling lifecycle.

This causes a healthy active state (original session has an active turn, hidden continuation is intentionally suppressed, poll loop is running, runners are executing) to look confusing or stuck. Users cannot tell at a glance whether the goal needs attention or is making normal progress.

## Value Gate

- Outcome: `proceed_to_spec`
- No-build considered: Rejected. Documentation alone cannot fix the at-a-glance diagnostic gap; the monitor is the primary diagnostic surface for running goals.
- Smaller-scope considered: Selected. This change implements the runtime-state summary model and display in both Pi TUI and OpenCode text monitors. A more sophisticated health-scoring engine is deferred as backlog.
- Assumption posture: Confirmed from issue #40 spec and existing monitor code inspection.

## What Changes

- Add a `GoalMonitorRuntimeSummary` view model derived from existing runtime and adapter state.
- Surface the summary as a compact runtime-state band in the Pi TUI monitor.
- Group OpenCode monitor output into `STATUS`, `RUNTIME`, `PROGRESS`, and `NEXT ACTION` sections.
- Distinguish hidden continuation states: `eligible`, `suppressed (with reason)`, `reserved`, `started`, `not-configured`.
- Distinguish controller poll states: `active`, `leased`, `skipped`, `stopped`.
- Show runner count summary at overview level: running, stopped, duplicate, archived, failed.
- Display a derived health line and one-line next-action recommendation.

## Impact

- Affected specs: `goal-monitor-runtime-band`
- Affected modules/repos: `goal-runner` Pi monitor UI, OpenCode monitor UI, monitor tests, docs.
- Affected APIs/events/data: Adds a monitor-facing view model type; no runtime API or persistence change.
- Migration/deployment impact: None. Monitor display only; existing row actions and state unchanged.
- User-visible impact: Monitor first screen clearly distinguishes session activity, hidden continuation, poll status, and runner counts.

## Non-Goals

- Do not change controller scheduling semantics.
- Do not change hidden continuation launch semantics.
- Do not change subagent lifecycle state machine.
- Do not change goal-contract, goal-dag, or goal-spec.
- Do not add a graphical web dashboard.
- Do not add new destructive monitor actions.
- Do not implement a full health-scoring engine in this change.

## Pipeline Handoff Boundary

- Stage 1 output: governed OpenSpec sources only.
- Downstream consumer: `goal-dag` reads `source-manifest.json` plus the authoritative markdown/spec sources.
- No Goal DAG JSON or execution runtime plan is produced by this package.

## Success Signal

Pi TUI monitor first screen shows a `Runtime` band with `Session`, `Hidden`, `Poll`, and `Runners` states. OpenCode monitor groups output into `STATUS`, `RUNTIME`, `PROGRESS`, and `NEXT ACTION` sections. An active original session does not render as failure; suppressed hidden continuation shows the reason (e.g., "active turn running").

## Assumptions

- None.

## Open Questions

- [ ] None.
