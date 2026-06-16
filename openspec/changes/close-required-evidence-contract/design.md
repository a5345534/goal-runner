# Design: close-required-evidence-contract

## Context

Issue #39 exposed a Stage 3 runtime contract mismatch. `validation.requiredEvidence` is controller-enforced, but current source permits arbitrary strings via an open TypeScript union and generic schema string arrays. `runControllerValidation()` only satisfies a fixed set of evidence tokens; unknown strings fall through as missing evidence. In the observed `final-verification` retry loop, natural-language checks were accepted into the DAG, validators passed, and the controller still reissued impossible follow-up prompts.

The change is a deterministic runtime hardening for `goal-runner`. It complements—but does not implement—the Stage 2 `goal-dag` producer alignment and the separate periodic controller audit follow-up discussed in the issue.

## Spec Kernel

- Why: prevent impossible controller validation contracts from turning invalid runtime DAG state into retry loops and token/cost waste.
- Value gate outcome: `proceed_to_spec` with smaller immediate scope.
- Capabilities:
  - `goal-dag-validation-contract`: runtime DAGs expose only mechanically satisfiable `requiredEvidence` tokens and block old invalid state without subagent retry.
- Constraints:
  - `goal-runner` remains the Stage 3 source of truth for runtime DAG schema, parser, and controller validation semantics.
  - Evidence satisfaction must be deterministic and controller-owned.
  - Natural-language acceptance checks must not be satisfied by transcript matching or subagent self-report.
  - The immediate change must not include the periodic controller audit agent.
- Non-goals:
  - Transcript matching, model-based evidence satisfaction, trace/OpenSpec ingestion, planner behavior, Stage 2 producer implementation, and periodic audit.
- Success signal: parse-time rejection for unsupported evidence, runtime blocked/no-followup guard for old invalid state, and preserved behavior for all supported tokens.

## Goals

- Make supported `requiredEvidence` tokens explicit and reusable.
- Fail fast when runtime DAG files contain unsupported required evidence.
- Protect legacy/persisted invalid DAG state without asking subagents to fix immutable runtime contracts.
- Preserve existing valid evidence behavior including post-merge validation deferral.
- Give producers and users clear field-mapping guidance for natural-language checks.

## Non-Goals

- Do not implement transcript matching or text-search evidence satisfaction.
- Do not let subagent summaries satisfy arbitrary `requiredEvidence` strings.
- Do not modify DAG planning, node decomposition, model routing, or scheduler behavior.
- Do not change `goal-dag` producer code in this repository.
- Do not implement periodic controller audit in this change.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Runtime contract compatibility | Closing an open string union is intentionally stricter and may reject previously accepted invalid DAGs. | Fail fast with actionable parse errors and provide an old-state runtime guard. |
| Retry-loop safety | Unsupported tokens currently produce recoverable validation failures and subagent follow-ups. | Invalid contracts become `blocked` with no `followupPrompt` because subagents cannot repair the DAG contract. |
| Source-of-truth drift | Supported token lists currently appear in types, validation logic, docs, and schema. | Add a single TypeScript token registry and keep schema/docs/tests aligned with it. |
| Producer boundary | Natural-language checks still need a place to live. | Document mappings to validators, audit reports, objective/scope, path policy, and producer trace/review metadata. |
| Post-merge evidence | `post-merge-validation-ran` is intentionally not satisfied by ordinary pre-integration validation. | Preserve current deferral semantics while still allowing the token in the closed enum. |
| Follow-up audit feature | Issue #39 also proposes a periodic diagnostic watchdog. | Defer as backlog/separate change; it is not required to close the known invalid-contract bug. |

## Decisions

### D0. Value path

**Choice**
Proceed to spec for the deterministic runner-side contract fix, using the smaller scope that excludes periodic controller audit and Stage 2 producer changes.

**Rationale**
This is the minimum change that prevents the known retry loop: reject impossible contracts before execution and block old invalid state. No-build documentation alone cannot stop invalid DAG load or legacy state retry. Bundling periodic audit would delay the direct bug fix and mix a deterministic contract correction with a broader diagnostic feature.

**Alternatives considered**
- No-build: rejected because docs cannot enforce runtime safety.
- Larger scope with periodic audit: deferred because audit protects unknown future patterns but is not necessary for this known invalid-contract class.
- Stage 2 producer changes here: deferred to the `goal-dag` repository because `goal-runner` owns runtime enforcement, not producer authoring.

### D1. Shared supported evidence registry

**Choice**
Add a small shared runtime source of truth, for example `src/core/validation-evidence.ts`, exporting:

