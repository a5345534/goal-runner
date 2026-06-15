# Goal DAG file format

`/goal` uses a dedicated JSON DAG file for multi-node execution. The runtime no longer parses markdown task lists or headings from free-form objective text.

- Use `/goal <objective>` for a single execution node.
- Use `/goal --dag <path>` for an explicit multi-node DAG.

The JSON schema lives at [`schemas/goal-dag.schema.json`](../schemas/goal-dag.schema.json). `goal-runner` owns this schema, the parser, graph validation, scheduling behavior, model-routing application, controller/subagent state, validator execution, completion audit, and lifecycle ledger. See [`pipeline-boundaries.md`](pipeline-boundaries.md) for the Stage 3 boundary.

## Producer / Consumer Boundary

Producer tools such as `goal-dag` may produce `.dag.json` and optional `.trace.json` files.

`goal-runner` consumes only `.dag.json` runtime DAG files that match [`schemas/goal-dag.schema.json`](../schemas/goal-dag.schema.json).

`.trace.json` is review/audit sidecar data for humans and producer workflows. It is not runtime input and must not affect scheduling, validation, model routing, workspace allocation, validator execution, or completion.

OpenSpec change packages are not runtime inputs. Convert them into DAG JSON using the producer stage before invoking `/goal --dag`.

`goal-runner` does not consume `GoalDagSpec`, producer trace sidecars, `source-manifest.json`, `change-explainer.html`, PRDs, design docs, ticket markdown, or markdown task lists.

## Command

```text
/goal --dag .goal/people-frappe-backend.dag.json
```

Optional flags:

```text
/goal --workspace <path> --branch <branch> --dag <path>
/goal --workspace <path> --ref <ref> --dag <path>
/goal --tokens 500k --dag <path>
```

When `--dag` is supplied:

- the goal objective comes from the file's `objective`
- the DAG nodes come from the file's `nodes`
- no additional objective text is accepted on the command line
- the file is read relative to the current Pi working directory unless an absolute path is supplied

## Minimal file

```json
{
  "version": 1,
  "objective": "Complete People Frappe backend remaining slices",
  "nodes": [
    {
      "id": "attendance-parity",
      "objective": "Add attendance parity fixtures"
    },
    {
      "id": "payroll-doctypes",
      "objective": "Add payroll DocTypes"
    },
    {
      "id": "integration-validation",
      "objective": "Run integrated validation",
      "after": ["attendance-parity", "payroll-doctypes"]
    }
  ]
}
```

Nodes with no `after` dependencies are immediately schedulable, subject to controller concurrency and conflict rules. There is **no inferred sequential dependency** in DAG files.

## Full example

```json
{
  "version": 1,
  "objective": "Complete People Frappe backend remaining slices without moving production ownership before parity/cutover gates.",
  "defaults": {
    "workspaceStrategy": "native-git-worktree",
    "completionGates": ["controller-validation"],
    "validators": [
      "python3 -m unittest discover projects/backend/module/people-frappe-module/tests"
    ],
    "conflicts": {
      "modules": ["people-frappe-module"]
    },
    "thinkingLevel": "high"
  },
  "modelRouting": {
    "scenarios": {
      "controller": { "model": "openai-codex/gpt-5.5" },
      "implementation": { "model": "openai-codex/gpt-5.5" },
      "docs": { "model": "openai/gpt-5-mini" },
      "review": { "model": "anthropic/claude-opus" }
    },
    "controllerScenario": "controller",
    "defaultSubagentScenario": "implementation",
    "rules": [
      { "scenario": "docs", "when": { "scopes": ["docs"], "risks": ["low"] } },
      { "scenario": "review", "when": { "objectiveIncludes": ["validate", "archive"] } }
    ]
  },
  "nodes": [
    {
      "id": "attendance-parity",
      "objective": "Create an OpenSpec change and add attendance parity fixtures for People Frappe.",
      "outputs": [
        "openspec/changes/implement-people-attendance-parity/tasks.md",
        "projects/backend/module/people-frappe-module/tests/test_attendance_parity.py"
      ],
      "conflicts": {
        "files": [
          "projects/backend/module/people-frappe-module/beyourself_people/attendance"
        ],
        "capabilities": ["attendance"]
      }
    },
    {
      "id": "payroll-doctypes",
      "objective": "Create an OpenSpec change and add People Payroll DocType skeletons.",
      "outputs": [
        "openspec/changes/implement-people-payroll-doctypes/tasks.md"
      ],
      "conflicts": {
        "files": [
          "projects/backend/module/people-frappe-module/beyourself_people/payroll"
        ],
        "capabilities": ["payroll"]
      }
    },
    {
      "id": "people-event-bridge",
      "objective": "Define the narrow Java people-event-bridge and its canonical event publication contract.",
      "conflicts": {
        "modules": ["people-event-bridge"],
        "capabilities": ["integration"]
      }
    },
    {
      "id": "integration-validation",
      "objective": "Run integrated validation and archive completed OpenSpec changes.",
      "after": [
        "attendance-parity",
        "payroll-doctypes",
        "people-event-bridge"
      ],
      "validators": [
        "python3 -m unittest discover projects/backend/module/people-frappe-module/tests",
        "openspec validate people-frappe-backend --strict"
      ]
    }
  ]
}
```

