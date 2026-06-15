# Project Responsibility

Status: authoritative project-boundary document for this repository.

This document defines what this repository owns, what it must not own, and which artifact contracts it must honor. The repository should not need to know which concrete repository implements an upstream stage.

## Pipeline contract

```text
Stage 1: Specification Authoring   user intent -> governed specification package
Stage 2: Execution Planning        specification/development document -> runtime DAG JSON + optional planning trace
Stage 3: Runtime Execution         runtime DAG JSON or single objective -> durable execution state
```

This repository implements **Stage 3: Runtime Execution**.

It must know the runtime DAG JSON contract. It must not depend on, call into, or name a concrete specification-authoring or execution-planning repository.

## Owns

This repository owns:

- runtime command behavior;
- single-objective execution through a runtime objective command;
- explicit multi-node DAG execution through a runtime DAG file command;
- runtime DAG JSON schema;
- runtime DAG parser;
- graph validation;
- model-routing application at runtime;
- durable goal state;
- DAG node and subagent records;
- controller orchestration loop;
- harness-neutral subagent adapter contract;
- supported harness adapter behavior;
- native Git workspace allocation strategy;
- validator execution;
- controller validation results;
- branch/worktree integration;
- continuation, pause/resume, completion, blocked, budget, and usage lifecycle;
- durable lifecycle ledger.

## Does not own

This repository must not own or perform:

- user-goal value challenge;
- governed specification authoring;
- specification package creation or modification;
- development-document-to-DAG planning;
- producer-side planning spec parsing;
- planning trace sidecar generation;
- dependency inference from PRDs, specification packages, tickets, or markdown task lists;
- automatic multi-node planning from prose;
- treating human-readable explainers, source manifests, or planning traces as runtime source of truth.

## Inputs

Valid Stage 3 inputs are:

```text
single objective command
runtime DAG JSON file command
```

A single objective command creates exactly one execution node. It must not parse markdown lists, headings, bullets, or informal task descriptions into multiple DAG nodes.

A runtime DAG JSON file command loads a file matching `schemas/goal-dag.schema.json`. The objective and nodes come from the DAG file. Additional objective text is not accepted.

## Does not consume

This repository must not consume these as runtime input:

- producer-side planning spec documents;
- planning trace sidecars;
- governed specification package directories;
- source manifests;
- human-readable explainers;
- PRDs;
- design docs;
- ticket descriptions;
- markdown task lists.

Those inputs belong to earlier stages before runtime execution begins.

## Outputs

This repository produces durable runtime state, including:

- goal records;
- DAG node records;
- subagent records;
- controller validation results;
- integration results;
- completion/blocking evidence;
- lifecycle ledger entries;
- status and monitor views.

It does not produce governed specification packages, producer-side planning specs, `.dag.json`, or `.trace.json` files.

## Runtime DAG contract

This repository is the source of truth for runtime DAG JSON. The parser and schema define accepted fields and validation rules.

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

## Handoff contract

This repository receives only the runtime DAG JSON file as multi-node runtime input.

If an upstream stage also created a planning trace sidecar, that file remains a review/audit artifact for humans and producer workflows. It must not affect runtime scheduling, validation, model routing, workspace allocation, validator execution, or completion.

## Drift prevention rules

A change to this repository is suspicious and requires boundary review if it:

- parses PRDs, specification packages, tickets, or markdown task lists into DAG nodes;
- introduces producer-side planning specs as runtime input;
- reads planning traces as runtime input;
- reads source manifests as runtime input;
- treats human-readable explainers as runtime source of truth;
- creates or modifies governed specification source packages;
- emits `.dag.json` or `.trace.json` as producer output;
- moves producer-side planning logic into runtime adapters;
- weakens rejection of producer-only metadata in runtime DAG JSON;
- requires a concrete upstream repository name to function.

## Reviewer checklist

Before merging a change to this repository, verify:

- single-objective execution still creates exactly one execution node;
- runtime DAG execution still requires explicit runtime DAG JSON;
- additional objective text after a DAG file input is rejected;
- planning trace sidecars are not runtime input;
- governed specification packages are not runtime input;
- producer-only fields are rejected by the runtime parser;
- schema, parser, docs, source, and committed build artifacts agree;
- supported harness adapters preserve the same core runtime semantics;
- the repository does not need to know the concrete repository names of earlier stages.
