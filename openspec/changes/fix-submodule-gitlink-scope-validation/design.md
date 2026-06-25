# Design: fix-submodule-gitlink-scope-validation

## Context

Goal-runner controller validation currently enforces node scope by comparing changed workspace paths against `allowedPaths` and `forbiddenPaths`. The core check lives in the validation path around `scopePolicyFailures()` / `matchesPathPolicy()` and reports diagnostics such as `changed files outside allowed paths: ...`.

For repositories with Git submodules, a parent repository does not list the submodule-internal file paths as ordinary parent-repo changes. Instead, after the submodule commit is integrated, the parent repository records a gitlink change at the submodule root path. In Goal `6fc8f3ab`, the submodule root was `aos-core`, while the node scope was `aos-core/packages/runtime-ports/**`. The controller saw `aos-core` and blocked the node even though the relevant internal submodule changes were under the allowed package path.

A previous controller-loop fix (`c8abe36`) recognized parent-path policy conflicts as controller-action-required and suppressed repeated replacement attempts. That made the failure controlled, but not correct: valid submodule-scoped work still cannot pass validation.

## Spec Kernel

- Why: changed submodule gitlinks can represent valid submodule-internal work that is narrower than the submodule root; direct path comparison blocks those valid changes.
- Value gate outcome: `proceed_to_spec`
- Capabilities:
  - Validate changed submodule gitlinks by inspecting the internal submodule diff.
  - Apply existing `allowedPaths` and `forbiddenPaths` to mapped internal paths.
  - Fail closed with actionable diagnostics when the submodule diff cannot be inspected.
- Constraints:
  - A submodule root gitlink MUST NOT pass solely because an allowed path exists below that root.
  - `forbiddenPaths` MUST remain authoritative after path mapping.
  - Non-submodule path validation behavior MUST remain unchanged.
- Non-goals:
  - No graph-production changes.
  - No submodule publish-policy redesign.
  - No monitor UI change.
  - No automatic repair of already-blocked historical goals.
- Success signal: focused regression tests prove allowed, disallowed, forbidden, and unverifiable submodule gitlink cases.

## Goals

- Correctly validate parent-repo submodule gitlink changes that correspond to node-scoped internal submodule changes.
- Preserve strict scope enforcement by validating the actual internal diff rather than blindly accepting the submodule root.
- Produce clear fail-closed diagnostics for missing SHAs, missing local commits, unreadable submodules, or failed diff inspection.
- Keep existing non-submodule validation behavior stable.

## Non-Goals

- Do not broaden DAG authoring rules by requiring `allowedPaths: ["aos-core"]` for narrow package changes.
- Do not modify graph scheduling, model selection, monitor layout, or submodule publish gates.
- Do not introduce a permissive override for validation failures.
- Do not make network fetches mandatory during validation.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Scope broadening | Accepting a submodule root path directly would permit unrelated submodule changes. | Treat gitlinks as evidence requiring internal diff validation, not as allowed paths by themselves. |
| Forbidden path bypass | Internal paths may include forbidden files even if the root is expected. | Map every internal diff path back under the submodule root before applying `forbiddenPaths`. |
| Missing local commits | Old/new gitlink SHAs may not exist locally. | Fail closed and report which submodule/revision could not be inspected. |
| Regression risk | Existing plain-file validation must not change. | Add tests proving non-submodule path matching is unaffected. |
| Prior retry-loop fix | Existing cap/replacement suppression solved looping, not correctness. | Keep that behavior; this change makes valid cases pass before they hit repeated-failure recovery. |

## Decisions

### D0. Value path

**Choice**
Proceed to OpenSpec authoring for the controller validation fix.

**Rationale**
The observed failure blocks valid goal progress after a successful submodule-scoped implementation. The change is narrow, testable, and materially improves reliability while preserving strict validation.

**Alternatives considered**
- No-build: rejected; documentation/manual operation does not prevent repeat false blocks.
- AllowedPaths root workaround: rejected; it cannot prove the internal submodule diff is limited to the node scope.
- Separate integration-only node: useful future boundary cleanup, but it still leaves the final parent gitlink needing validation.

### D1. Validate gitlinks through mapped internal diff paths

**Choice**
When a changed path is a known submodule root and the validation contract contains paths below that root, classify it as a submodule gitlink candidate. Resolve the gitlink old/new revisions, run a local internal diff in the submodule, prefix each internal path with the submodule root, and apply existing path policy to the mapped paths.

**Rationale**
The node's scope is expressed in workspace-relative paths such as `aos-core/packages/runtime-ports/**`. Mapping `packages/runtime-ports/src/index.ts` back to `aos-core/packages/runtime-ports/src/index.ts` lets the existing policy language remain the source of truth.

**Alternatives considered**
- Treat the submodule root as implicitly allowed whenever a child path is allowed: rejected because it hides unrelated internal changes.
- Require DAG authors to add the submodule root: rejected because it weakens scope semantics and spreads runner internals into graph authoring.

### D2. Fail closed on unresolved submodule evidence

**Choice**
If validation cannot determine old/new gitlink revisions or cannot inspect the internal diff, the node remains blocked with a diagnostic such as `changed submodule gitlink aos-core cannot be validated against allowedPaths because <reason>`.

**Rationale**
A missing local revision or unreadable submodule is not proof of safety. The controller should not pass an unverified gitlink.

