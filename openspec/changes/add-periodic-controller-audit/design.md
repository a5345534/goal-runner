# Design: add-periodic-controller-audit

## Context

Issue #39 follow-up design spec proposed a periodic controller audit agent that runs at a fixed low frequency, inspects structured recent execution state for unhealthy patterns, and can safely pause or escalate when it detects no-progress loops, cost spikes, or invalid-contract patterns.

The existing controller loop is an execution supervisor: sync subagents, reconcile outcomes, validate, integrate, start ready nodes. It is deterministic and cheap by design. It does not have a periodic diagnostic path that can detect time-window patterns across multiple ticks.

This change adds that diagnostic path as a separate, optional, configurable audit layer.

### Relationship to Phase 1

Phase 1 (`close-required-evidence-contract`) is the deterministic fix for the known invalid-contract class. This change is the protective layer for unknown future failure patterns. Layering:

```text
1. Deterministic contract validation → known invalid contracts fail fast or block.
2. Controller execution loop → runs scheduler, subagents, validation, integration, recovery.
3. Periodic controller audit agent → low-frequency watchdog for unknown patterns, no-progress loops, and cost risk.
```

## Spec Kernel

- Why: protect execution from unknown retry-loop / no-progress / cost-spike failure patterns that deterministic rules don't model.
- Value gate outcome: `proceed_to_spec` with smaller-scope: pause-on-critical only.
- Capabilities:
  - `controller-audit-agent`: periodic structured execution health review with safe automatic protective actions.
- Constraints:
  - Audit agent must not complete, merge, modify code, modify DAG, replan, or override deterministic validation.
  - Audit input is bounded structured trusted state, not full raw transcript by default.
  - Audit output is schema-validated JSON; invalid output is recorded and ignored.
  - `pause-goal` is the only automatic action; all others require deterministic confirmation.
- Non-goals:
  - Planning, code modification, DAG modification, completion, merge, validation override, transcript matching.
- Success signal: simulated retry-loop triggers critical-risk `pause-goal`, ledger records event, monitor displays finding; healthy progress returns noop.

## Goals

- Add a low-frequency audit path separate from the deterministic controller loop.
- Build a bounded structured snapshot from runtime state (goal, nodes, subagents, recent events, progress signals).
- Invoke a controller audit model and validate structured JSON output.
- Apply `pause-goal` automatically for high-confidence critical findings.
- Record audit events durably and surface them in goal monitor/status.

## Non-Goals

- Do not generate or modify DAG plans, code, or runtime DAG.
- Do not mark nodes or goals complete.
- Do not merge branches or delete workspaces.
- Do not override deterministic validation.
- Do not implement automatic `cap-retries`, `stop-launching-new-subagents`, `mark-node-blocked` here.
- Do not include full raw transcripts in audit input by default.
- Do not replace Phase 1 contract closure.

## Concern Scan

| Concern | Relevance | Design response |
| --- | --- | --- |
| Audit agent authority | An LLM-driven diagnostic must not gain planning or completion power. | Strict system prompt, schema-validated output only, `pause-goal` as the only auto action, all irreversible actions require deterministic confirmation. |
| Cost of audit model | Regular LLM calls add token cost. | Default 30-minute interval, bounded snapshot size, configurable cost caps. |
| Audit accuracy | Model may produce false positives or miss patterns. | Validation output with risk/confidence; low-confidence and noop results do not mutate state. Critical with high-confidence only triggers auto pause. |
| State snapshot drift | Snapshot fields must stay aligned with runtime state shape. | Generate snapshot deterministically from existing trusted state APIs. |
| Monitor UX | Users need to see audit findings without excessive noise. | Single line summary in monitor; low-risk/noop findings can be compact. |
| Configuration complexity | Too many knobs make the feature hard to use safely. | Default to sensible values; only `enabled`, `intervalMs`, and `pauseOnCritical` are user-facing initially. |

## Decisions

### D0. Value path

**Choice**
Proceed to spec with smaller-scope: minimum viable audit with `pause-goal` as the only automatic action.

**Rationale**
Issue #39 design already describes a full audit model with many action types. This change reduces to the smallest surface that provides immediate safety value: detect a critical unhealthy pattern and pause to stop the token leak.

**Alternatives considered**
- No-build: rejected because deterministic rules cannot protect against unknown future patterns.
- Full audit model with all action types: deferred because some actions (cap-retries, mark-node-blocked) require more design and testing; they can be added incrementally after the core audit path is proven.

### D1. Separate audit path, not inline in controller tick

**Choice**
Add `runGoalControllerAudit()` as a separate function, called by the controller poller/loop after the deterministic tick when the audit interval has elapsed.

**Rationale**
Keeping audit separate from the tick avoids coupling execution supervision and diagnostic review. The deterministic tick remains cheap and predictable.

**Alternatives considered**
- Inline audit in every tick: rejected because audit model invocation is much more expensive than deterministic sync/validate operations.
- Async/background audit: possible future optimization, but initial implementation can block the poller briefly.

