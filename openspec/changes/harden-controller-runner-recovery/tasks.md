## 1. Planning
- [x] Capture current operational blockers and recurring failure modes.
- [x] Define in-scope runtime hardening.

## 2. Implementation
- [x] Add Pi runner inventory preflight for terminal/duplicate runners.
- [x] Add bounded replacement recovery for repeated `terminated` errors.
- [x] Add cooldown for repeated identical `recovery.blocked` ledger events.
- [x] Rebuild committed `dist/`.

## 3. Validation
- [x] Add/update tests.
- [x] Run `npm run check`.
- [x] Validate OpenSpec source manifest.

## 4. Follow-up backlog
- [ ] [BACKLOG] Structured validator cwd contract and planner support.
- [ ] [BACKLOG] Durable per-node attempt table to separate attempts from subagent terminal status.
