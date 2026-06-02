# Goal DAG objective format

`/goal <objective>` supports an explicit, deterministic DAG format embedded in the objective text. The runtime does **not** infer a multi-node plan from prose. If no explicit task lines are found, the objective becomes one execution node.

Use this format when you want predictable DAG execution, subagent assignment, dependencies, outputs, and validators.

## Quick example

```text
/goal Implement People Frappe payroll:
- [id: propose-payroll] Create OpenSpec change for payroll DocTypes [outputs: openspec/changes/implement-people-payroll-doctypes/tasks.md]
- [id: payroll-doctypes] Add payroll DocType skeletons [after: propose-payroll] [files: projects/backend/module/people-frappe-module/beyourself_people/payroll]
- [id: payroll-tests] Add payroll contract tests [after: payroll-doctypes] [validators: python3 -m unittest discover projects/backend/module/people-frappe-module/tests]
- [id: archive] Archive the OpenSpec change after merge [after: payroll-tests]
```

This produces four DAG nodes. By default, task lists are sequential, so `payroll-doctypes` would also depend on `propose-payroll` even without `[after: propose-payroll]`. The explicit dependency is still recommended for readability.

## What counts as a DAG node

The deterministic planner creates one node for each matching line:

```text
- bullet task
* bullet task
+ bullet task
- [ ] markdown checkbox task
- [x] completed-looking checkbox task
1. numbered task
1) numbered task
## heading task
### heading task
###### heading task
```

Other prose lines are retained in the overall objective but do not become nodes.

If the objective contains **no** matching task lines or headings, the planner creates one fallback node for the whole objective.

## Node id and slug

Each node has a normalized id/slug:

1. If `[id: ...]` is present, the id is based on that value.
2. Otherwise, the id is based on the task text after removing annotations.

Normalization:

- lower-case
- non-`a-z0-9` characters become `-`
- repeated `-` collapse
- leading/trailing `-` are removed

Examples:

```text
- [id: Payroll DocTypes] Add payroll DocTypes
```

becomes:

```text
payroll-doctypes
```

```text
- Add payroll DocTypes
```

becomes:

```text
add-payroll-doctypes
```

Prefer explicit `[id: kebab-case]` for stable dependencies.

## Dependency semantics

Default task-list dependency mode is **sequential**:

```text
- [id: a] A
- [id: b] B
- [id: c] C
```

means:

```text
a -> b -> c
```

Use `[parallel]` or `[independent]` to opt a node out of the inferred dependency on the previous node:

```text
- [id: docs] Update docs
- [id: tests] Add tests [parallel]
```

Use explicit dependencies with `[after: ...]`:

```text
- [id: schema] Add schema
- [id: api] Add API [after: schema]
- [id: docs] Update docs [after: schema]
```

Dependency aliases:

```text
[after: node-id]
[dep: node-id]
[depends: node-id]
[dependencies: node-id]
```

Multiple dependencies can be separated by comma or pipe:

```text
- [id: archive] Archive [after: tests, docs]
- [id: archive] Archive [after: tests | docs]
```

Dependency values are normalized the same way as ids, so `[after: Payroll DocTypes]` refers to `payroll-doctypes`.

Important: when explicit dependencies are present, they replace the inferred sequential dependency for that node.

## Outputs

Expected outputs declare files or directories the controller should validate after a subagent self-reports completion:

```text
- [id: tests] Add tests [outputs: projects/backend/module/people-frappe-module/tests/test_payroll_doctypes.py]
```

Aliases:

```text
[outputs: path]
[output: path]
[expected-output: path]
[expected-outputs: path]
```

Multiple outputs use comma or pipe:

```text
[outputs: file-a.py, file-b.py]
[outputs: file-a.py | file-b.py]
```

## Validators

Validators declare shell commands for controller validation:

```text
- [id: tests] Run tests [validators: npm run check]
```

Aliases:

```text
[validators: command]
[validator: command]
[checks: command]
[check: command]
```

Multiple validators use comma or pipe:

```text
[validators: npm run check, npm run lint]
[validators: npm run check | npm run lint]
```

Pi executes validators only when validator execution is explicitly enabled:

```bash
AGENT_GOAL_PI_RUN_VALIDATORS=1
# or
PI_GOAL_RUN_VALIDATORS=1
```

When validator execution is disabled, validators are recorded as skipped controller checks rather than run in the shell.

## Conflict hints

Conflict hints help the scheduler avoid running overlapping nodes together when concurrency is greater than one:

```text
- [id: payroll] Add payroll DocTypes [files: projects/backend/module/people-frappe-module/beyourself_people/payroll]
- [id: reg-lsa] Add LSA importer [modules: people-frappe-module] [capabilities: regulatory-lsa]
```

Supported hints:

```text
[files: path-a, path-b]
[file: path]
[modules: module-a]
[module: module-a]
[capabilities: capability-a]
[capability: capability-a]
```

Multiple values use comma or pipe.

## Supported annotation summary

| Annotation | Aliases | Meaning |
| --- | --- | --- |
| `[id: value]` | none | Stable node id/slug. |
| `[after: value]` | `dep`, `depends`, `dependencies` | Explicit dependency node ids. |
| `[parallel]` | `[independent]` | Opt out of inferred sequential dependency. |
| `[outputs: value]` | `output`, `expected-output`, `expected-outputs` | Expected output paths. |
| `[validators: value]` | `validator`, `checks`, `check` | Controller validator commands. |
| `[files: value]` | `file` | File conflict hints. |
| `[modules: value]` | `module` | Module conflict hints. |
| `[capabilities: value]` | `capability` | Capability conflict hints. |

## Limits and validation

The planner validates the generated DAG before execution:

- duplicate node ids are rejected
- missing dependencies are rejected
- self-dependencies are rejected
- cycles are rejected
- the deterministic objective planner emits at most 20 nodes by default

For large goals, split into fewer high-level nodes and let each node own a coherent slice.

## Recommended style

Use explicit ids and dependencies for durable, reviewable plans:

```text
/goal Complete People Frappe backend remaining slices:
- [id: attendance-parity] Add attendance parity fixtures [outputs: projects/backend/module/people-frappe-module/tests/test_attendance_parity.py]
- [id: payroll-doctypes] Add payroll DocTypes [parallel] [files: projects/backend/module/people-frappe-module/beyourself_people/payroll]
- [id: people-event-bridge] Add narrow people event bridge OpenSpec [parallel] [modules: people-event-bridge]
- [id: integration-validation] Run integrated validation [after: attendance-parity, payroll-doctypes, people-event-bridge] [validators: python3 -m unittest discover projects/backend/module/people-frappe-module/tests]
```

Use prose before or after the task list for global constraints. Prose does not create nodes, but it remains part of the goal objective and is included in subagent prompts.
