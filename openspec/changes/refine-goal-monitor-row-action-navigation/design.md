## Context

The monitor now has live/list panes and drill-down scopes, but its global action row remains semantically disconnected from the selected list row. The user wants operations to live with the row being operated on:

- At the top level, the list is the controller row and its operations.
- `←/→` chooses an operation on that row.
- `Enter` confirms that operation.
- Navigating to node list and runner list follows the same row-operation pattern.

## Goals

- Remove the sense that controller actions are always globally selected.
- Make `Enter` always mean "confirm the selected row operation".
- Make node-list entry explicit via a controller row operation.
- In node-list scope, keep live empty so attention is on node execution rows.
- In runner-list scope, bind live output to the currently selected runner row.

## Decisions

### D1. Operations are row-scoped

**Choice**
- The header no longer renders selectable action buttons.
- The selected list row renders `ops:` with operation labels.
- `←/→` moves across those labels.
- `Enter` confirms the highlighted label.

**Rationale**
- This eliminates global controller action conflicts.
- The monitor becomes predictable: select row, select op, confirm.

### D2. Controller scope has one controller row

**Choice**
- Top-level list contains one controller row.
- Controller row operations include `nodeList`, plus valid controller lifecycle actions (`pause`, `resume`, `clear`, `openSession`, `close`).
- `nodeList` is first/default so `Enter` naturally enters the node list.

**Rationale**
- The user asked for the top list to display controller and controller operations, with an explicit way into node list.

### D3. Node-list scope has empty live pane

**Choice**
- Node-list scope renders no live detail.
- The list shows each node's execution status, runner count, latest runner status, update age, and model.
- Selected node row exposes `runnerList` and `back` operations.

**Rationale**
- The node list is an overview/selection mode. Live details become meaningful at runner scope.

### D4. Runner-list scope binds live to selected runner

**Choice**
- Runner-list scope lists all runners/subagents for the selected node.
- Moving the row selection changes the live pane to that runner's transcript/details.
- Selected runner row exposes `view` (no-op confirmation) and `back` operations.

**Rationale**
- The user wants runner live plus sibling runner list together.
- Future runner operations can be added to the runner row without changing the navigation model.

## Keyboard Model

- `↑/↓`: move selected list row when list-focused; scroll live when live-focused.
- `←/→`: select operation for current row.
- `Enter`: confirm selected row operation.
- `l`: focus list.
- `v`: focus live.
- `Tab`: toggle live/list focus.
- `b` or Backspace: go back one scope.
- `Esc`: close monitor.

## Follow-up

- Add runner process inventory and safe runner operations as row ops.
- Add monitor-driven stale validation reconcile operations as row ops.
