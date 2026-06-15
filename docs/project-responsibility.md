# Project Responsibility

Status: authoritative project-boundary document for `goal-runner`.

This document defines what this repository owns, what it must not own, and how it consumes work from the three-stage goal execution pipeline.

## Pipeline position

```text
Stage 1: goal-spec   user goal -> OpenSpec change package
Stage 2: goal-dag    OpenSpec/PRD/design/ticket -> validated Goal DAG JSON + optional trace
Stage 3: goal-runner Goal DAG JSON -> runtime execution
```

`goal-runner` is Stage 3 only. Its job is to execute a single objective or an explicit runtime DAG JSON file through the portable `/goal` runtime and harness adapters.

## Owns

`goal-runner` owns:

- `/goal` command behavior;
- single-objective goal execution through `/goal <objective>`;
- explicit multi-node DAG execution through `/goal --dag <path>`;
- runtime DAG JSON schema;
- runtime DAG parser;
- graph validation;
- model-routing application at runtime;
- durable goal state;
- DAG node and subagent records;
- controller orchestration loop;
- harness-neutral subagent adapter contract;
- Pi adapter behavior;
- OpenCode adapter behavior;
- native Git workspace allocation strategy;
- validator execution;
- controller validation results;
- branch/worktree integration;
- continuation, pause/resume, completion, blocked, budget, and usage lifecycle;
- durable lifecycle ledger.

## Does not own

`goal-runner` must not own or perform:

- user-goal value challenge;
- OpenSpec authoring;
- OpenSpec change package creation or modification;
- development-document-to-DAG planning;
- `GoalDagSpec` producer parsing;
- planning trace sidecar generation;
- dependency inference from PRDs, OpenSpec, tickets, or markdown task lists;
- automatic multi-node planning from prose;
- treating `change-explainer.html`, `source-manifest.json`, or `.trace.json` as runtime source of truth.

## Inputs

Valid Stage 3 inputs are:

```text
/goal <objective>
/goal --dag <path>
```

`/goal <objective>` creates exactly one execution node. It must not parse markdown lists, headings, bullets, or informal task descriptions into multiple DAG nodes.

`/goal --dag <path>` loads a runtime DAG JSON file matching `schemas/goal-dag.schema.json`. The objective and nodes come from the DAG file. Additional objective text is not accepted.

## Does not consume

`goal-runner` must not consume these as runtime input:

- `GoalDagSpec` producer documents;
- `.trace.json` planning sidecars;
- OpenSpec change directories;
- `source-manifest.json`;
- `change-explainer.html`;
- PRDs;
- design docs;
- ticket descriptions;
- markdown task lists.

Those inputs belong to `goal-spec` or `goal-dag` before runtime execution begins.

## Outputs

`goal-runner` produces durable runtime state, including:

- goal records;
- DAG node records;
- subagent records;
- controller validation results;
- integration results;
- completion/blocking evidence;
- lifecycle ledger entries;
- status and monitor views.

It does not produce OpenSpec packages, `GoalDagSpec`, `.dag.json`, or `.trace.json` files.

## Runtime DAG contract

`goal-runner` is the source of truth for runtime DAG JSON. The parser and schema define accepted fields and validation rules.

Runtime DAG JSON may include:

- root `version`, `objective`, `defaults`, `modelRouting`, and `nodes`;
- node `id`, `objective`, `after`, `outputs`, `validators`, `conflicts`, `scope`, `kind`, `validation`, `workspaceStrategy`, `workspace`, `risk`, `completionGates`, `modelScenario`, and `thinkingLevel`;
- defaults such as `validators`, `workspaceStrategy`, `completionGates`, `conflicts`, `modelScenario`, and `thinkingLevel`;
- validation contract fields such as `profile`, `testSpecNodeId`, `approvedByNodeId`, `artifactLocks`, `requiredEvidence`, `diffBaseRef`, `auditReportPaths`, `allowedPaths`, and `forbiddenPaths`.

Producer-only metadata must be rejected by the runtime parser, including:

- root `openQuestions`;
- node `consumes`;
- node `produces`;
- node `evidence`;
- node `modelRationale`;
- node `acceptanceCriteria`;
- node `decompositionRationale`.

## Handoff from `goal-dag`

`goal-runner` receives only the runtime DAG JSON:

```text
/goal --dag <name>.dag.json
```

If a producer also created `<name>.trace.json`, that file remains a review/audit artifact for humans and producer workflows. It must not affect runtime scheduling, validation, model routing, workspace allocation, validator execution, or completion.

## Drift prevention rules

A change to this repository is suspicious and requires boundary review if it:

- parses PRDs, OpenSpec, tickets, or markdown task lists into DAG nodes;
- introduces `GoalDagSpec` as runtime input;
- reads `.trace.json` as runtime input;
- reads `source-manifest.json` as runtime input;
- treats `change-explainer.html` as runtime source of truth;
- creates or modifies OpenSpec source packages;
- emits `.dag.json` or `.trace.json` as producer output;
- moves producer-side planning logic into runtime adapters;
- weakens rejection of producer-only metadata in runtime DAG JSON.

## Reviewer checklist

Before merging a change to `goal-runner`, verify:

- `/goal <objective>` still creates exactly one execution node;
- `/goal --dag <path>` still requires explicit runtime DAG JSON;
- additional objective text after `--dag` is rejected;
- trace sidecars are not runtime input;
- OpenSpec packages are not runtime input;
- producer-only fields are rejected by the runtime parser;
- schema, parser, docs, source, and committed `dist/` artifacts agree;
- Pi and OpenCode adapters preserve the same core `/goal` semantics.