**Alternatives considered**
- Fetch automatically and retry: deferred. Automatic fetch policy has repository trust and network implications outside this change.
- Fall back to accepting the root path: rejected as unsafe.

### D3. Preserve existing path-policy semantics

**Choice**
Keep `matchesPathPolicy()` semantics for mapped paths. The new behavior should be an input-expansion/classification step before existing allowed/forbidden checks, not a replacement for those checks.

**Rationale**
This limits the change surface and keeps all non-submodule validation behavior stable.

**Alternatives considered**
- Rewrite scope validation around a new policy model: too broad for the observed bug.

## Detailed Design

### Data / Contract Changes

No public schema or persisted data contract change is expected.

Implementation may introduce internal helper structures such as:

- `SubmoduleGitlinkDiff`: submodule root, old revision, new revision, internal changed paths, mapped workspace paths;
- `SubmoduleGitlinkValidationFailure`: submodule root plus fail-closed diagnostic reason.

These structures should remain internal to controller validation unless implementation discovers an existing internal type is more appropriate.

### Execution Flow

1. Collect changed paths as validation already does.
2. For each changed path that does not match allowed paths directly:
   - determine whether it is a configured Git submodule root;
   - determine whether any configured allowed or forbidden path is nested under that root.
3. If it is not a relevant submodule root, keep the existing outside-allowed behavior.
4. If it is a relevant submodule root:
   - resolve old and new gitlink revisions from the parent repository diff context;
   - inspect the submodule internal diff between those revisions using local Git data;
   - map each internal changed path back to `<submodule-root>/<internal-path>`.
5. Apply existing `allowedPaths` and `forbiddenPaths` to the mapped paths.
6. Accept the gitlink only when mapped paths satisfy allowed paths and avoid forbidden paths.
7. If resolution or diff inspection fails, emit a fail-closed policy failure that names the submodule root and reason.

### Module Boundaries

- `src/core/validation-runner.ts` owns controller validation policy failures and is the primary implementation surface.
- Existing controller-loop recovery behavior should not be expanded except for tests that prove valid submodule cases no longer reach repeated validation failure handling.
- Git inspection helpers should remain small and local to validation/core utilities; do not couple them to adapter-specific monitor behavior.

### Migration / Rollout

No migration is expected. The change is behavioral and covered by tests.

Rollout steps:

1. Add submodule gitlink validation helpers and tests.
2. Run focused validation tests.
3. Run the repository check/build command used by goal-runner.
4. Observe that the original false-block pattern now passes when internal paths are allowed.

Rollback is a code revert; no data rollback is required.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Accepting unsafe gitlink changes | High | Never pass a gitlink without inspecting internal diff paths and applying forbidden paths. |
| Missing local submodule revisions | Medium | Fail closed with a diagnostic; do not silently pass or fetch. |
| Over-coupling validation to Git implementation details | Medium | Keep helper API narrow and internal; reuse existing path matching. |
| Regressing normal path validation | Medium | Include unchanged behavior tests for ordinary changed files. |

## Verification Plan

- Unit test: changed `aos-core` gitlink with internal diff only under `aos-core/packages/runtime-ports/**` passes.
- Unit test: changed `aos-core` gitlink with internal diff under `aos-core/packages/domain-adapters/**` fails when only runtime-ports is allowed.
- Unit test: changed `aos-core` gitlink with internal diff under a forbidden path fails even if allowed root patterns exist.
- Unit test: unresolved old/new revision or failed diff inspection fails closed with a diagnostic.
- Regression test: ordinary non-submodule outside-allowed path still fails.
- Run focused controller validation tests and the standard goal-runner repository check.

## Execution Handoff Notes

This section records execution-planning evidence for downstream tools. It is not a DAG and does not assign runtime scheduling.

### Candidate Execution Slices

- Validation helper slice: classify submodule gitlink changes, resolve revisions, map internal diff paths.
- Scope policy integration slice: apply existing allowed/forbidden matching to mapped submodule paths and diagnostics.
- Regression coverage slice: add allowed/disallowed/forbidden/fail-closed tests plus a non-submodule regression.

### Ordering / Dependency Evidence

- Scope policy integration depends on helper behavior because mapped workspace-relative paths are the input to existing path-policy checks.
- Regression coverage can be authored alongside implementation but can only pass after helper and integration behavior are complete.

### Validation Signals

- Focused test command for controller validation behavior.
- Repository-level check/build command used by goal-runner.
- Manual review of diagnostics to confirm fail-closed messages name the submodule and reason.

### Open Questions Affecting Execution

- [ ] None.

### Non-Goals for Execution

- Do not modify graph production.
- Do not add permissive path overrides.
- Do not change submodule publish policy.
- Do not change monitor UI.

## Load-Bearing Preservation Notes

- Goal `6fc8f3ab` false block (`changed files outside allowed paths: aos-core`) → proposal Why, design Context, spec scenarios.
- Prior fix `c8abe36` solved retry/replacement behavior but not validation correctness → proposal Why, design Context/Concern Scan.
- Recommended B/safety version: validate internal submodule diff, not root path → proposal What Changes, design D1, spec requirements.
- Fail-closed requirement → proposal Success Signal, design D2/Risks, spec fail-closed requirement.
- Rejected workaround of allowing whole submodule root → proposal Value Gate, design D0/D1, non-goals.
