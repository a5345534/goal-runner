# Tasks: close-required-evidence-contract

## 1. Spec and Contract

- [ ] 1.1 Add a canonical supported evidence-token source in `src/core/validation-evidence.ts` or an equivalent shared core module.
- [ ] 1.2 Change `GoalValidationEvidenceRequirement` to a closed union derived from the supported token list.
- [ ] 1.3 Update `GoalDagValidationContract.requiredEvidence` call sites to use the closed type without accepting arbitrary strings.
- [ ] 1.4 Update `schemas/goal-dag.schema.json` so `validation.requiredEvidence` is an enum-backed array with `uniqueItems: true`.
- [ ] 1.5 Confirm no runtime API, persisted state, or package export still documents `requiredEvidence` as arbitrary prose.

## 2. Parser and Runtime Implementation

- [ ] 2.1 Add `parseRequiredEvidence()` in `src/core/dag-file.ts` and reject unsupported tokens with a clear supported-token/error-remediation message.
- [ ] 2.2 Use `parseRequiredEvidence()` from `parseValidationContract()` instead of generic string-array parsing.
- [ ] 2.3 Add an unsupported-evidence guard at the start of `runControllerValidation()` for already-persisted invalid DAG state.
- [ ] 2.4 Ensure the runtime guard returns `status: "blocked"`, records useful validation signals, and does not include `followupPrompt`.
- [ ] 2.5 Ensure unsupported evidence never counts as high-risk implementation validation coverage.
- [ ] 2.6 Preserve existing supported-token behavior, including `post-merge-validation-ran` deferral to native Git post-merge integration.

## 3. Documentation

- [ ] 3.1 Update `docs/goal-dag-format.md` to state that `requiredEvidence` is a closed controller-enforced token list.
- [ ] 3.2 Replace “unknown labels fail closed” wording with parse-time rejection plus runtime old-state guard behavior.
- [ ] 3.3 Add guidance that natural-language checks belong in validators, audit reports, objective/scope, path policy, or producer trace/review metadata.
- [ ] 3.4 Update `README.md` and `docs/pipeline-boundaries.md` if they mention evidence semantics or producer/runtime boundaries.

## 4. Tests

- [ ] 4.1 Add parser tests showing all supported evidence tokens are accepted.
- [ ] 4.2 Add parser tests rejecting `requiredEvidence: ["pnpm test passes"]` with a clear unsupported-token message.
- [ ] 4.3 Add schema validation coverage or direct schema assertions proving unsupported evidence is rejected by schema.
- [ ] 4.4 Add validation-runner coverage for already-loaded invalid node state: `blocked` result and no `followupPrompt`.
- [ ] 4.5 Add high-risk implementation coverage proving unsupported evidence is invalid contract data, not validation coverage.
- [ ] 4.6 Add docs/example coverage so runtime DAG examples use only supported evidence tokens.

## 5. Verification / Closeout

- [ ] 5.1 Run focused parser/schema/validation-runner tests.
- [ ] 5.2 Run `npm run check`.
- [ ] 5.3 Rebuild and commit affected `dist/` artifacts required by package consumers.
- [ ] 5.4 Refresh `source-manifest.json`.
- [ ] 5.5 Generate and validate `change-explainer.html` with the decision-review validator.
- [ ] 5.6 Confirm Stage 1 produced only OpenSpec package sources and did not generate downstream execution-plan artifacts.

## Backlog / Follow-ups

- [ ] [BACKLOG] Create a separate change for the periodic controller audit agent described in issue #39 if/when the deterministic contract fix has landed and the remaining retry/cost-watchdog need is still valuable.
- [ ] [BACKLOG] Update the separate `goal-dag` repository so Stage 2 producer schema/skill/docs reject natural-language `validation.requiredEvidence` before writing runtime DAG output.
