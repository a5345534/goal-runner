# close-required-evidence-contract

## Why

Issue [#39](https://github.com/a5345534/goal-runner/issues/39) documents a controller validation retry loop caused by an invalid runtime DAG contract: `validation.requiredEvidence` accepts arbitrary strings, but the controller can only mechanically satisfy a fixed token set. Natural-language entries such as `"pnpm test passes"` are therefore valid at schema/type/parser boundaries but impossible to satisfy at runtime.

This matters now because the observed `final-verification` node repeatedly self-reported successful verification while controller validation kept issuing the same missing-evidence follow-up, spawning repeated retry sessions and consuming time/tokens without a path to success.

## Value Gate

- Outcome: `proceed_to_spec`
- No-build considered: Rejected. Documentation-only guidance would not prevent invalid DAGs from being accepted, and it would not protect already-persisted invalid DAG state.
- Smaller-scope considered: Selected. This change covers the immediate `goal-runner` deterministic runtime fix only. The periodic controller audit agent proposed in the issue is a separate follow-up safety layer and must not block this contract correction.
- Assumption posture: Confirmed from issue #39 discussion and current source inspection; no `[ASSUMPTION]` claims are required for this runtime fix.

## What Changes

- Define a single supported evidence-token registry for controller-enforced `requiredEvidence` values.
- Close the TypeScript runtime contract so `GoalValidationEvidenceRequirement` no longer accepts arbitrary strings.
- Update `schemas/goal-dag.schema.json` so `validation.requiredEvidence` is an enum-backed, unique array.
- Reject unsupported evidence tokens during DAG parsing/loading with a producer-actionable error.
- Add a runtime validation guard for old persisted DAG state that still contains unsupported evidence tokens; it blocks without sending a subagent follow-up prompt.
- Update docs and tests so natural-language acceptance checks are represented as validators, audit reports, objective/scope, path policy, or producer trace/review metadata—not `requiredEvidence`.

## Impact

- Affected specs: `goal-dag-validation-contract`
- Affected modules/repos: `goal-runner` core runtime, DAG parser, validation runner, schema, docs, tests, built package artifacts.
- Affected APIs/events/data: Runtime DAG JSON `validation.requiredEvidence` becomes a closed controller-enforced token list; legacy persisted invalid state is detected at validation time.
- Migration/deployment impact: Existing valid DAGs using supported tokens continue to work. Invalid DAG files now fail fast at load time; previously persisted invalid nodes block at controller validation without subagent retry.
- User-visible impact: Users receive deterministic invalid-contract errors instead of impossible validation follow-up loops.

## Non-Goals

- Do not implement transcript matching for arbitrary evidence strings.
- Do not implement model-based evidence satisfaction.
- Do not treat subagent self-report as validation authority.
- Do not ingest OpenSpec packages, PRDs, or goal-dag trace sidecars as runtime evidence.
- Do not modify the Stage 2 `goal-dag` producer in this `goal-runner` change.
- Do not implement the periodic controller audit agent in this immediate change.

## Pipeline Handoff Boundary

- Stage 1 output: governed OpenSpec sources only.
- Downstream consumer: `goal-dag` reads `source-manifest.json` plus the authoritative markdown/spec sources.
- No Goal DAG JSON or execution runtime plan is produced by this package.

## Success Signal

A runtime DAG containing `validation.requiredEvidence: ["pnpm test passes"]` is rejected at parse/load time with a clear supported-token message; an already-persisted node containing the same unsupported token returns controller validation `blocked` with no `followupPrompt`; all supported evidence tokens still parse, persist, and validate through `npm run check`.

## Assumptions

- None.

## Open Questions

- [ ] None.
