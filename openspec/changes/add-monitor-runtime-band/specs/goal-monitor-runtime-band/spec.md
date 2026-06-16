# goal-monitor-runtime-band Specification

## Purpose

This capability owns the derived runtime-state summary displayed in the `/goal monitor` first screen. It defines the view model shape, state classification rules, and required display behaviour for both Pi TUI and OpenCode text monitors. It does not change controller scheduling, hidden continuation semantics, or subagent lifecycle.

## Requirements

### Requirement: Runtime summary is derived from existing state

The monitor SHALL build a `GoalMonitorRuntimeSummary` synchronously from already-loaded runtime and adapter state. It SHALL NOT introduce a new persistence surface or async refresh path.

#### Scenario: Summary is derived, not persisted

- **GIVEN** a goal has active harness state, continuation reservations, controller events, and subagent records
- **WHEN** the monitor snapshot is built
- **THEN** the runtime summary is derived from that existing data
- **AND** no additional store read is required for the summary itself

### Requirement: Summary includes session state

The summary SHALL expose the original controller session state with values `active-turn`, `idle`, `missing`, `not-materialized`, or `unknown`.

#### Scenario: Active session is clearly not a failure

- **GIVEN** the original controller session has an active turn
- **WHEN** the runtime summary is rendered
- **THEN** it displays `Session=active-turn`
- **AND** it does not render as a warning or error state

### Requirement: Summary includes hidden continuation state

The summary SHALL expose hidden continuation state with values `eligible`, `suppressed`, `reserved`, `started`, `not-configured`, `not-eligible`, or `unknown`. When `suppressed`, the reason SHALL be displayed.

#### Scenario: Suppressed continuation shows reason

- **GIVEN** hidden continuation is suppressed because the original session has an active turn
- **WHEN** the runtime summary is rendered
- **THEN** it displays `Hidden=SUPPRESSED(active turn running)`
- **AND** it does not imply that suppressed continuation is a failure

### Requirement: Summary includes controller poll state

The summary SHALL expose controller poll state with values `active`, `leased`, `skipped`, `stopped`, or `unknown`.

#### Scenario: Active poll is visible

- **GIVEN** the controller polling loop is active and lease is current
- **WHEN** the runtime summary is rendered
- **THEN** it displays `Poll=ACTIVE`
- **AND** the poll state is separate from session and hidden continuation state

### Requirement: Summary includes runner counts

The summary SHALL include runner counts: running, stopped, duplicate-stopped, archived, and failed.

#### Scenario: Runner counts at overview level

- **GIVEN** there are 2 running runners, 1 archived, and 0 duplicate/stopped/failed
- **WHEN** the runtime summary is rendered
- **THEN** it displays `Runners=2 running 1 archived`
- **AND** the user does not need to enter runner scope to see this

### Requirement: Pi TUI renders runtime band

The Pi goal monitor SHALL render a compact runtime-state band above the execution plan list. The band SHALL include session, hidden continuation, poll, and runner states.

#### Scenario: Runtime band on first screen

- **GIVEN** a goal monitor is opened in Pi TUI
- **WHEN** the monitor renders
- **THEN** a runtime band with Session / Hidden / Poll / Runners states is visible before the execution plan

#### Scenario: Narrow terminal does not truncate runtime state

- **GIVEN** the Pi TUI monitor renders in an 80-column terminal
- **WHEN** the runtime band is rendered
- **THEN** key runtime-state information (Session, Hidden, Poll, Runners) is still visible
- **AND** the band uses at most 3 compact lines

### Requirement: OpenCode monitor uses structured sections

The OpenCode goal monitor snapshot SHALL group output into labelled sections: `STATUS`, `RUNTIME`, `PROGRESS`, and `NEXT ACTION`.

#### Scenario: Sections separate runtime layers

- **GIVEN** an OpenCode goal monitor snapshot is rendered
- **WHEN** the output is inspected
- **THEN** it contains `STATUS`, `RUNTIME`, `PROGRESS`, and `NEXT ACTION` section headers
- **AND** session, hidden continuation, poll, and runner states appear under `RUNTIME`

### Requirement: Health line is derived deterministically

The monitor SHALL display a derived health line with values `OK`, `Needs attention`, `Waiting`, `Stalled`, or `Blocked`.

#### Scenario: Blocked node produces needs-attention

- **GIVEN** any DAG node is blocked or failed
- **WHEN** the health line is derived
- **THEN** it renders `Health=Needs attention`
- **AND** the next-action line references the blocked node

#### Scenario: Active session + suppressed continuation + running poll is OK

- **GIVEN** the original session is active-turn, hidden continuation is suppressed, controller poll is active, and runners are running
- **WHEN** the health line is derived
- **THEN** it renders `Health=OK`
- **AND** the next-action line is neutral (e.g., `Next: monitor progress`)

### Requirement: Terminology is consistent across adapters

Canonical state labels for session, hidden continuation, poll, and runner states SHALL be shared between Pi TUI and OpenCode monitors.

#### Scenario: Both adapters use identical labels

- **GIVEN** a hidden continuation is suppressed
- **WHEN** it is rendered in Pi TUI and in OpenCode
- **THEN** both use the same label (e.g., `SUPPRESSED`) and the same reason format

### Requirement: Existing row actions are preserved

Monitor row actions (nodeList, runnerList, pause, resume, clear, openSession, stop, kill, archive) SHALL continue to work unchanged.

#### Scenario: Row actions unchanged

- **GIVEN** the monitor has the new runtime band
- **WHEN** a user navigates into nodeList or runnerList
- **THEN** the existing controller / node / runner row operations are available and functional
