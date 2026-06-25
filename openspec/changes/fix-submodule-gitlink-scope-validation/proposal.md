# fix-submodule-gitlink-scope-validation

## Why

A live Goal `6fc8f3ab` run exposed a controller scope-validation false block for native-git repositories that contain Git submodules. The `runtime-ports-package` subagent completed and committed a valid `aos-core/packages/runtime-ports/**` change, but the parent repository represented the integrated result as a changed submodule gitlink path: `aos-core`.

The controller compared that parent gitlink path directly against the node `allowedPaths` (`aos-core/packages/runtime-ports/**`) and failed validation with:

```text
changed files outside allowed paths: aos-core
```

That blocked the completed node, dependency-blocked the remaining graph, and finalized the goal as blocked. Previous work (`c8abe36`, `fix: suppress replacement for controller policy validation caps`) made this failure mode stop retrying indefinitely, but it did not make valid submodule gitlink integration pass.

## Value Gate

- Outcome: `proceed_to_spec`
- No-build considered: rejected because documentation or manual repair would not prevent future native-git/submodule runs from hitting the same false validation block.
- Smaller-scope considered: rejected as unsafe. Adding the whole submodule root (for example `aos-core`) to node `allowedPaths` would allow any commit reachable through that gitlink, including unrelated or forbidden submodule changes, without inspecting the internal diff.
- Assumption posture: confirmed; no material unresolved assumptions.

## What Changes

- Controller scope validation recognizes changed parent-repo Git submodule gitlinks.
- For a changed gitlink whose root contains one or more configured `allowedPaths`, validation resolves the submodule old/new revisions and maps internal diff paths back to workspace-relative paths.
- The existing `allowedPaths` and `forbiddenPaths` rules are then applied to those mapped paths.
- The gitlink is accepted only when all mapped internal changes are allowed and none are forbidden.
- Validation fails closed with a clear diagnostic when the submodule diff cannot be inspected.

## Impact

- Affected specs: `goal-runner-controller-validation`
- Affected modules/repos: `goal-runner` controller validation and focused tests
- Affected APIs/events/data: none expected; behavior is internal controller validation semantics
- Migration/deployment impact: none expected beyond shipping the runner update
- User-visible impact: valid native-git/submodule graph runs can advance after a submodule-scoped node completes, while out-of-scope submodule changes remain blocked with clearer diagnostics.

## Non-Goals

- Do not change Goal graph production.
- Do not require graph authors to list entire submodule roots in `allowedPaths`.
- Do not redesign submodule publish or retained-ref policy.
- Do not change monitor rendering.
- Do not auto-repair already-blocked historical goals.
- Do not bypass `forbiddenPaths` for mapped submodule-internal paths.

## Pipeline Handoff Boundary

- Stage 1 output: governed OpenSpec sources only.
- Downstream consumer: `goal-dag` reads `source-manifest.json` plus the authoritative markdown/spec sources.
- No Goal DAG JSON or execution runtime plan is produced by this package.

## Success Signal

Regression coverage proves:

1. a changed `aos-core` gitlink passes when its internal diff maps entirely under `aos-core/packages/runtime-ports/**`;
2. a changed `aos-core` gitlink fails when the internal diff maps outside the allowed scope;
3. a changed `aos-core` gitlink fails when the internal diff maps to a forbidden path;
4. validation fails closed when old/new submodule revisions or diff paths cannot be resolved.

## Assumptions

- None.

## Open Questions

- [ ] None.