## Root fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `version` | yes | `1` | File format version. Only `1` is accepted. |
| `objective` | yes | non-empty string | The goal objective shown in status/monitor and used for the controller session. |
| `defaults` | no | object | Defaults copied to nodes that do not override them. |
| `modelRouting` | no | object | Scenario-to-model routing table used by Pi for the controller session and DAG node subagents. |
| `nodes` | yes | non-empty array | Explicit DAG nodes. Default maximum is 20 nodes. |

## Node fields

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `id` | yes | kebab-case string | Stable node id and slug. Must match `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$`. |
| `objective` | yes | non-empty string | Work assigned to the subagent for this node. |
| `after` | no | array of node ids | Dependencies that must be `complete` and have successful required subagent integration before this node can run. |
| `outputs` | no | string array | Expected files/directories checked by controller validation. |
| `validators` | no | string array | Shell validators for controller validation. |
| `conflicts` | no | object | File/module/capability conflict hints for scheduler serialization. |
| `scope` | no | string | Human-readable scope label. |
| `kind` | no | string | Optional workflow role such as `test-spec`, `test-review`, `implementation`, or `audit`. Runtime treats unknown values as labels but policy may use them. |
| `validation` | no | object | Optional validation contract metadata: profile, test-spec provenance, artifact locks, required evidence, audit test-gap policy, and generic diff/report settings. |
| `workspaceStrategy` | no | string | Workspace allocation strategy. Defaults to native Git worktree in Pi. |
| `workspace` | no | object | Optional deterministic workspace binding hints for adapters. For native-git nodes, `worktreeSlug`, `branch`, and `baseRef` control the subagent worktree/branch the controller creates or reuses. |
| `risk` | no | `low` / `medium` / `high` | Risk label for scheduling/model-routing/review policy. |
| `completionGates` | no | string array | Completion gates. Defaults to `controller-validation`. Integration gate names such as `subagent-integration`, `subagent-branch-integration`, `branch-integration`, or `native-git-integration` explicitly require branch integration before completion. `post-merge-validation` additionally requires post-merge validators in the controller workspace. |
| `modelScenario` | no | scenario id | Explicit model-routing scenario for this node. Overrides defaults and rules. |
| `thinkingLevel` | no | string | Pi thinking level for this node. Overrides `defaults.thinkingLevel`. |

## Validation contract

A node can declare a generic validation contract. Runtime persists this metadata and uses it during controller validation; planners and project rule packs are responsible for generating project-specific validators.

```json
{
  "id": "implement-feature",
  "objective": "Implement the feature after tests are approved",
  "kind": "implementation",
  "risk": "high",
  "validators": ["npm test"],
  "validation": {
    "profile": "code-change",
    "testSpecNodeId": "write-feature-tests",
    "approvedByNodeId": "review-feature-tests",
    "artifactLocks": [
      {
        "path": "tests/feature.test.ts",
        "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "sourceNodeId": "write-feature-tests"
      }
    ],
    "requiredEvidence": [
      "validators-ran",
      "locked-artifacts-unchanged",
      "implementation-diff-present"
    ],
    "diffBaseRef": "main",
    "allowedPaths": ["src/**", "tests/**"],
    "forbiddenPaths": ["package-lock.json", "infra/**"],
    "onAuditTestGap": "reopen-test-spec"
  }
}
```

`validation.allowedPaths` and `validation.forbiddenPaths` define a controller-side scope policy for changed files. Paths are repository/workspace-relative strings. Exact paths match that file, and simple `/**` suffixes match everything below that prefix (for example `src/**` matches `src/feature.ts`). When `allowedPaths` is absent, changed files are not restricted by allow-list. When `allowedPaths` is present, every changed file must match at least one allowed path. `forbiddenPaths` always has priority: any changed file matching a forbidden path fails validation even if it also matches an allowed path. Nodes without a scope policy keep existing behavior, but subagents are still instructed not to make unrelated changes.

