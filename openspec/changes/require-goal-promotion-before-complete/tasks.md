## 1. Planning
- [x] Confirm desired terminal semantics: complete means promoted to target branch and cleaned up
- [x] Confirm fail-closed policy for dirty target/conflicts

## 2. Implementation
- [x] Add native-git controller branch promotion gate
- [x] Add controller/subagent worktree and branch cleanup after promotion
- [x] Preserve diagnostics/artifacts on blocked promotion
- [x] Wire Pi DAG finalization through promotion before `complete`

## 3. Validation
- [x] Add success and blocked promotion tests
- [x] Run focused tests
- [x] Run `npm run check`
- [x] Build/update `dist/`
- [x] Build and validate OpenSpec source manifest / explainer / archive preflight

## 4. Follow-up backlog
- [ ] [BACKLOG] Add monitor operation to manually promote/retry blocked goal closeout
- [ ] [BACKLOG] Rerun full post-promotion validators on the target branch before final `complete`
