# Tasks: fix-submodule-gitlink-scope-validation

## 1. Spec and Contract

- [ ] 1.1 Add the `goal-runner-controller-validation` spec delta for submodule gitlink scope validation.
- [ ] 1.2 Confirm no public schema or persisted data contract changes are required.
- [ ] 1.3 Confirm `design.md` execution handoff notes preserve source-grounded slices, dependency evidence, validation signals, open questions, and non-goals.

## 2. Implementation

- [ ] 2.1 Add an internal helper that identifies changed parent-repo paths that are Git submodule roots relevant to the node path policy.
- [ ] 2.2 Resolve old/new gitlink revisions for a relevant changed submodule root from the parent repository diff context.
- [ ] 2.3 Inspect the local submodule diff between old/new revisions and map internal paths back to workspace-relative paths.
- [ ] 2.4 Apply existing `allowedPaths` and `forbiddenPaths` matching to mapped submodule-internal paths.
- [ ] 2.5 Return a clear fail-closed validation failure when revisions or internal diff paths cannot be resolved.
- [ ] 2.6 Preserve existing behavior for ordinary non-submodule changed paths.

## 3. Verification

- [ ] 3.1 Add a passing regression test for a changed `aos-core` gitlink whose internal diff maps only to `aos-core/packages/runtime-ports/**`.
- [ ] 3.2 Add a failing regression test for a changed `aos-core` gitlink whose internal diff maps outside the node `allowedPaths`.
- [ ] 3.3 Add a failing regression test for a mapped internal path that matches `forbiddenPaths`.
- [ ] 3.4 Add a fail-closed regression test for unresolved old/new revisions or diff inspection failure.
- [ ] 3.5 Add or preserve a non-submodule outside-allowed regression test.
- [ ] 3.6 Run focused controller validation tests.
- [ ] 3.7 Run the standard goal-runner repository check/build command.

## 4. Documentation / Closeout

- [ ] 4.1 Update relevant developer/controller validation documentation if the repository has a current location for validation policy notes.
- [ ] 4.2 Refresh `source-manifest.json`.
- [ ] 4.3 Validate `change-explainer.html` with decision-review requirements.
- [ ] 4.4 Run archive preflight when implementation is complete.
- [ ] 4.5 Confirm Stage 1 produced only OpenSpec package sources and did not generate downstream execution-plan artifacts.

## Backlog / Follow-ups

- [ ] [BACKLOG] Consider a future integration-boundary cleanup where parent-repo gitlink updates are represented separately from narrow submodule package changes, without weakening validation.
- [ ] [BACKLOG] Consider optional diagnostics that summarize mapped submodule-internal changed paths in monitor views after the core validation behavior is correct.