Every subagent launch includes a controller execution policy in the executor prompt. The policy restates the assigned node boundary, allowed/forbidden paths when configured, the exact completion markers, and the requirement to inspect diff/status plus run or explain validators before `SUBAGENT_RESULT`. This is prompt-time guidance only; controller validation remains authoritative and fails closed on scope/policy violations.

Supported built-in evidence labels include `validators-ran`, `locked-artifacts-unchanged`, `implementation-diff-present`, `non-test-diff-present`, `post-merge-validation-ran`, and `audit-report-present`. `post-merge-validation-ran` is deferred to native Git integration and is only satisfied by the post-merge validation gate, not by ordinary pre-integration validator execution. `audit-report-present` requires a readable report file and fails if the report explicitly says violations remain (for example `9 violation paths / 98 files remain`). Unknown labels fail closed until a planner/runtime adapter teaches the controller how to satisfy them.

For high-risk `kind=implementation` nodes, controller validation fails if the node has no validators, outputs, validation profile, approved test-spec reference, artifact locks, or required evidence. This prevents high-risk work from completing on self-report alone.

### Producer guidance

Producer tools should use `kind` and `validation` when modeling test-spec-first, implementation, review, and audit nodes. Runtime enforces the declared contract; it does not infer missing validation policy from producer trace metadata. If a producer cannot provide validators, expected outputs, validation profile, approved test-spec references, artifact locks, or required evidence for a high-risk implementation node, the node should remain outside `/goal --dag` until the producer can emit a complete runtime DAG contract.

## Subagent branch integration

For `workspaceStrategy: "native-git-worktree"`, Pi/OpenCode allocate a controller worktree and per-node subagent worktrees/branches. After a subagent reports `SUBAGENT_RESULT:` and controller validation passes, the runtime attempts to integrate the committed subagent branch head into the controller workspace before marking the node `complete`.

Post-merge validation is opt-in. Add `post-merge-validation` (or legacy alias `post-merge-validation-ran`) to `completionGates`, or include `"post-merge-validation-ran"` in `validation.requiredEvidence`, to require native Git integration to re-run node `validators` in the controller workspace after applying the subagent branch and before recording the integration commit. The merge is staged with `--no-commit`; if post-merge validation fails or a validator mutates the controller workspace, the controller aborts the merge, cleans validator side effects, leaves the node incomplete, and sends a `POST_MERGE_VALIDATION` follow-up to the subagent. Nodes without this gate keep existing integration behavior.

`outputs` for native-git nodes are always relative to the subagent workspace root. Do not include `.worktrees/<name>/` in output paths. The runtime rejects native-git DAG nodes that declare `.worktrees/...` outputs because that couples validation to a parent checkout layout and causes the controller to look for nested worktrees.

A node can optionally bind its subagent workspace deterministically:

```json
{
  "id": "tw-namespace-architecture",
  "workspaceStrategy": "native-git-worktree",
  "workspace": {
    "worktreeSlug": "65f61476-tw-namespace-architecture",
    "branch": "refactor/65f61476-tw-namespace-architecture",
    "baseRef": "goal/goal-6ce-implement-the-approved-tw-reg-lsa-people-frappe-"
  },
  "outputs": [
    "projects/backend/module/people-frappe-module/beyourself_people/reg_lsa/tw",
    "projects/backend/module/people-frappe-module/tests"
  ]
}
```

When `workspace.worktreeSlug` or `workspace.branch` is present, the native-git allocator creates or reuses that exact subagent worktree/branch, failing closed if an existing worktree is on another branch or dirty. This makes the subagent join a controller-assigned workspace instead of inventing a path.

Integration metadata is stored on the subagent record:

- `integrationState`: `pending`, `integrating`, `complete`, `failed`, or `not-required`
- `integrationSourceBranch` / `integrationSourceRef` / `integrationSourceHead`
- `integrationCommitSha`
- `integrationError` and human-readable `integrationStatus`

A node is not considered complete until required integration is `complete` or `not-required`. Dependent nodes and final audit nodes stay blocked while required upstream integration is pending or failed. If the source branch has no changes already outside the controller branch, integration is recorded as `not-required`. If the source or controller worktree has uncommitted changes, or a merge conflict occurs, integration fails closed and the subagent receives a follow-up prompt to commit/rebase/resolve before reporting again.

