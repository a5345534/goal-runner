# goal-monitor-overview-dashboard Specification

## Purpose

This capability owns the overview-first monitor layout. It defines the structured view model, health taxonomy, problem summarization, runtime label mapping, event filtering, and display behaviour for both Pi TUI and OpenCode monitors. It does not change controller scheduling, hidden continuation semantics, or subagent lifecycle.

## Requirements

### Requirement: Health taxonomy includes terminal and warning states

The monitor SHALL support health labels `OK`, `Running`, `Waiting`, `Needs attention`, `Blocked`, `Stalled`, `Complete`, and `Complete with warnings`. A completed goal SHALL NOT display `Health=Blocked`.

#### Scenario: Completed goal with residual failures is Complete with warnings

- **GIVEN** goal status is `complete`
- **AND** some subagents have status `failed` or `blocked`
- **WHEN** health is derived
- **THEN** health label is `Complete with warnings`
- **AND** problem line identifies the affected node, not full subagent IDs

#### Scenario: Completed clean goal is Complete

- **GIVEN** goal status is `complete`
- **AND** no residual failures or blocked subagents exist
- **WHEN** health is derived
- **THEN** health label is `Complete`
- **AND** problem line is `none`

### Requirement: Problem summarization is node-centric

The problem line SHALL use node slugs and short reason phrases. It SHALL NOT contain full subagent IDs longer than 48 characters in the overview.

#### Scenario: Integration problem is summarized

- **GIVEN** final-verification node has subagent integration incomplete
- **AND** the full subagent ID is `subagent-final-verification-retry-1-retry-1-retry-1`
- **WHEN** the problem line is rendered
- **THEN** it displays `final-verification · required integration incomplete`
- **AND** the full subagent ID appears only in Selected Detail

### Requirement: Runtime labels are user-facing

Runtime state SHALL use user-facing labels rather than raw enum values.

#### Scenario: Internal state mapped to user label

- **GIVEN** session state is `NOT-MATERIALIZED`
- **WHEN** runtime summary is rendered for overview
- **THEN** it displays `session not materialized`
- **AND** NOT `NOT-MATERIALIZED`

### Requirement: First screen is overview-first, not log-first

The default monitor first screen SHALL render Overview, Execution Plan / Selected Detail, and Recent Events. Full controller history SHALL be available only on demand (live/log pane or debug mode).

#### Scenario: Recent events replace full history

- **GIVEN** a monitor is opened in default compact mode
- **WHEN** the first screen renders
- **THEN** it shows 3-8 meaningful recent events
- **AND** full controller history is not displayed by default

### Requirement: Execution Plan shows node display states

The Execution Plan SHALL show each node with a display state derived from node and subagent status combination.

#### Scenario: Node with residual failed subagent shows warning

- **GIVEN** a node is `complete` but has associated subagents with `failed` status
- **WHEN** the Execution Plan is rendered
- **THEN** the node shows `warning` display state

### Requirement: Pi TUI renders overview sections

The Pi TUI monitor SHALL render structured sections: Goal header, Health/Problem, Progress, Runtime, Next Action, Execution Plan, Selected Detail, and Recent Events.

#### Scenario: Wide terminal shows full overview

- **GIVEN** a Pi TUI monitor with 120+ columns
- **WHEN** the first screen renders
- **THEN** all overview sections are visible
- **AND** the layout matches the wireframe

#### Scenario: Narrow terminal preserves key fields

- **GIVEN** a Pi TUI monitor with 80 columns
- **WHEN** the first screen renders
- **THEN** Health, Problem, Progress, Runtime, and Next Action remain visible

### Requirement: OpenCode monitor uses structured sections

The OpenCode monitor SHALL group output into STATUS, SUMMARY, EXECUTION PLAN, and RECENT EVENTS sections. It SHALL use the same health taxonomy and problem summarizer as Pi TUI.

#### Scenario: OpenCode sections match Pi terminology

- **GIVEN** a completed goal with residual failures
- **WHEN** OpenCode monitor snapshot is rendered
- **THEN** it shows `Health: Complete with warnings`
- **AND** the problem line uses node-centric phrasing

### Requirement: Action labels are user-facing

Monitor row action labels SHALL display user-facing names while preserving existing operation IDs.

#### Scenario: Row action label mapped

- **GIVEN** a monitor row action `nodeList`
- **WHEN** the action label is displayed
- **THEN** it shows `node list`
- **AND** the operation ID returned to the caller is still `nodeList`

### Requirement: Existing row actions preserved

All existing monitor row actions (nodeList, runnerList, pause, resume, clear, openSession, stop, kill, archive, close) SHALL continue to function as before.

#### Scenario: Row actions unchanged

- **GIVEN** the new overview is rendered
- **WHEN** a user navigates into any row action
- **THEN** the operation ID and behaviour are unchanged from the prior monitor version
