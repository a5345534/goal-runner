# goal-dag-validation-contract Specification

## Purpose

This capability owns the runtime DAG validation contract that `goal-runner` enforces for node-level validation metadata. It defines which `validation.requiredEvidence` tokens are valid runtime input, how unsupported evidence is rejected or blocked, and how natural-language acceptance checks must be represented outside the closed controller evidence token list.

## Requirements

### Requirement: Closed required evidence token set

`goal-runner` SHALL define `validation.requiredEvidence` as a closed set of controller-enforced evidence tokens. The supported tokens SHALL be:

- `validators-ran`
- `locked-artifacts-unchanged`
- `implementation-diff-present`
- `non-test-diff-present`
- `post-merge-validation-ran`
- `audit-report-present`

The runtime TypeScript contract MUST NOT permit arbitrary strings as `GoalValidationEvidenceRequirement` values.

#### Scenario: All supported evidence tokens are valid runtime input

- **GIVEN** a runtime DAG file contains a node validation contract with all supported `requiredEvidence` tokens
- **WHEN** `goal-runner` parses the DAG file
- **THEN** parsing succeeds for the evidence token list
- **AND** the planned node preserves the supported tokens for controller validation

#### Scenario: Arbitrary evidence text is not part of the type contract

- **GIVEN** implementation code attempts to treat `"pnpm test passes"` as a `GoalValidationEvidenceRequirement`
- **WHEN** the TypeScript contract is checked
- **THEN** the value is not accepted by the closed evidence requirement type

### Requirement: Runtime DAG schema rejects unsupported required evidence

`schemas/goal-dag.schema.json` SHALL define `validation.requiredEvidence` as an array whose items are the supported evidence-token enum. The schema SHOULD require unique items so repeated evidence tokens are rejected before execution.

#### Scenario: Schema accepts supported evidence

- **GIVEN** a runtime DAG JSON document uses `requiredEvidence: ["validators-ran", "audit-report-present"]`
- **WHEN** the runtime DAG schema validates the document
- **THEN** schema validation accepts the document

#### Scenario: Schema rejects natural-language evidence

- **GIVEN** a runtime DAG JSON document uses `requiredEvidence: ["pnpm test passes"]`
- **WHEN** the runtime DAG schema validates the document
- **THEN** schema validation rejects the document because the evidence value is not a supported enum token

### Requirement: DAG parser fails fast on unsupported required evidence

The runtime DAG parser SHALL reject unsupported `validation.requiredEvidence` tokens before any goal nodes are created, scheduled, or launched. The error message SHALL name the unsupported token(s), list supported values, and direct natural-language acceptance checks to validators, audit reports, objective/scope, path policy, or producer trace/review metadata.

#### Scenario: Parser rejects impossible validation contract

- **GIVEN** a runtime DAG file contains `validation.requiredEvidence: ["pnpm test passes"]`
- **WHEN** `parseGoalDagFileContent()` or `parseGoalDagFileDocument()` loads the file
- **THEN** parsing fails before execution
- **AND** the error states that `"pnpm test passes"` is an unsupported controller evidence token
- **AND** the error lists the supported evidence tokens

#### Scenario: Parser does not consume producer trace metadata as evidence

- **GIVEN** a producer has natural-language acceptance criteria in trace-only metadata
- **WHEN** `goal-runner` parses the runtime DAG JSON
- **THEN** only the runtime DAG fields are considered
- **AND** trace/OpenSpec/PRD metadata is not used to satisfy or expand `requiredEvidence`

### Requirement: Existing invalid runtime state blocks without subagent follow-up

`runControllerValidation()` SHALL detect already-persisted or otherwise already-loaded nodes whose `validation.requiredEvidence` contains unsupported strings. Such invalid contracts SHALL return a blocked validation result and SHALL NOT include a `followupPrompt` for the subagent.

#### Scenario: Persisted invalid required evidence is blocked