Subagents running in native-git workspaces should commit intended repository changes on their assigned branch before reporting `SUBAGENT_RESULT:`. Uncommitted changes cannot be safely merged by the controller.

## Defaults

`defaults` supports:

```json
{
  "outputs": ["path"],
  "validators": ["command"],
  "workspaceStrategy": "native-git-worktree",
  "completionGates": ["controller-validation"],
  "conflicts": {
    "files": ["path"],
    "modules": ["module"],
    "capabilities": ["capability"]
  },
  "modelScenario": "implementation",
  "thinkingLevel": "high"
}
```

A node-level field overrides the corresponding default. For example, if `defaults.validators` is set and a node also has `validators`, only the node's validators are used for that node. `defaults.thinkingLevel` is applied to nodes that do not set `thinkingLevel`.

## Model routing

`modelRouting` lets a DAG declare named model scenarios first, then let the controller choose a scenario for each node as it schedules subagents.

```json
{
  "modelRouting": {
    "scenarios": {
      "controller": {
        "model": "openai-codex/gpt-5.5",
        "description": "Long-horizon goal supervision"
      },
      "implementation": {
        "model": "openai-codex/gpt-5.5"
      },
      "docs": {
        "model": "openai/gpt-5-mini"
      },
      "review": {
        "model": "anthropic/claude-opus"
      }
    },
    "controllerScenario": "controller",
    "defaultSubagentScenario": "implementation",
    "rules": [
      {
        "scenario": "docs",
        "when": {
          "scopes": ["docs"],
          "risks": ["low"]
        }
      },
      {
        "scenario": "review",
        "when": {
          "objectiveIncludes": ["validate", "review", "archive"]
        }
      }
    ]
  }
}
```

Scenario ids must match `^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$`. `model` is the adapter-neutral canonical `provider/model` string; harness adapters translate it into their native request shapes.

Selection order for subagents:

1. node-level `modelScenario`
2. `defaults.modelScenario`
3. first matching `modelRouting.rules[]`
4. `modelRouting.defaultSubagentScenario`
5. the current Pi session model

Rule `when` supports:

- `nodeIds`
- `scopes`
- `risks`
- `modules`
- `capabilities`
- `files`
- `objectiveIncludes`
- `hasValidators`
- `hasOutputs`

The selected scenario and model are persisted on the durable DAG node so later scheduling/recovery can keep using the same model choice.

Pi also accepts a reusable model-routing config outside the DAG file:

```bash
AGENT_GOAL_MODEL_ROUTING_FILE=.goal/models.json
# or
AGENT_GOAL_MODEL_ROUTING_JSON='{ "scenarios": { "implementation": { "model": "openai-codex/gpt-5.5" } }, "defaultSubagentScenario": "implementation" }'
```

A DAG file's `modelRouting` takes precedence over environment-provided routing.

## Conflict hints

Conflict hints help the scheduler avoid running overlapping nodes together when concurrency is greater than one:

```json
{
  "conflicts": {
    "files": ["projects/backend/module/people-frappe-module/beyourself_people/payroll"],
    "modules": ["people-frappe-module"],
    "capabilities": ["payroll"]
  }
}
```

Supported conflict fields:

- `files`
- `modules`
- `capabilities`

## Validation rules

The runtime rejects invalid DAG files before starting work:

- malformed JSON
- missing or unsupported `version`
- missing root `objective`
- empty `nodes`
- node ids that are not kebab-case
- duplicate node ids
- missing dependencies
- self-dependencies
- cycles, via the normal DAG validation step
- non-array `after`, `outputs`, `validators`, or conflict lists
- invalid `risk`
- model-routing scenario references that do not exist in the DAG file's `modelRouting.scenarios`
- too many nodes (default max: 20)

## Validator execution

Validators are recorded in the DAG by default. Pi and OpenCode controller validation always execute declared shell validators. Nodes that declare validators cannot pass validation on self-report alone; if a custom host explicitly disables validator execution, skipped validators are treated as failed validation evidence.

## Text objective behavior

Text objectives no longer define DAG nodes. This input:

```text
/goal Implement feature:
- [id: a] A
- [id: b] B [after: a]
```

creates **one** execution node containing the whole objective text. To create multiple nodes, place the DAG in a JSON file and run:

```text
/goal --dag path/to/goal.dag.json
```
