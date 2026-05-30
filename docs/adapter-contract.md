# Adapter contract

A full adapter connects the portable runtime to a host harness.

## Required responsibilities

1. Register `/goal` command forms.
2. Resolve a stable materialized session key.
3. Wire a persistent store.
4. Register model-visible `get_goal`, `create_goal`, and `update_goal` tools.
5. Map host lifecycle events into runtime hooks.
6. Implement hidden continuation through `startHiddenGoalTurn`.
7. Show visible goal update/clear/status feedback.
8. Provide a smoke/conformance report.

## Hidden turn callback

`startHiddenGoalTurn(request)` receives:

- `attemptId` — runtime idempotency key
- `sessionKey`
- `goalId`
- `goalUpdatedAt` observed during eligibility checks
- `attemptCount`
- `hiddenContextKind: "goal_continuation"`
- `renderedPrompt`
- optional `policyContext`

It returns one of:

- `started`
- `alreadyStarted`
- `skipped`
- `retryableFailure`
- `fatalFailure`

Rules:

- At most one hidden continuation reservation may be outstanding per session.
- The adapter must treat `attemptId` as idempotent.
- User input wins: queued user input returns `skipped` and is not retried until a later lifecycle event.
- Retryable failures use bounded retry. V0 default: max 3 attempts per reservation.
- Fatal/skipped outcomes do not mark a goal complete or blocked.
- Stale goal versions must not launch hidden continuation.

## Pi adapter status

The included Pi adapter maps:

- slash commands through `pi.registerCommand("goal", ...)`, including `/goal --tokens <budget> <objective>` with `k` / `m` suffix parsing
- model tools through `pi.registerTool(...)`
- turn/tool lifecycle through Pi events
- ordinary-turn active goal reminders through `before_agent_start`
- hidden continuation through `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`
- stale hidden continuation filtering through the Pi `context` hook
- aborted/error turn handling by pausing the active goal until `/goal resume`
- blocked updates through transcript-aware evidence derived from recent failed tool results or explicit blocked/cannot-proceed assistant text

The blocked audit does not add model-visible fields to `update_goal`; the tool still only accepts `complete` or `blocked`. The adapter computes evidence out-of-band and passes it to the runtime so a first failure or mismatched recent blockers cannot be marked as strictly blocked.

Other harness adapters are intentionally deferred to separate changes.
