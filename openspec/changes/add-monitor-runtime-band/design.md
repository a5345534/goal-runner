# Design: add-monitor-runtime-band

## Context

Issue #40 requests that `/goal monitor` clearly separate three runtime layers that are currently conflated in the display: original controller session activity, hidden continuation status, and controller polling lifecycle. The monitor already has access to all the underlying data (harness state, continuation reservations, controller events, subagent records), but it does not present a derived at-a-glance summary.

This change adds a presentation-layer view model and updates both adapter monitors without modifying runtime semantics.

## Spec Kernel

- Why: users cannot diagnose goal execution health from the monitor first screen.
- Value gate outcome: `proceed_to_spec` with smaller scope (presentation only).
- Capabilities:
  - `goal-monitor-runtime-band`: derived runtime-state summary model surfaced in Pi TUI and OpenCode monitors.
- Constraints:
  - Runtime summary is derived from existing state, never a new source of truth.
  - No controller/scheduler/continuation semantics change.
  - Monitor row actions (nodeList, runnerList, pause, resume, clear, openSession, stop, kill, archive) remain unchanged.
- Non-goals: controller semantics, continuation semantics, subagent lifecycle, contract/dag/spec changes.
- Success signal: first screen shows Session/Hidden/Poll/Runners; active session + suppressed continuation is clearly normal.

## Goals

- Derive a single `GoalMonitorRuntimeSummary` from existing runtime and adapter state.
- Display it as a compact runtime band in Pi TUI and as structured sections in OpenCode.
- Make active-original-session + suppressed-hint-continuation clearly not a failure state.
- Show runner counts at overview level without entering runner scope.
- Add a derived health line and one-line next-action recommendation.

## Non-Goals

- Do not change controller loop scheduling.
- Do not change hidden continuation launch or eligibility rules.
- Do not change subagent state machine.
- Do not add new destructive actions.
- Do not implement a full health-scoring engine.
- Do not change goal-contract/goal-dag/goal-spec.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Derived state accuracy | A wrong runtime summary could mislead users more than no summary. | Build from existing trusted state: harness state, continuation reservations, controller events, subagent records. |
| Terminology consistency | Pi TUI and OpenCode must not diverge. | Share the same `GoalMonitorRuntimeSummary` model and rendering constants. |
| Monitor performance | Snapshot must be cheap and synchronous. | No additional async calls; derive from already-loaded state. |
| Active session confusion | Users currently misread healthy active+suppressed as stuck. | Explicitly label suppressed with reason; show health line as OK when poll+runners are active. |

## Decisions

### D0. Value path

**Choice**
Proceed to spec with smaller-scope: runtime band display, no health-scoring engine.

**Rationale**
The immediate UX gap is that users cannot read the three runtime layers from the raw data. Adding a derived summary fixes this. A full health engine (scoring, trend analysis, pattern matching) adds complexity without direct user value for the first iteration.

**Alternatives considered**
- No-build: rejected — documentation does not fix the at-a-glance diagnostic problem.
- Full health engine: deferred as backlog.

### D1. View model, not new runtime state

**Choice**
`GoalMonitorRuntimeSummary` is a pure derived type, built synchronously from already-loaded `GoalOrchestrationState`, `HarnessState`, continuation reservations, and subagent records.

**Rationale**
The monitor already loads all this data. Adding a derived view model avoids a new persistence surface or async refresh path.

### D2. Shared rendering constants

**Choice**
Export canonical state labels (e.g., `HIDDEN_CONTINUATION_STATE_LABELS`, `CONTROLLER_POLL_STATE_LABELS`) from the monitor module or a shared constants file so both adapters use identical terminology.

**Rationale**
Pi TUI and OpenCode text monitor should show the same state names to avoid user confusion.

### D3. Defensive rendering for narrow terminals

**Choice**
Pi TUI runtime band uses at most 3 compact lines, with `key=value` pairs separated by double spaces. Labels are kept short (e.g., `Session`, `Hidden`, `Poll`, `Runners`).

**Rationale**
Pi TUI can have narrow splits. Long key=value chains break layout.

## Detailed Design

### Data / Contract Changes

New internal type (in `src/adapters/pi/monitor-ui.ts` or a shared module):

```ts
interface GoalMonitorRuntimeSummary {
  session: {
    state: "active-turn" | "idle" | "missing" | "not-materialized" | "unknown";
    activeTurnId?: string;
  };
  hiddenContinuation: {
    state: "eligible" | "suppressed" | "reserved" | "started" | "not-configured" | "not-eligible" | "unknown";
    reason?: string;
    attemptId?: string;
  };
  controllerPoll: {
    state: "active" | "leased" | "skipped" | "stopped" | "unknown";
    reason?: string;
    leaseOwner?: string;
    lastPollAt?: string;
  };
  runners: {
    running: number;
    stopped: number;
    duplicateStopped: number;
    archived: number;
    failed: number;
  };
}
```

No persistence or schema change. No goal-contract change.

### Execution Flow

1. Monitor snapshot is read (existing: `readPiGoalMonitorSnapshot` / `readOpencodeGoalMonitorSnapshot`).
2. `buildGoalMonitorRuntimeSummary(state, harnessState, reservations, subagents)` derives the summary synchronously.
3. Pi TUI renders the summary as a 2-3 line runtime band before the execution plan.
4. OpenCode renders the summary as `RUNTIME` section between `STATUS` and `PROGRESS`.
5. Health line and next action are derived and rendered.

### Module Boundaries

- `src/adapters/pi/monitor-ui.ts`: Pi TUI runtime band rendering.
- `src/adapters/opencode/monitor-ui.ts`: OpenCode structured section rendering.
- Shared types/constants may live in either module or a small shared helper; no new core module required.

### Migration / Rollout

No migration required. Display-only change. Existing row actions continue to work unchanged.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Derived state may misclassify edge cases | Low | Build from existing tested state; use defensive defaults (e.g., "unknown" for unobservable states). |
| Narrow terminal layout may wrap or truncate | Low | Limit to 2-3 short lines; test with 80-column terminal width. |
| Health line may suggest false confidence | Medium | Keep health conservative: only "OK" when all signals are green; default to "Needs attention" for anything ambiguous. |

## Verification Plan

- Pi monitor unit tests: active session + suppressed continuation renders correctly; blocked node shows needs-attention; running runners show correct counts; narrow width rendering.
- OpenCode monitor unit tests: output includes STATUS/RUNTIME/PROGRESS/NEXT ACTION sections; active session renders as expected; runner counts before details.
- `npm run check`.

## Execution Handoff Notes

### Candidate Execution Slices

- Runtime summary type and builder: `GoalMonitorRuntimeSummary` + `buildGoalMonitorRuntimeSummary()`.
- Pi TUI runtime band rendering.
- OpenCode structured section rendering.
- Health line and next-action derivation.
- Tests and documentation.

### Ordering / Dependency Evidence

- Pi/OpenCode rendering depend on the summary builder.
- Tests depend on the summary builder + rendering.
- No dependency on other pipeline stages.

### Validation Signals

- `npm run check`
- Monitor unit tests for both adapters

### Non-Goals for Execution

- Do not change controller loop, continuation, or subagent lifecycle.
- Do not change goal-contract/goal-dag/goal-spec.
- Do not add new destructive monitor actions.