### D2. Bounded structured snapshot, not transcript by default

**Choice**
Audit input is a structured JSON snapshot built from `GoalOrchestrationState` and recent `GoalLedgerEvent` entries. It does not include raw subagent transcripts unless explicitly enabled with `includeTranscriptExcerpts: true`.

**Rationale**
Transcripts are large, unbounded, and untrusted. Structured state is deterministic, bounded, and trusted. The audit agent diagnoses execution health from execution metadata.

**Alternatives considered**
- Always include transcript excerpts: rejected because it increases token cost, leaks subagent content into audit, and risks prompt-injection through subagent output.

### D3. Pause-goal as the only automatic action

**Choice**
When the audit decision risk is `critical` and the finding confidence is `high`, and `pauseOnCritical` is enabled, the runtime automatically pauses the goal.

**Rationale**
Pausing is reversible and safe; it stops token/cost bleed immediately. Other actions (reducing concurrency, capping retries, blocking nodes) require more nuanced policy and are better kept as recommendations for human review or future deterministic automation.

**Alternatives considered**
- Auto-block nodes: requires deterministic re-confirmation; unsafe to delegate to model without a secondary deterministic check.
- Auto-cap retries: useful but depends on existing retry cap configuration which may not exist yet.

### D4. JSON schema-validated audit output

**Choice**
The audit model prompt requires JSON output matching a strict TypeScript schema. The runtime validates the returned JSON against the schema. Invalid output is recorded and ignored; valid findings are processed.

**Rationale**
Free-form text from the model cannot be safely actioned. Structured output with enumerated finding kinds and action types makes the runtime decision path reviewable and testable.

## Detailed Design

### Data / Contract Changes

New TypeScript types (likely in `src/core/controller-audit.ts` or `src/core/types.ts`):

```ts
export interface GoalControllerAuditOptions {
  enabled?: boolean;
  intervalMs?: number;        // default: 30 * 60 * 1000
  maxRecentEvents?: number;    // default: 200
  maxRecentValidationResults?: number; // default: 50
  maxTokensPerAudit?: number;
  pauseOnCritical?: boolean;   // default: true
  includeTranscriptExcerpts?: boolean; // default: false
}

export interface GoalControllerAuditSnapshot {
  goal: {
    goalId: string;
    status: string;
    ageMinutes?: number;
    tokensUsed?: number;
    lastProgressAt?: string;
  };
  nodes: Array<{
    nodeId: string;
    status: string;
    lifecyclePhase?: string;
    retryCount?: number;
    lastValidationSummary?: string;
    lastUpdatedAt?: string;
  }>;
  subagents: Array<{
    subagentId: string;
    nodeId: string;
    status: string;
    retryCount?: number;
    lastActivityAt?: string;
    lastAdapterObservation?: string;
    integrationState?: string;
  }>;
  recentControllerEvents: Array<{
    at: string;
    type: string;
    nodeId?: string;
    subagentId?: string;
    summary?: string;
  }>;
  recentValidationSummaries: Array<{
    nodeId: string;
    summary: string;
    countInWindow: number;
  }>;
  progressSignals: {
    completedNodesLastWindow: number;
    validationFailuresLastWindow: number;
    followupsLastWindow: number;
    retriesLastWindow: number;
    integrationsFailedLastWindow: number;
  };
  costSignals?: {
    tokensLastWindow?: number;
    estimatedCostLastWindow?: number;
  };
}

export interface GoalControllerAuditDecision {
  risk: "low" | "medium" | "high" | "critical";
  summary: string;
  findings: Array<{
    kind:
      | "retry-loop"
      | "no-progress"
      | "invalid-contract-suspected"
      | "cost-spike"
      | "stale-runner"
      | "repeated-validation-failure"
      | "integration-loop"
      | "provider-or-quota-issue"
      | "unknown";
    nodeId?: string;
    subagentId?: string;
    evidence: string[];
    confidence: "low" | "medium" | "high";
  }>;
  recommendedActions: Array<{
    action:
      | "noop"
      | "pause-goal"
      | "cap-retries"
      | "stop-launching-new-subagents"
      | "reduce-concurrency"
      | "request-user-intervention"
      | "open-diagnostic-report"
      | "run-deterministic-contract-check"
      | "mark-node-blocked";
    nodeId?: string;
    subagentId?: string;
    reason: string;
    requiresUserApproval: boolean;
  }>;
}
```

New ledger event types: `controller_audit_started`, `controller_audit_finished`, `controller_audit_invalid_output`, `controller_audit_action_applied`, `controller_audit_action_skipped`, `goal_paused_by_controller_audit`.

### Execution Flow