- **GIVEN** a previously persisted DAG node contains `validation.requiredEvidence: ["pnpm test passes"]`
- **WHEN** controller validation runs for that node
- **THEN** the validation result status is `blocked`
- **AND** the summary identifies the unsupported required evidence token
- **AND** validation signals include the unsupported token for diagnostics
- **AND** no `followupPrompt` is returned

#### Scenario: Subagent is not asked to repair invalid runtime contract

- **GIVEN** a node has unsupported `requiredEvidence`
- **WHEN** controller validation blocks the node
- **THEN** the controller does not ask the subagent to “provide missing validation evidence” for that unsupported string
- **AND** the runtime does not spawn another validation retry solely to satisfy the unsupported token

### Requirement: Unsupported evidence does not satisfy high-risk validation coverage

For high-risk `kind=implementation` nodes, unsupported evidence strings SHALL NOT count as a valid validation contract. Only supported controller evidence tokens, validators, outputs, validation profiles, approved test-spec references, artifact locks, or other mechanically enforced supported validation metadata may satisfy high-risk validation coverage policy.

#### Scenario: Unsupported evidence is invalid contract data, not coverage

- **GIVEN** a high-risk implementation node has no validators, outputs, validation profile, approved test-spec reference, artifact locks, or supported required evidence
- **AND** it contains only `requiredEvidence: ["manual review passed"]` from old persisted state
- **WHEN** controller validation runs
- **THEN** the node is treated as having an invalid validation contract
- **AND** the unsupported evidence string does not satisfy the high-risk validation policy

### Requirement: Natural-language checks use non-`requiredEvidence` channels

`goal-runner` documentation SHALL state that natural-language acceptance checks MUST NOT be placed in `validation.requiredEvidence`. Runtime DAG authors and producer tools SHOULD encode checks as follows:

- executable checks in `validators` plus `requiredEvidence: ["validators-ran"]`
- audit artifact checks in `auditReportPaths` plus `requiredEvidence: ["audit-report-present"]`
- change-scope checks in `validation.allowedPaths` / `validation.forbiddenPaths`
- scope intent in node `objective` / `scope`
- human review or producer-only prose in producer trace/review metadata such as `acceptanceCriteria` or `evidence`

#### Scenario: Executable verification is encoded mechanically

- **GIVEN** a producer wants `pnpm test` to pass
- **WHEN** it emits runtime DAG validation metadata for `goal-runner`
- **THEN** it uses `validators: ["pnpm test"]`
- **AND** it uses `requiredEvidence: ["validators-ran"]`
- **AND** it does not place `"pnpm test passes"` in `requiredEvidence`

#### Scenario: Audit evidence uses audit report fields

- **GIVEN** a producer wants a final audit report to exist
- **WHEN** it emits runtime DAG validation metadata for `goal-runner`
- **THEN** it uses `auditReportPaths` for the report file path
- **AND** it uses `requiredEvidence: ["audit-report-present"]`

### Requirement: Post-merge validation evidence remains integration-owned

`post-merge-validation-ran` SHALL remain a supported evidence token, but ordinary pre-integration controller validation SHALL NOT mark it satisfied. It is satisfied only by native Git post-merge validation/integration behavior that explicitly records post-merge validation evidence.

#### Scenario: Pre-integration validation defers post-merge evidence

- **GIVEN** a node requires `post-merge-validation-ran`
- **WHEN** ordinary controller validation runs before native Git post-merge integration
- **THEN** controller validation does not record that evidence as satisfied
- **AND** native Git post-merge integration remains responsible for satisfying that token

### Requirement: Periodic controller audit remains separate follow-up

This change SHALL NOT implement the periodic controller audit agent described as a follow-up in issue #39. The immediate fix is deterministic contract closure and old-state guarding.

#### Scenario: Direct bug fix does not depend on audit agent

- **GIVEN** unsupported `requiredEvidence` exists in a runtime DAG or persisted node
- **WHEN** this change is implemented
- **THEN** the invalid contract is rejected or blocked deterministically
- **AND** no periodic audit model is required to identify the known invalid-contract condition
