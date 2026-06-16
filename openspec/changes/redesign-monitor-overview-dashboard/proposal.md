# redesign-monitor-overview-dashboard

## Why

The current `/goal monitor` first screen exposes raw runtime data in one-line key=value dumps. While technically informative, it is not decision-oriented. Users cannot quickly answer:

- Is the goal done?
- Is it healthy?
- What is the real problem?
- What should I inspect next?

A completed goal currently shows `Health=Blocked` because of residual runner failures. Full controller history (18 live lines by default) dominates the first screen. Long subagent IDs clutter the overview.

The monitor needs an overview-first design that prioritizes status, health, problem, progress, and next action — with full logs available on demand but not dominating the first screen.

## Value Gate

- Outcome: `proceed_to_spec`
- No-build considered: Rejected. Documentation alone cannot fix first-screen diagnostic UX.
- Smaller-scope considered: Selected. This is a pure display / view-model refinement. No runtime semantics (controller scheduling, hidden continuation, subagent lifecycle) are changed.
- Assumption posture: Confirmed from detailed design spec with wireframes, health taxonomy, and acceptance criteria.

## What Changes

- Replace raw header with structured overview sections: Goal, Health/Problem, Progress, Runtime, Next Action.
- Fix health semantics: completed goals never show `Health=Blocked`; add `Complete` and `Complete with warnings`.
- Summarize problem lines to node-centric short phrases (not full subagent IDs).
- Use user-facing labels for runtime state (not raw enum values like `NOT-MATERIALIZED`).
- Move full controller history off the first screen; show only recent meaningful events by default.
- Add Execution Plan and Selected Detail sections visible on first screen.
- User-facing action labels while preserving existing operation IDs.

## Impact

- Affected specs: `goal-monitor-overview-dashboard`
- Affected modules/repos: `goal-runner` Pi monitor UI, OpenCode monitor UI, monitor tests.
- Affected APIs/events/data: New `GoalMonitorOverview` view model type; no persistence or runtime API change.
- Migration/deployment impact: None. Display-only change; existing row actions preserved.
- User-visible impact: Monitor first screen is overview-first, not log-first.

## Non-Goals

- Do not change controller scheduling.
- Do not change hidden continuation launch semantics.
- Do not change subagent lifecycle state machine.
- Do not change goal-contract, goal-dag, or goal-spec.
- Do not add new destructive actions.
- Do not add web dashboard or mouse UI.

## Pipeline Handoff Boundary

- Stage 1 output: governed OpenSpec sources only.
- Downstream consumer: `goal-dag` reads `source-manifest.json` plus the authoritative markdown/spec sources.
- No Goal DAG JSON or execution runtime plan is produced by this package.

## Success Signal

A completed goal never shows `Health=Blocked`. Completed goals with residual runner failures show `Complete with warnings`. Problem line is short and node-centric. Full controller history no longer dominates the first screen. Active healthy goals show `Running` with clear runtime indicators.

## Assumptions

- None.

## Open Questions

- [ ] Should recent events fold count be configurable, or hard-coded to 3-8?
