## 1. Planning
- [x] Confirm scope: runtime integration gate for subagent branches and final-audit enforcement.
- [x] Confirm project policy overlay assumptions via OpenSpec scaffold.
- [x] Define exact native-git integration strategy: native `git merge --no-ff --no-edit <sourceHead>`.
- [x] Define metadata schema for required/no-op integration decisions.

## 2. Implementation
- [x] Add integration metadata to core types and stores:
  - [x] subagent integration status (`pending`, `integrating`, `complete`, `failed`, `not-required`)
  - [x] source branch/ref/head and integrated commit evidence
  - [x] integration error/conflict summary
- [x] Add SQLite migrations and memory-store support.
- [x] Add native-git integration operation in controller completion flow.
- [x] Prevent node `complete` until required integration succeeds.
- [x] Prevent dependent scheduling/final audit when upstream integration is pending or failed.
- [x] Ensure `update_goal({status:"complete"})` refuses completion when any required integration is not terminal-successful.
- [x] Update Pi status/monitor to display integration state and blockers.
- [x] Update final-audit validation contracts so report existence alone is insufficient when violations remain.
- [x] Add manual recovery path for integration conflicts via persisted failure metadata and follow-up prompts.

## 3. Validation
- [x] Add unit tests for native-git integration success.
- [x] Add unit tests for merge/cherry-pick conflict producing blocked/needs-followup state.
- [x] Add regression test for false-complete prevention when subagent branch is not integrated.
- [x] Add regression test for final audit report with violations failing validation.
- [x] Run `npm run check`.
- [x] Validate source manifest freshness.
- [x] Generate and validate explainer before archive/review.

## 4. Documentation
- [x] Update README goal workflow notes.
- [x] Update `docs/goal-dag-format.md` for integration behavior and metadata.
- [x] Document manual recovery of integration conflicts and false-complete prevention behavior.

## 5. Follow-up backlog
- [ ] [BACKLOG] Add planner hints for integration-required vs report-only nodes.
- [ ] [BACKLOG] Extend integration backend for non-Pi/non-native-git adapters.
- [ ] [BACKLOG] Add UI affordance to inspect and resolve integration conflicts from `/goal monitor`.
