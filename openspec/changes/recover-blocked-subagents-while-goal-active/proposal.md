## Why

A DAG goal can remain `active` while a node/subagent is terminal `blocked`. In that state the controller currently stops making progress for that node: it does not re-sync the blocked subagent transcript, does not notice a later `SUBAGENT_RESULT`, and does not try a same-session recovery prompt. This left goal `a5224904` active with `implement-runtime-cleanup` blocked even though the same subagent session later reported a successful result and the expected outputs existed.

For active goals, `blocked` should not mean the controller gives up immediately. The controller should make best-effort recovery/reconcile attempts and only stop when the parent goal is no longer active, a provider/quota/external blocker is detected, or retry limits are exhausted.

## What Changes

- Sync blocked subagents during controller ticks so late transcript updates can be observed.
- If a blocked subagent later reports `SUBAGENT_RESULT`, validate/integrate/complete it like any other self-reported completion.
- If it remains blocked while the controller is polling an active goal, send a same-session recovery prompt up to the existing auto-retry cap.
- Preserve provider/quota blocker behavior: do not spawn replacements or keep prompting when quota/billing limits are the blocker.

## Impact

- Directly affected: `src/core/controller-loop.ts` and controller-loop tests.
- No workspace-specific policy assumptions are introduced.
- Existing retry caps still bound automatic follow-ups.
