# Design: redesign-monitor-overview-dashboard

## Context

Current monitor renders raw state in a single long header. Users see `Health=Blocked` for completed goals, raw subagent IDs in problem lines, and 18 lines of controller history before any overview. The design spec (provided directly) defines a structured overview-first layout with wireframes for both Pi TUI and OpenCode.

## Spec Kernel

- Why: monitor first screen must answer "is it done, is it healthy, what's the problem" at a glance.
- Value gate outcome: `proceed_to_spec`
- Capabilities:
  - `goal-monitor-overview-dashboard`: overview-first monitor layout with structured sections, corrected health semantics, and user-facing labels.
- Constraints:
  - No controller/scheduler/continuation semantics change.
  - Existing row actions preserved (operation IDs unchanged, labels mapped).
  - Pi TUI and OpenCode share health/problem/runtime vocabulary.
- Non-goals: controller semantics, continuation, subagent lifecycle, new actions, web UI.
- Success signal: completed goal never shows `Health=Blocked`; problem line is node-centric; first screen is overview-first.

## Goals

- Replace raw header with structured overview sections.
- Fix health to never show `Blocked` for completed goals.
- Summarize problems to node-centric short phrases.
- User-facing runtime labels.
- Move full logs off first screen; show recent events only.
- Execution Plan and Selected Detail on first screen.
- User-facing action labels.

## Non-Goals

- No runtime semantics change.
- No new destructive actions.
- No goal-contract/goal-dag/goal-spec changes.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Health semantics drift | `Health=Blocked` for complete goals misleads users. | New taxonomy with `Complete` / `Complete with warnings` priority. |
| Problem readability | Raw subagent IDs are unreadable. | Summarize to node slug + short reason phrase. |
| Log dominance | 18 live history lines hide overview. | Default mode shows 3-8 recent events; full logs on demand. |
| Terminology consistency | Pi and OpenCode must not diverge. | Shared health labels, runtime mappers, event filters. |
| Terminal width | 80-column Pi splits must remain readable. | Two rendering modes; compact labels for narrow mode. |
| Row action compatibility | Existing keyboard nav must not break. | Labels mapped, operation IDs unchanged. |

## Decisions

### D0. Value path

**Choice**
Proceed to spec: display/view-model refinement only.

**Rationale**
The monitor already has all the data. The gap is purely presentation-layer. No runtime behavior needs to change.

### D1. New health taxonomy

**Choice**
Extend `MonitorHealth` with `Complete`, `Complete with warnings`, and `Running`. Priority order: goal status first, then node/subagent status, then runtime activity.

**Rationale**
Current taxonomy conflates terminal state with runtime health. A completed goal must never show `Blocked`.

### D2. Overview model, not inline rendering

**Choice**
Add `buildGoalMonitorOverview()` that returns a structured `GoalMonitorOverview` object. Both adapters render from this model.

**Rationale**
Keeps health/problem/runtime logic centralized and testable.

### D3. Recent events filter

**Choice**
Default compact mode shows 3-8 meaningful events, filtering out poll/sync/recovery noise. Full history available in debug mode.

**Rationale**
Users don't need to see every poll.started event. Meaningful events (goal.blocked, validation.failed, subagent.result) are what drive decisions.

### D4. Shared module extraction

**Choice**
Optionally extract shared pure functions to `src/adapters/monitor-overview.ts` so both Pi and OpenCode import from a neutral location.

**Rationale**
Pi monitor-ui.ts is already large. Shared overview functions (health, problem, runtime labels, event filters) should not force OpenCode to import from Pi adapter.

## Detailed Design

### Data / Contract Changes

New types in monitor-overview.ts or monitor-ui.ts:

- `GoalMonitorOverview` — structured overview fields
- `MonitorHealth` extended with `"Complete"`, `"Complete with warnings"`, `"Running"`
- `buildGoalMonitorOverview()` — main builder
- `deriveMonitorHealth()` — updated with new priority order
- `summarizeMonitorProblem()` — node-centric short phrase
- `formatRuntimeSummaryForOverview()` — user-facing labels
- `formatRecentEvents()` — filtered meaningful events
- `formatNodeDisplayState()` — node/subagent combined state
- `ACTION_DISPLAY_LABELS` — user-facing action labels map

No persistence or schema change.

### Execution Flow

1. Monitor snapshot loaded (existing).
2. `buildGoalMonitorRuntimeSummary()` called (existing).
3. `buildGoalMonitorOverview()` derives overview from goal + dag + runtimeSummary.
4. Render: overview sections → execution plan → selected detail → recent events → actions.
5. Full logs only when user switches to live/log pane or presses debug key.

### Module Boundaries

- `src/adapters/monitor-overview.ts` (new, optional): shared overview builder, health, problem, runtime, events.
- `src/adapters/pi/monitor-ui.ts`: Pi TUI overview rendering.
- `src/adapters/opencode/monitor-ui.ts`: OpenCode overview rendering.

### Migration / Rollout

No migration. Display-only change. Row actions unchanged.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Health semantics change may surprise existing users | Low | New labels are clearer; old `Blocked`+`complete` was the bug. |
| Narrow terminal may not fit new layout | Low | Separate wide/narrow rendering tested at 80 columns. |
| Event filter may hide important events | Low | Default filter is conservative; full logs available on demand. |

## Verification Plan

- Pi monitor unit tests for all health states, problem summarization, runtime labels, event filtering, narrow rendering.
- OpenCode monitor unit tests for sections, health labels, problem labels.
- Manual visual check against wireframes.
- `npm run check`.

## Execution Handoff Notes

### Candidate Execution Slices

- Overview model + health taxonomy + problem summarizer (pure functions, testable independently).
- Pi TUI overview rendering (depends on model).
- OpenCode overview rendering (depends on model, parallel with Pi).
- Recent events filter + display.
- Action label mapping.
- Tests and documentation.

### Ordering / Dependency Evidence

- Pi/OpenCode rendering depend on overview model.
- Tests depend on model + rendering.
- No dependency on other pipeline stages.

### Validation Signals

- `npm run check`
- Visual comparison with provided wireframes

### Non-Goals for Execution

- Do not change controller/scheduler/continuation semantics.
- Do not change goal-contract/goal-dag/goal-spec.
