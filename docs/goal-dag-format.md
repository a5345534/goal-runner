# Goal DAG file format

`/goal` uses a dedicated JSON DAG file for multi-node execution. The runtime no longer parses markdown task lists or headings from free-form objective text.

- Use `/goal <objective>` for a single execution node.
- Use `/goal --dag <path>` for an explicit multi-node DAG.

The JSON schema lives at [`schemas/goal-dag.schema.json`](../schemas/goal-dag.schema.json).

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
    }
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
| `after` | no | array of node ids | Dependencies that must be `complete` before this node can run. |
| `outputs` | no | string array | Expected files/directories checked by controller validation. |
| `validators` | no | string array | Shell validators for controller validation. |
| `conflicts` | no | object | File/module/capability conflict hints for scheduler serialization. |
| `scope` | no | string | Human-readable scope label. |
| `workspaceStrategy` | no | string | Workspace allocation strategy. Defaults to native Git worktree in Pi. |
| `risk` | no | `low` / `medium` / `high` | Risk label for scheduling/model-routing/review policy. |
| `completionGates` | no | string array | Completion gates. Defaults to `controller-validation`. |
| `modelScenario` | no | scenario id | Explicit model-routing scenario for this node. Overrides defaults and rules. |

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
  "modelScenario": "implementation"
}
```

A node-level field overrides the corresponding default. For example, if `defaults.validators` is set and a node also has `validators`, only the node's validators are used for that node.

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

Scenario ids must match `^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*$`. `model` is the harness-native model string; in Pi this is the same `provider/model` shape accepted by Pi package model arguments.

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

Validators are recorded in the DAG by default. Pi executes validators only when validator execution is explicitly enabled:

```bash
AGENT_GOAL_PI_RUN_VALIDATORS=1
# or
PI_GOAL_RUN_VALIDATORS=1
```

When disabled, validators are reported as skipped controller checks rather than run in the shell.

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
