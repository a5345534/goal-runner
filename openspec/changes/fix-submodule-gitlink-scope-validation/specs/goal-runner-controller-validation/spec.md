# goal-runner-controller-validation Specification

## Purpose

This capability owns controller-side validation of a completed graph node's changed paths against its declared scope policy. It ensures allowed-path and forbidden-path checks remain strict while supporting Git submodule gitlink changes that represent narrower submodule-internal work.

## Requirements

### Requirement: Validate changed submodule gitlinks through internal diff mapping

When controller validation observes a changed parent-repo path that is a Git submodule root and the node path policy contains paths nested under that root, the controller SHALL validate the gitlink by inspecting the submodule internal diff between the old and new gitlink revisions.

The controller SHALL map every internal changed path to a workspace-relative path by prefixing it with the submodule root before applying existing path policy rules.

#### Scenario: Gitlink passes when all internal paths are allowed

- **GIVEN** a completed node declares `allowedPaths` containing `aos-core/packages/runtime-ports/**`
- **AND** the parent repository reports a changed submodule gitlink path `aos-core`
- **AND** the submodule diff between the old and new gitlink revisions contains only `packages/runtime-ports/package.json`, `packages/runtime-ports/tsconfig.json`, and `packages/runtime-ports/src/index.ts`
- **WHEN** controller validation evaluates changed paths
- **THEN** it maps the internal paths to `aos-core/packages/runtime-ports/package.json`, `aos-core/packages/runtime-ports/tsconfig.json`, and `aos-core/packages/runtime-ports/src/index.ts`
- **AND** it treats the gitlink as within the node allowed scope.

#### Scenario: Gitlink fails when an internal path is outside allowed paths

- **GIVEN** a completed node declares `allowedPaths` containing `aos-core/packages/runtime-ports/**`
- **AND** the parent repository reports a changed submodule gitlink path `aos-core`
- **AND** the submodule diff contains `packages/domain-adapters/src/index.ts`
- **WHEN** controller validation evaluates changed paths
- **THEN** it maps the internal path to `aos-core/packages/domain-adapters/src/index.ts`
- **AND** it reports a policy failure for a changed file outside allowed paths.

### Requirement: Preserve forbidden path enforcement for mapped submodule paths

Mapped submodule-internal paths SHALL be checked against `forbiddenPaths` after they are prefixed with the submodule root. A mapped path that matches `forbiddenPaths` SHALL fail validation even when other mapped paths are allowed.

#### Scenario: Forbidden mapped internal path fails validation

- **GIVEN** a completed node declares `allowedPaths` containing `aos-core/packages/**`
- **AND** it declares `forbiddenPaths` containing `aos-core/apps/**`
- **AND** the parent repository reports a changed submodule gitlink path `aos-core`
- **AND** the submodule diff contains `apps/api/src/main.ts`
- **WHEN** controller validation evaluates changed paths
- **THEN** it maps the internal path to `aos-core/apps/api/src/main.ts`
- **AND** it reports a policy failure for touching a forbidden path.

### Requirement: Fail closed when submodule diff evidence is unavailable

Controller validation SHALL NOT accept a changed submodule gitlink when it cannot determine the old gitlink revision, the new gitlink revision, or the internal changed paths between those revisions. It SHALL emit a diagnostic that identifies the submodule root and explains why the gitlink could not be validated.

#### Scenario: Missing revision blocks the gitlink

- **GIVEN** a completed node declares `allowedPaths` containing `aos-core/packages/runtime-ports/**`
- **AND** the parent repository reports a changed submodule gitlink path `aos-core`
- **AND** validation cannot resolve the old or new gitlink revision locally
- **WHEN** controller validation evaluates changed paths
- **THEN** it fails validation
- **AND** the diagnostic identifies `aos-core` as an unverifiable changed submodule gitlink.

### Requirement: Preserve ordinary path policy behavior

For changed paths that are not relevant Git submodule roots, controller validation SHALL preserve existing direct `allowedPaths` and `forbiddenPaths` behavior.

#### Scenario: Ordinary outside path still fails

- **GIVEN** a completed node declares `allowedPaths` containing `src/**`
- **AND** the changed path is `docs/notes.md`
- **WHEN** controller validation evaluates changed paths
- **THEN** it reports `docs/notes.md` as outside the allowed paths.
