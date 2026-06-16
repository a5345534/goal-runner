# Tasks: redesign-monitor-overview-dashboard

## 1. Overview Model

- [ ] 1.1 Define `GoalMonitorOverview` type with title, statusLabel, healthLabel, problemLabel, progressLabel, runtimeLabel, nextActionLabel, selectedDetail, and recentEvents fields.
- [ ] 1.2 Implement `buildGoalMonitorOverview()` deriving overview from goal + dag snapshot + runtime summary.
- [ ] 1.3 Extend `MonitorHealth` with `Complete`, `Complete with warnings`, `Running`.
- [ ] 1.4 Implement updated `deriveMonitorHealth()` with new taxonomy and priority order (goal.status first).
- [ ] 1.5 Implement `summarizeMonitorProblem()` producing node-centric short phrases, never full subagent IDs in overview.
- [ ] 1.6 Implement `formatRuntimeSummaryForOverview()` mapping internal state enums to user-facing labels.
- [ ] 1.7 Implement `formatNodeDisplayState()` for Execution Plan node status icons.
- [ ] 1.8 Optionally extract shared functions to `src/adapters/monitor-overview.ts`.

## 2. Pi TUI Rendering

- [ ] 2.1 Replace raw header with structured overview sections: Goal, Health/Problem, Progress, Runtime, Next Action.
- [ ] 2.2 Render Execution Plan with node display states and Selected Detail pane.
- [ ] 2.3 Render filtered Recent Events (3-8 meaningful events) instead of full controller history by default.
- [ ] 2.4 Keep full logs accessible via live/log pane or debug key.
- [ ] 2.5 Map action operation IDs to user-facing labels while preserving existing semantics.
- [ ] 2.6 Support 80-column narrow rendering that keeps key overview fields visible.
- [ ] 2.7 Ensure completed goal never shows `Health=Blocked`.

## 3. OpenCode Rendering

- [ ] 3.1 Group output into STATUS / SUMMARY / EXECUTION PLAN / RECENT EVENTS sections.
- [ ] 3.2 Render health, problem, progress, runtime, and next action with user-facing labels.
- [ ] 3.3 Use the same health taxonomy and problem summarizer as Pi TUI.
- [ ] 3.4 Ensure SUMMARY does not contain full long subagent IDs.

## 4. Tests

- [ ] 4.1 Pi: complete clean renders `Health=Complete`.
- [ ] 4.2 Pi: complete with residual failed runners renders `Complete with warnings`.
- [ ] 4.3 Pi: complete with warnings shows node-centric Problem line.
- [ ] 4.4 Pi: active healthy renders `Running`.
- [ ] 4.5 Pi: active blocked renders `Needs attention` with next action.
- [ ] 4.6 Pi: 80-column render keeps overview fields visible.
- [ ] 4.7 Pi: default screen shows recent events, not full live history.
- [ ] 4.8 Pi: full subagent ID only in selected detail / runner scope.
- [ ] 4.9 Pi: actions display user-facing labels but return existing operation IDs.
- [ ] 4.10 OpenCode: sections exist and health labels match.
- [ ] 4.11 OpenCode: runtime labels are user-facing.
- [ ] 4.12 OpenCode: SUMMARY does not contain long subagent IDs.

## 5. Verification / Closeout

- [ ] 5.1 Run focused Pi and OpenCode monitor tests.
- [ ] 5.2 Run `npm run check`.
- [ ] 5.3 Rebuild and commit affected `dist/` artifacts.
- [ ] 5.4 Refresh `source-manifest.json`.
- [ ] 5.5 Generate and validate `change-explainer.html`.
- [ ] 5.6 Confirm Stage 1 produced only OpenSpec sources.

## Backlog / Follow-ups

- [ ] [BACKLOG] Make recent events fold count configurable.
- [ ] [BACKLOG] Add trend/chart indicators for token usage over time.