- `SUPPORTED_REQUIRED_EVIDENCE`
- `GoalValidationEvidenceRequirement`
- `SUPPORTED_REQUIRED_EVIDENCE_SET`
- `isSupportedRequiredEvidence(value)`

Supported tokens are:

```text
validators-ran
locked-artifacts-unchanged
implementation-diff-present
non-test-diff-present
post-merge-validation-ran
audit-report-present
```

**Rationale**
A central registry prevents duplicated lists from drifting across parser, validation runner, tests, docs, and future adapters.

**Alternatives considered**
- Keep the type in `types.ts` only: lower file count but less clear ownership and harder to import without broad type dependencies.
- Leave `| string`: rejected because it encodes the bug as a valid type.

### D2. Parser and schema reject unsupported tokens

**Choice**
Update `schemas/goal-dag.schema.json` to use an enum-backed `requiredEvidence` array with `uniqueItems: true`, and update `parseValidationContract()` to call a dedicated `parseRequiredEvidence()` helper.

**Rationale**
Parse/load time is the earliest safe boundary for user-authored runtime DAGs. The parser can produce an actionable message before any subagent work starts.

**Alternatives considered**
- Let schema catch it only: rejected because runtime parser is the authoritative loader and must protect callers that do not run JSON Schema validation.
- Permit unknown strings and fail closed during validation: rejected because it can still launch subagents into impossible retry work.

### D3. Old-state runtime guard blocks without follow-up

**Choice**
At the start of `runControllerValidation()`, detect unsupported persisted `requiredEvidence` tokens and return a blocked result with validation signals but no `followupPrompt`.

**Rationale**
SQLite or in-memory state created before this change may still contain invalid tokens. Subagents cannot repair a malformed runtime DAG contract; a follow-up prompt would recreate the incident.

**Alternatives considered**
- Send a follow-up asking the subagent to explain or satisfy the missing evidence: rejected because it treats invalid controller state as executable work.
- Mark complete if validators passed: rejected because unsupported evidence is invalid contract coverage, not satisfied evidence.

### D4. High-risk validation policy ignores unsupported evidence

**Choice**
Only supported evidence tokens count toward high-risk implementation validation coverage. Unsupported tokens are invalid contract data and must not be treated as coverage for `kind=implementation` high-risk nodes.

**Rationale**
The high-risk guard exists to prevent self-report-only completion. Counting arbitrary strings as validation coverage would reintroduce the same bypass at the policy layer.

### D5. Natural-language checks move to other fields

**Choice**
Document field mapping instead of adding a new runtime free-text evidence field:

| Source claim | Runtime/producers should use |
| --- | --- |
| `pnpm test must pass` | `validators: ["pnpm test"]` + `requiredEvidence: ["validators-ran"]` |
| final audit artifact must exist | `auditReportPaths` + `requiredEvidence: ["audit-report-present"]` |
| only certain paths may change | `validation.allowedPaths` |
| certain paths must not change | `validation.forbiddenPaths` |
| human review / acceptance prose | producer-side `acceptanceCriteria`, `evidence`, or trace metadata |
| scope intent | node `objective` / `scope` |

**Rationale**
The runtime contract stays mechanically checkable while producer/user-facing prose remains available in non-runtime or appropriate validation channels.

## Detailed Design

### Data / Contract Changes

- `GoalValidationEvidenceRequirement` becomes a closed union derived from `SUPPORTED_REQUIRED_EVIDENCE`.
- `GoalDagValidationContract.requiredEvidence` remains optional but, when present, contains only supported tokens.
- `schemas/goal-dag.schema.json` defines `requiredEvidence` as an array with enum items and `uniqueItems: true`.
- No database migration is required; the runtime guard handles existing invalid persisted values.
- No Goal DAG file format version bump is required because valid existing values retain the same JSON shape; invalid values are now rejected.

### Execution Flow

1. `/goal --dag <path>` or another runtime caller loads DAG JSON.
2. `parseGoalDagFileContent()` parses JSON and delegates validation metadata to `parseValidationContract()`.
3. If `validation.requiredEvidence` contains an unsupported token, parsing throws before any goal nodes are created or scheduled.
4. If an old persisted node reaches `runControllerValidation()` with unsupported evidence, the validation runner returns `blocked` with a summary such as `Invalid validation contract: unsupported requiredEvidence token(s): ...`.
5. The blocked invalid-contract result includes validation signals and intentionally omits `followupPrompt`.
6. Supported tokens continue through existing evidence evaluation; `post-merge-validation-ran` remains deferred to native Git post-merge integration evidence.

### Module Boundaries

