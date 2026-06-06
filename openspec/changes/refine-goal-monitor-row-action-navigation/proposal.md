## Why

The redesigned goal monitor introduced live/list drill-down, but lifecycle buttons remained globally visible and `Enter` could mean either drill-down or action confirmation depending on focus. This creates a conflict: goal-level operations feel always active even when the user is inspecting nodes/runners, and the user cannot reason about operations as properties of the current list row.

## What Changes

- Move monitor operations from a global top button row into the selected list row.
- Make `←/→` select the operation for the current row.
- Make `Enter` confirm the selected row operation.
- Top-level monitor scope lists a controller row with controller operations, including an explicit `nodeList` operation.
- Node-list scope shows no live detail; the list contains node execution rows, and each selected node row exposes a `runnerList` operation.
- Runner-list scope shows the currently selected runner's live transcript/details; the list shows all runners for the selected node.
- Preserve `Esc` close and `b`/Backspace back navigation.

## Capabilities

### New Capabilities
- Row-scoped monitor operations.
- Controller row with explicit node-list navigation.

### Modified Capabilities
- Pi goal monitor keyboard behavior.
- Pi goal monitor live/list scope model.

## Impact

- Directly affected:
  - `src/adapters/pi/monitor-ui.ts`
  - `src/tests/pi-monitor-ui.test.ts`
  - built `dist/` output
- Related but unchanged:
  - goal lifecycle command implementation
  - runner process management
  - DB reconcile behavior
  - controller scheduling/recovery

## Scope

### In
- Row-level action rendering and keyboard selection.
- Controller → node list → runner list navigation.
- Runner live changing with selected runner row.
- Tests for row-scoped operations.

### Out
- Destructive runner operations such as stop/kill/archive.
- DB reconcile actions.
- Mouse click support.
- Schema migrations.