1. Controller poller/tick runs the normal deterministic execution loop.
2. After the tick, check whether audit is due for the current active goal (compare `lastAuditAt + intervalMs` to `now()`).
3. If due:
   a. Load current `GoalOrchestrationState`.
   b. Load recent ledger events within the audit window.
   c. Build bounded `GoalControllerAuditSnapshot`.
   d. Invoke controller audit model with strict system prompt and output JSON schema.
   e. Parse and validate returned `GoalControllerAuditDecision`.
   f. If invalid, record `controller_audit_invalid_output`, skip.
   g. Record `controller_audit_finished` with the validated decision.
   h. For each recommended action:
      - If `action === "pause-goal"` and `risk === "critical"` and `confidence === "high"` and `pauseOnCritical` is enabled: apply pause automatically, record `goal_paused_by_controller_audit`.
      - All other actions: record as `controller_audit_action_skipped` (deferred for human review or future deterministic confirmation).
   i. Update `lastAuditAt` timestamp.
4. Surface latest audit finding in monitor/status.

### Module Boundaries

- `src/core/controller-audit.ts` or similar: audit snapshot builder, audit decision validator, safe action policy.
- `src/core/controller-loop.ts`: audit scheduling gate after tick.
- `src/core/types.ts`: audit snapshot/decision types, audit options.
- `src/core/memory-store.ts` / `src/core/sqlite-store.ts`: ledger event recording for new audit event types.
- `src/adapters/pi/monitor-ui.ts` / `src/adapters/opencode/monitor-ui.ts`: audit summary display.
- `src/core/prompts.ts` or similar: controller audit model system prompt.

### Migration / Rollout

- No DB schema migration required: new ledger event types are added to the existing event model.
- Default: audit disabled or interval set to 30 minutes. Users can enable/configure.
- Existing goals are unaffected; audit only applies to goals active after deployment.
- No runtime DAG file format changes.

## Risks

| Risk | Severity | Mitigation |
| --- | --- | --- |
| Model produces invalid JSON | Medium | Validate output; record and ignore invalid audit decisions. |
| Model recommends unsafe action | High | Only `pause-goal` is automatic; all other actions require deterministic confirmation. |
| Audit cost exceeds tolerance | Medium | Configurable `maxTokensPerAudit`; bounded snapshot; default 30-minute interval. |
| Snapshot misses critical signals | Medium | Snapshot shape designed from Issue #39 observed patterns; can be extended. |
| Pause-on-false-positive blocks legitimate progress | Medium | Requires `critical` risk + `high` confidence, both required for auto pause. User can resume. |

## Verification Plan

- Unit tests for audit-due scheduling, snapshot building, decision validation, and action policy.
- Scenario tests for retry-loop detection, no-progress detection, cost-spike detection, invalid audit output handling, and healthy-progress noop.
- Monitor display tests for audit summary rendering.
- `npm run check`.

## Execution Handoff Notes

This section records execution-planning evidence for downstream tools. It is not a DAG and does not assign runtime scheduling.

### Candidate Execution Slices

- Audit types and options: TypeScript interfaces, audit config model.
- Snapshot builder: deterministic structured snapshot from runtime state.
- Audit decision validation: JSON schema validation for model output.
- Safe action policy: pause-goal gate logic.
- Controller loop integration: audit scheduling gate after tick.
- Ledger recording: new event types in store.
- Monitor display: audit summary rendering.
- System prompt: audit model prompt contract.
- Tests and documentation.

### Ordering / Dependency Evidence

- Snapshot builder depends on audit types (needs snapshot shape).
- Decision validation depends on audit types (needs decision shape).
- Action policy depends on decision validation (needs validated risk/confidence).
- Controller loop integration depends on snapshot builder and action policy.
- Ledger recording and monitor display depend on decision/action shapes.
- All implementation depends on audit types landing first.

### Validation Signals

- `npm run check`
- Unit tests for each slice
- Scenario test: simulated retry-loop triggers pause
- Scenario test: healthy progress returns noop

### Open Questions Affecting Execution

- [ ] Should the audit model be configurable per-goal or global?
- [ ] Should `pause-goal` also trigger a user notification outside the monitor?

### Non-Goals for Execution

- Do not implement deterministic confirmation for `mark-node-blocked` or `invalid-contract-suspected`.
- Do not add transcript excerpts to audit input by default.
- Do not implement `cap-retries` auto-action.
- Do not modify the DAG runtime contract from Phase 1.

## Load-Bearing Preservation Notes

- Issue #39 comment #5/#6: periodic controller audit design → preserved in Context, D0, D1-D4, and spec.
- Principle: "Controller loop drives execution. Controller audit protects execution." → preserved in proposal Why and design Context.
- Safe action policy: pause-goal automatic, all others require confirmation → preserved in D3 and spec safety requirement.
- Bounded snapshot, no transcript by default → preserved in D2.
- Schema-validated JSON output → preserved in D4.
- Audit agent cannot complete/merge/replan/modify code → preserved in Constraints/N Goals and spec guardrail.
- Phase separation: this is Phase 3, not Phase 1 → preserved in Context and proposal Value Gate.
