## 1. Implementation
- [x] Sync blocked subagents during active controller ticks
- [x] Reconcile late successful subagent results after blocked state
- [x] Send bounded same-session recovery prompts for still-blocked subagents
- [x] Preserve provider/quota blocker stop behavior

## 2. Tests
- [x] Add regression test for late `SUBAGENT_RESULT` after blocked state
- [x] Add regression test for active-goal blocked recovery prompt
- [x] Add regression test for quota blocker no-prompt behavior

## 3. Validation
- [x] Run project check
- [x] Build committed dist artifacts
- [x] Refresh and validate source manifest
