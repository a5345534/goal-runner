# controller-audit-agent Specification

## Purpose

This capability owns the periodic controller audit agent: a low-frequency diagnostic watchdog that inspects structured recent execution state for unhealthy patterns, returns schema-validated audit decisions, and can safely pause the goal when a critical retry-loop, no-progress, or cost-spike pattern is detected with high confidence. It complements—but does not replace—the deterministic controller loop and Phase 1 contract closure.

## Requirements

### Requirement: Audit runs at a configurable interval separate from the controller tick

`goal-runner` SHALL provide a periodic audit path that runs after the deterministic controller tick when the configured interval has elapsed. The audit path SHALL be optional; when disabled, no audit model invocation occurs.

#### Scenario: Audit triggers after interval elapses

- **GIVEN** audit is enabled with `intervalMs: 1800000` (30 minutes)
- **AND** the last audit ran more than 30 minutes ago
- **AND** a goal is active
- **WHEN** the controller completes a deterministic tick
- **THEN** an audit run is triggered

#### Scenario: Audit does not trigger before interval elapses

- **GIVEN** audit is enabled with `intervalMs: 1800000`
- **AND** an audit ran 5 minutes ago
- **WHEN** the controller completes a deterministic tick
- **THEN** no additional audit run is triggered

#### Scenario: Disabled audit never triggers

- **GIVEN** audit is disabled (`enabled: false`)
- **WHEN** the controller completes any number of ticks
- **THEN** no audit model invocation occurs

### Requirement: Audit snapshot is bounded structured state

The audit input SHALL be a bounded structured snapshot derived from trusted runtime state. It SHALL NOT include full raw subagent transcripts by default.

#### Scenario: Default snapshot excludes transcripts

- **GIVEN** audit is enabled with `includeTranscriptExcerpts` not set (default false)
- **WHEN** `buildControllerAuditSnapshot()` produces the audit snapshot
- **THEN** the snapshot includes goal summary, node statuses, subagent statuses, recent controller events, recent validation summaries, and progress signals
- **AND** the snapshot does not include raw subagent transcript content

#### Scenario: Snapshot includes recent bounded events

- **GIVEN** audit is configured with `maxRecentEvents: 200`
- **WHEN** `buildControllerAuditSnapshot()` loads recent controller events
- **THEN** at most 200 recent events are included

### Requirement: Audit output is schema-validated JSON

The controller audit model SHALL return structured JSON matching a defined schema. The runtime SHALL validate the returned JSON against the audit decision schema. Invalid output SHALL be recorded and ignored; valid findings SHALL be processed.

#### Scenario: Valid audit decision is processed

- **GIVEN** the audit model returns a JSON object matching `GoalControllerAuditDecision` schema
- **WHEN** the runtime validates the output
- **THEN** the decision is accepted
- **AND** a `controller_audit_finished` event is recorded
- **AND** safe action policy is applied

#### Scenario: Invalid audit output is ignored

- **GIVEN** the audit model returns malformed JSON or JSON missing required fields
- **WHEN** the runtime validates the output
- **THEN** the invalid output is recorded as `controller_audit_invalid_output`
- **AND** no actions are applied from the invalid output
- **AND** the goal continues running

### Requirement: Safe automatic actions are limited to pause-goal

`pause-goal` SHALL be the only audit-recommended action that may be applied automatically. It SHALL only be applied when ALL of the following hold: audit risk is `critical`, the finding confidence is `high`, `pauseOnCritical` is enabled.

#### Scenario: Critical high-confidence retry-loop triggers auto pause

- **GIVEN** audit is enabled with `pauseOnCritical: true`
- **AND** the audit decision has risk `critical`, a finding with kind `retry-loop` and confidence `high`, and recommends `pause-goal`
- **WHEN** the safe action policy evaluates the decision
- **THEN** the goal is paused
- **AND** a `goal_paused_by_controller_audit` event is recorded
- **AND** the pause reason surfaces the audit finding summary

