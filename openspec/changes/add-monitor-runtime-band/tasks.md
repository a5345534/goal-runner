# Tasks: add-monitor-runtime-band

## 1. Spec and Contract

- [ ] 1.1 Define `GoalMonitorRuntimeSummary` type and `buildGoalMonitorRuntimeSummary()` builder.
- [ ] 1.2 Define shared rendering constants for canonical state labels.
- [ ] 1.3 Add health-line and next-action derivation logic.

## 2. Pi TUI Monitor

- [ ] 2.1 Render a compact runtime-state band above the execution plan in the Pi goal monitor.
- [ ] 2.2 Show `Session`, `Hidden` (with reason), `Poll`, and `Runners` states in the band.
- [ ] 2.3 Ensure narrow terminal widths (e.g., 80 columns) do not truncate key runtime-state information.
- [ ] 2.4 Keep existing controller live pane, node list, runner list, and row actions unchanged.

## 3. OpenCode Monitor

- [ ] 3.1 Group OpenCode snapshot output into `STATUS`, `RUNTIME`, `PROGRESS`, and `NEXT ACTION` sections.
- [ ] 3.2 Render runtime summary including session, hidden continuation, poll, and runner counts.
- [ ] 3.3 Show runner count summary before per-runner details.
- [ ] 3.4 Render healthy active states without implying failure.

## 4. Tests

- [ ] 4.1 Pi monitor: active session + suppressed continuation renders correctly.
- [ ] 4.2 Pi monitor: blocked node shows `Needs attention` and next-action points to the blocked node.
- [ ] 4.3 Pi monitor: running runners with active session do not render as stalled.
- [ ] 4.4 Pi monitor: narrow width rendering truncates without hiding runtime state.
- [ ] 4.5 OpenCode monitor: output has STATUS / RUNTIME / PROGRESS / NEXT ACTION sections.
- [ ] 4.6 OpenCode monitor: active session + suppressed continuation renders as expected.
- [ ] 4.7 OpenCode monitor: blocked node changes health and next action.

## 5. Verification / Closeout

- [ ] 5.1 Run focused Pi and OpenCode monitor tests.
- [ ] 5.2 Run `npm run check`.
- [ ] 5.3 Rebuild and commit affected `dist/` artifacts.
- [ ] 5.4 Refresh `source-manifest.json`.
- [ ] 5.5 Generate and validate `change-explainer.html`.
- [ ] 5.6 Confirm Stage 1 produced only OpenSpec sources.

## Backlog / Follow-ups

- [ ] [BACKLOG] Add a health-scoring engine with trend analysis and pattern detection for future monitor iterations.
- [ ] [BACKLOG] Add a "what to do next" action panel beyond the one-line recommendation.
