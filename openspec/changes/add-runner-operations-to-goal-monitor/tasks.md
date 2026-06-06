## 1. Planning
- [x] Define runner row operations
- [x] Define temp-dir inventory matching strategy

## 2. Implementation
- [x] Add background runner inventory helper
- [x] Match temp runner dirs to durable subagent records
- [x] Add stop/kill/archive operation helpers
- [x] Add runner inventory to monitor snapshots
- [x] Render runner process counts/PID in runner rows
- [x] Add runner row operations: openSession, stop, kill, archive
- [x] Handle runner operations in Pi monitor command flow

## 3. Validation
- [x] Add monitor tests for runner row operations
- [x] Add runner inventory/archive helper tests
- [x] Run `npm run check`
- [x] Rebuild `source-manifest.json`
- [x] Generate and validate explainer
- [x] Run archive preflight

## 4. Follow-up Backlog
- [ ] [BACKLOG] Add DB reconcile operations with SQLite backups
- [ ] [BACKLOG] Add duplicate-runner bulk stop/archive operations
