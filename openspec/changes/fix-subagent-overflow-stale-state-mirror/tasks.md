## 1. Planning
- [x] Diagnose live Goal `0c3af931` stale context-overflow behavior
- [x] Identify runtime mirror timestamp interaction with stale detection

## 2. Implementation
- [x] Ignore `agent-goal-runtime-state` custom entries for Pi subagent activity classification
- [x] Add regression coverage for stale context overflow with later mirror entries

## 3. Validation
- [x] Run focused build and Pi subagent adapter tests
- [x] Run full project validation
- [x] Generate/update explainer and source manifest
- [x] Validate explainer, source manifest, and archive preflight

## 4. Live Recovery Notes
- [x] Back up live runtime DB before repair
- [x] Stop stale context-overflow runner processes
- [x] Start fallback-model recovery attempts
- [x] Repair new subagent worktree submodules to controller gitlinks
- [x] Stop duplicate replacement runner and mark it superseded
- [x] Resume retained replacement sessions with same-session follow-up prompts