#### Scenario: Medium-risk finding does not trigger auto pause

- **GIVEN** audit is enabled with `pauseOnCritical: true`
- **AND** the audit decision has risk `medium` and recommends `pause-goal`
- **WHEN** the safe action policy evaluates the decision
- **THEN** `pause-goal` is not applied automatically
- **AND** the action is recorded as `controller_audit_action_skipped`

#### Scenario: Low-confidence finding does not trigger auto pause

- **GIVEN** audit is enabled with `pauseOnCritical: true`
- **AND** the audit decision has risk `critical` but the finding has confidence `low`
- **WHEN** the safe action policy evaluates the decision
- **THEN** `pause-goal` is not applied automatically
- **AND** the action is recorded as `controller_audit_action_skipped`

#### Scenario: Pause-goal does not mark nodes or goal complete

- **GIVEN** the audit triggers an automatic pause
- **WHEN** the pause is applied
- **THEN** the goal status transitions to `paused`
- **AND** no node status changes to `complete`
- **AND** no branches are merged
- **AND** no DAG is modified

### Requirement: Non-pause actions require deterministic confirmation

All audit-recommended actions other than `pause-goal` SHALL NOT be applied automatically. They SHALL be recorded as skipped actions. Future changes may add deterministic confirmation gates for specific action types.

#### Scenario: Mark-node-blocked is recorded as skipped

- **GIVEN** the audit decision recommends `mark-node-blocked`
- **WHEN** the safe action policy evaluates the decision
- **THEN** the action is recorded as `controller_audit_action_skipped`
- **AND** no node status changes

### Requirement: Audit agent must not complete, merge, or modify

The controller audit system prompt SHALL explicitly forbid the model from recommending or performing: goal completion, node completion, branch merging, code modification, DAG modification, replanning, or overriding deterministic validation. The runtime MUST NOT execute any audit decision that violates these constraints.

#### Scenario: Audit decision cannot cause goal completion

- **GIVEN** the audit model returns any output
- **WHEN** the runtime processes the decision
- **THEN** the runtime does not mark the goal `complete`
- **AND** the runtime does not mark any node `complete`
- **AND** the runtime does not merge any branches

### Requirement: Audit events are recorded durably

All audit lifecycle events SHALL be recorded in the durable goal ledger. Event types SHALL include at least: `controller_audit_started`, `controller_audit_finished`, `controller_audit_invalid_output`, `controller_audit_action_applied`, `controller_audit_action_skipped`, and `goal_paused_by_controller_audit`.

#### Scenario: Audit lifecycle events survive controller restart

- **GIVEN** an audit run completes and records its events
- **WHEN** the controller restarts and reads ledger events
- **THEN** the audit events are present with timestamps, risk, finding kinds, and applied/skipped actions

### Requirement: Monitor surfaces latest audit finding

The goal monitor/status SHALL display the latest audit summary when audit is enabled and a finding is present. Low-risk/noop findings MAY be elided.

#### Scenario: Critical audit finding appears in monitor

- **GIVEN** an audit run produces a `critical` risk finding with an applied `pause-goal`
- **WHEN** the goal monitor renders the goal status
- **THEN** the monitor includes text such as `Controller audit: critical retry-loop detected on <nodeId>; goal paused`

#### Scenario: Healthy noop finding does not pollute monitor

- **GIVEN** an audit run produces a `low` risk `noop` finding
- **WHEN** the goal monitor renders the goal status
- **THEN** the monitor may show a compact status line without blocking the user

### Requirement: Audit prompt is strict and authority-constrained

The controller audit system prompt SHALL state: the audit role is diagnostic only; it does not have planning, completion, or merge authority; it must return only JSON matching the provided schema; subagent self-reports are not validation authority; if evidence is insufficient, choose low confidence or noop.

#### Scenario: Prompt explicitly limits audit authority

- **GIVEN** the controller audit system prompt is loaded
- **WHEN** inspected
- **THEN** it contains statements forbidding completion, merging, code modification, DAG modification, and replanning