- `src/core/validation-evidence.ts` or equivalent owns supported evidence constants/type guards.
- `src/core/types.ts` consumes the closed type and remains the durable contract surface for `GoalDagValidationContract`.
- `src/core/dag-file.ts` owns DAG parser fail-fast behavior.
- `src/core/validation-runner.ts` owns old-state runtime guard and evidence satisfaction.
- `schemas/goal-dag.schema.json`, `docs/goal-dag-format.md`, `docs/pipeline-boundaries.md` when relevant, and `README.md` must reflect the same closed contract.
- `goal-dag` producer alignment is a separate repository handoff and must not be implemented here.

### Migration / Rollout

- New/loaded DAG files with unsupported evidence fail fast at parse time.
- Existing invalid state is not migrated in-place; it is safely blocked when validation runs.
- Users/producers should rewrite natural-language checks into validators, audit reports, path policies, objective/scope, or trace/review metadata.
- Package consumers should receive updated built artifacts for any changed exported files.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Existing users may have DAGs with natural-language `requiredEvidence` that previously loaded. | Medium | Provide clear parse errors with supported tokens and field-mapping guidance. |
| Schema and TypeScript token lists could drift. | Medium | Centralize the TypeScript list and add parser/schema/docs tests. |
| Runtime guard could accidentally trigger recoverable validation failures. | Low | Limit guard to unsupported evidence tokens; supported missing evidence continues existing behavior. |
| High-risk policy could count legacy invalid strings as coverage before the guard. | Medium | Run unsupported-evidence guard before high-risk coverage evaluation and test invalid legacy state. |
| Downstream `goal-dag` may still produce invalid DAGs until updated. | Medium | Document Stage 2 handoff and rely on runner parse-time rejection until producer alignment lands. |

## Verification Plan

- Parser tests accept every supported evidence token.
- Parser tests reject `requiredEvidence: ["pnpm test passes"]` with supported-token guidance.
- JSON schema validation rejects unsupported evidence and duplicate required evidence if schema tests are available.
- Validation-runner tests return `blocked` with no `followupPrompt` for already-loaded invalid state.
- High-risk implementation tests prove unsupported evidence does not count as validation coverage.
- Docs example tests confirm examples use only supported tokens.
- Run `npm run check`.
- Confirm changed `dist/` artifacts are present if package exports depend on them.

## Execution Handoff Notes

This section records execution-planning evidence for downstream tools. It is not a DAG and does not assign runtime scheduling.

### Candidate Execution Slices

- Evidence registry and type closure: shared token source and closed TypeScript contract.
- Parser/schema fail-fast: JSON schema enum and DAG parser validation.
- Runtime old-state guard: validation runner blocks unsupported persisted evidence without follow-up.
- Documentation/tests/package artifacts: docs examples, parser/schema/validation tests, and built outputs.

### Ordering / Dependency Evidence

- Parser/schema work depends on the supported token registry because it needs the canonical token set.
- Runtime guard depends on the same token registry for drift-free detection.
- Documentation and tests depend on the final token list and error semantics.
- Stage 2 `goal-dag` producer alignment depends on this runner contract landing but is outside this change.

### Validation Signals

- `npm run check`
- Focused parser and validation-runner tests for supported/unsupported evidence.
- Schema validation test or equivalent direct schema inspection for enum-backed `requiredEvidence`.
- Import/package smoke check if modified dist artifacts affect package consumers.

### Open Questions Affecting Execution

- [ ] None.

### Non-Goals for Execution

- Do not add transcript/self-report evidence satisfaction.
- Do not add runtime planning behavior or trace/OpenSpec ingestion.
- Do not implement periodic controller audit here.
- Do not modify `goal-dag` producer code in this repository.

## Load-Bearing Preservation Notes

- Issue #39 incident: natural-language evidence caused repeated `final-verification` retry loops → preserved in `proposal.md` Why, this design Context, and spec scenarios.
- Issue #39 consensus: `requiredEvidence` must be closed and controller-enforced → preserved in proposal What Changes, D1/D2, and normative spec requirements.
- Issue #39 non-goals: no transcript matching, model evidence, trace ingestion, planner behavior, or subagent self-report authority → preserved in proposal/design non-goals and spec guardrails.
- Issue #39 old-state requirement: persisted invalid DAG state must block with no follow-up → preserved in D3 and the runtime guard requirement.
- Issue #39 follow-up: periodic controller audit is valuable but non-blocking → preserved as non-goal and backlog, not part of immediate implementation.
- Stage 2 goal-dag guidance: producer alignment is separate and should not duplicate runtime validation policy → preserved as boundary/non-goal and handoff note.
