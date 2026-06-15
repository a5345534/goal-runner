# Pipeline boundaries

`goal-runner` is Stage 3 of the goal execution pipeline:

```text
Goal DAG JSON -> runtime execution
```

It is the portable `/goal` runtime. Producer tools may create DAG JSON, but this repository owns the runtime contract that Pi/OpenCode execute.

## Stage 3: goal-runner

### Inputs

- `/goal <objective>` for single-node execution.
- `/goal --dag <path>` for explicit multi-node execution.

### Consumes

- Runtime DAG JSON matching [`schemas/goal-dag.schema.json`](../schemas/goal-dag.schema.json).

### Does not consume

- `GoalDagSpec` producer documents.
- Goal-DAG trace sidecars such as `.trace.json`.
- OpenSpec source packages.
- `source-manifest.json`.
- `change-explainer.html`.
- PRD, design, ticket, or markdown task-list prose.

### Owns

- DAG JSON schema.
- DAG parser.
- Graph validation.
- Node scheduling.
- Model-routing application.
- Controller/subagent state.
- Workspace allocation strategy.
- Validator execution.
- Completion audit.
- Lifecycle ledger.

### Must not

- Infer DAG nodes from prose.
- Modify producer trace metadata.
- Rewrite OpenSpec specs.

## Runtime outputs

Given a single objective or explicit DAG JSON, `goal-runner` produces durable runtime state only:

- Goal state.
- DAG node and subagent state.
- Lifecycle ledger entries.
- Controller validation results.
- Terminal states such as `complete`, `blocked`, `paused`, `budgetLimited`, and `usageLimited`.

## Producer responsibilities

Producer stages are responsible for converting PRDs, OpenSpec changes, tickets, or other planning sources into runtime DAG JSON before invoking `/goal --dag`. If a producer emits trace sidecar data, that sidecar is for review/audit workflows and humans; it is not runtime input and must not affect scheduling, validation, model routing, or completion.
