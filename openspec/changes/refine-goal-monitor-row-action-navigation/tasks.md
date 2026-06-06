## 1. Planning
- [x] Capture row-scoped operation UX
- [x] Define controller/node/runner scopes

## 2. Implementation
- [x] Remove globally selectable action buttons from monitor header
- [x] Add row operation model and per-row operation selection
- [x] Add controller top-level row with `nodeList` and lifecycle operations
- [x] Change node-list scope live pane to empty/no-detail mode
- [x] Add selected node `runnerList` operation
- [x] Change runner-list scope live pane to track selected runner row
- [x] Keep `b`/Backspace and `Esc` navigation

## 3. Validation
- [x] Update tests for controller row operations
- [x] Update tests for node-list empty live + runnerList operation
- [x] Update tests for runner-list selected-row live switching
- [x] Run `npm run check`
- [x] Rebuild `source-manifest.json`
- [x] Generate and validate explainer
- [x] Run archive preflight

## 4. Follow-up Backlog
- [ ] [BACKLOG] Add runner stop/kill/archive operations as runner row ops
- [ ] [BACKLOG] Add DB reconcile operations as node/controller row ops
