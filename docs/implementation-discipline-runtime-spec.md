# Implementation Discipline Runtime Spec

Status: draft  
Owner: `goal-runner`  
Applies to: controller loop, subagent prompts, monitor operations, runtime validation, and adapter behavior

## Purpose

Apply Karpathy-inspired implementation discipline at execution time while preserving controller authority. Subagents should surface uncertainty, but they should not directly interrupt users. The controller triages questions, answers from context when possible, and escalates to humans only when necessary.

## Decisions

1. `implementation-discipline` is a runtime quality profile, not a package dependency.
2. Subagents ask the controller, not the user.
3. The controller chooses one of three outcomes for each subagent question:
   - answer from existing context;
   - approve a bounded safe assumption;
   - block/escalate for human input.
4. Minor ambiguity should not stop execution. The controller may instruct the subagent to use the recommended default and record the assumption.
5. Blocking ambiguity should become an actionable blocked node/subagent state visible in monitor/debug output.
6. Retry and continuation semantics remain separate:
   - node retry starts a fresh node attempt/resource path;
   - subagent continuation preserves the existing subagent/session/worktree and resets controller recovery state.

## Subagent Prompt Discipline

When a node has `implementation-discipline`, the initial prompt should tell the subagent to:

- state material assumptions instead of silently guessing;
- prefer the smallest implementation that satisfies the node objective and validation contract;
- avoid drive-by refactors and unrelated formatting/comment churn;
- keep all changes traceable to the node objective;
- verify with concrete commands or evidence;
- report uncertainty using the controller-facing question marker below.

## Controller-Facing Question Marker

A subagent may emit:

```text
SUBAGENT_QUESTION:
- question: <what needs to be decided>
- why it matters: <correctness/scope/compatibility/validation impact>
- options:
  - A: <summary and tradeoff>
  - B: <summary and tradeoff>
- recommended default: <option id or concrete assumption>
- blocking: yes|no
```

The marker is controller-facing. It is not a direct user prompt.

## Controller Triage

### 1. Answer from Context

If the controller can answer from DAG objective, OpenSpec/PRD text, validation contract, repository state, allowed paths, or prior ledger events, it sends a follow-up prompt to the same subagent with the answer and asks it to continue.

### 2. Bounded Assumption

If `blocking: no`, the controller should normally approve the recommended default, require the subagent to record the assumption in its final result, and continue execution.

### 3. Human Escalation

If `blocking: yes` and the controller cannot answer safely, the controller marks the node/subagent blocked with:

- the question;
- why it matters;
- options and tradeoffs;
- recommended default, if any;
- exact user/external input needed.

Monitor/debug should show this as actionable human-needed state. A future command may allow the user to answer and resume the same subagent.

## Validation and Audit Expectations

Runtime validation should reinforce the discipline where practical:

- flag missing verification evidence for implementation nodes;
- flag unrelated path changes when validation scope is available;
- request follow-up instead of accepting self-certification;
- avoid treating a subagent question as a terminal failure unless escalation is required.

## Monitor/UI Expectations

- Node pages expose node-level retry for fresh attempts.
- Subagent/runner pages expose same-subagent continuation.
- Future human-question UI should attach answers to the blocked subagent/node and resume the same subagent when possible.

## Acceptance Criteria

- A subagent can surface material uncertainty without directly asking the user.
- The controller can resolve or bound most questions from existing goal context.
- Human escalation is explicit, actionable, and visible in monitor/debug output.
- Same-subagent continuation and fresh node retry remain distinct operations.
