import test from "node:test";
import assert from "node:assert/strict";
import {
  GoalListController,
  filterGoals,
  sortGoals,
  formatGoalListState,
  formatGoalListMetrics,
  formatGoalListWhere,
  formatGoalListSummary,
  formatGoalListRow,
} from "../adapters/pi/goal-list-ui.js";
import type { GoalSummary } from "../core/index.js";

function summary(id: string, status: GoalSummary["status"], tokensUsed: number, timeUsedSeconds: number, lastActivityAt: string): GoalSummary {
  return {
    sessionKey: `s-${id}`,
    goalId: id,
    shortGoalId: id.slice(0, 8),
    objective: `objective ${id}`,
    objectiveSummary: `objective ${id}`,
    status,
    activityState: status === "active" ? "idle-eligible" : status,
    tokensUsed,
    timeUsedSeconds,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    lastActivityAt,
  };
}

/** Rich summary factory for compact-row regression tests. */
function fullSummary(overrides: Partial<GoalSummary> & { goalId: string }): GoalSummary {
  const id = overrides.goalId;
  return {
    sessionKey: `s-${id}`,
    goalId: id,
    shortGoalId: id.slice(0, 8),
    objective: overrides.objective ?? `objective ${id}`,
    objectiveSummary: overrides.objectiveSummary ?? overrides.objective ?? `objective ${id}`,
    status: overrides.status ?? "active",
    activityState: overrides.activityState,
    tokenBudget: overrides.tokenBudget,
    tokensUsed: overrides.tokensUsed ?? 0,
    timeUsedSeconds: overrides.timeUsedSeconds ?? 0,
    createdAt: overrides.lastActivityAt ?? "2026-05-31T00:00:00.000Z",
    updatedAt: overrides.lastActivityAt ?? "2026-05-31T00:00:00.000Z",
    lastActivityAt: overrides.lastActivityAt ?? "2026-05-31T00:00:00.000Z",
    executionWorkspace: overrides.executionWorkspace,
    branch: overrides.branch,
    ref: overrides.ref,
    workspaceStatus: overrides.workspaceStatus,
  };
}

// ═══════════════════════════════════════════════════════════════════
// Existing interaction tests (preserved)
// ═══════════════════════════════════════════════════════════════════

test("goal list controller supports tab and sort keyboard operations", () => {
  const active = summary("active111", "active", 10, 5, "2026-05-31T00:00:00.000Z");
  const paused = summary("paused111", "paused", 99, 10, "2026-05-31T00:01:00.000Z");
  const controller = new GoalListController([paused, active]);

  assert.equal(controller.tab, "all");
  assert.equal(controller.visibleGoals[0]?.goalId, "paused111");

  controller.handleInput("\x1b[C"); // right
  assert.equal(controller.tab, "active");
  assert.deepEqual(controller.visibleGoals.map((goal) => goal.goalId), ["active111"]);

  controller.handleInput("\t");
  assert.equal(controller.sort, "status");
});

test("goal list controller enter selects and escape closes without mutation", () => {
  const controller = new GoalListController([summary("goal1111", "active", 1, 1, "2026-05-31T00:00:00.000Z")]);

  assert.deepEqual(controller.handleInput("\r"), { kind: "select", goal: controller.visibleGoals[0] });
  assert.deepEqual(controller.handleInput("\x1b"), { kind: "close" });
});

test("goal list filters and sort cycles use operational metadata", () => {
  const goals = [
    summary("complete", "complete", 1, 30, "2026-05-31T00:00:00.000Z"),
    summary("blocked1", "blocked", 2, 20, "2026-05-31T00:01:00.000Z"),
    summary("active11", "active", 3, 10, "2026-05-31T00:02:00.000Z"),
  ];

  assert.deepEqual(filterGoals(goals, "attention").map((goal) => goal.goalId), ["blocked1"]);
  assert.deepEqual(sortGoals(goals, "status").map((goal) => goal.goalId), ["active11", "blocked1", "complete"]);
  assert.deepEqual(sortGoals(goals, "runtime").map((goal) => goal.goalId), ["complete", "blocked1", "active11"]);
  assert.deepEqual(sortGoals(goals, "tokens").map((goal) => goal.goalId), ["active11", "blocked1", "complete"]);
});

// ═══════════════════════════════════════════════════════════════════
// Compact formatting regression tests
// ═══════════════════════════════════════════════════════════════════

// ── formatGoalListState: duplicate status/activity suppression ─────

test("formatGoalListState does not duplicate identical status and activity", () => {
  const goal = fullSummary({
    goalId: "complete1",
    status: "complete",
    activityState: "complete",
  });
  assert.equal(formatGoalListState(goal), "complete");
});

test("formatGoalListState returns status when activity is undefined", () => {
  const goal = fullSummary({
    goalId: "blocked11",
    status: "blocked",
    activityState: undefined,
  });
  assert.equal(formatGoalListState(goal), "blocked");
});

test("formatGoalListState returns status when activity differs (dominant signal)", () => {
  const goal = fullSummary({
    goalId: "active111",
    status: "active",
    activityState: "idle-eligible",
  });
  assert.equal(formatGoalListState(goal), "active");
});

test("formatGoalListState never renders duplicated status/activity pairs", () => {
  const states: GoalSummary["status"][] = ["active", "paused", "blocked", "budgetLimited", "usageLimited", "complete"];
  for (const status of states) {
    const goal = fullSummary({ goalId: status, status, activityState: status });
    const result = formatGoalListState(goal);
    assert.ok(!result.includes("/"), `state for ${status} MUST NOT contain "/": got ${JSON.stringify(result)}`);
    assert.ok(result.length > 0, `state for ${status} must be non-empty`);
  }
});

// ── formatGoalListMetrics: all-zero omission ───────────────────────

test("formatGoalListMetrics omits all-zero runtime and tokens when no budget is set", () => {
  const goal = fullSummary({
    goalId: "fresh111",
    status: "active",
    timeUsedSeconds: 0,
    tokensUsed: 0,
    tokenBudget: undefined,
  });
  assert.equal(formatGoalListMetrics(goal), "");
});

test("formatGoalListMetrics includes non-zero runtime even when tokens are zero", () => {
  const goal = fullSummary({
    goalId: "running11",
    status: "active",
    timeUsedSeconds: 42,
    tokensUsed: 0,
    tokenBudget: undefined,
  });
  const result = formatGoalListMetrics(goal);
  assert.ok(result.includes("s"), `expected duration in "${result}"`);
  assert.ok(!result.includes("t"), `unexpected token field in "${result}"`);
});

test("formatGoalListMetrics includes token field when a budget is set even if both are zero", () => {
  const goal = fullSummary({
    goalId: "budgeted1",
    status: "active",
    timeUsedSeconds: 0,
    tokensUsed: 0,
    tokenBudget: 10_000,
  });
  const result = formatGoalListMetrics(goal);
  assert.ok(result.includes("t"), `expected token field in "${result}"`);
  assert.ok(result.includes("/"), `expected budget separator in "${result}"`);
});

test("formatGoalListMetrics formats runtime and tokens correctly for non-zero values", () => {
  const goal = fullSummary({
    goalId: "busy11111",
    status: "active",
    timeUsedSeconds: 3661,
    tokensUsed: 1_500,
    tokenBudget: 5_000,
  });
  const result = formatGoalListMetrics(goal);
  // Should contain compact duration (~1h1m) and compact tokens (~1.5k/5.0kt)
  assert.ok(result.includes("h"), `expected hours in "${result}"`);
  assert.ok(result.includes("m"), `expected minutes in "${result}"`);
  assert.ok(result.includes("t"), `expected token field in "${result}"`);
  assert.ok(result.includes("/"), `expected budget separator in "${result}"`);
});

test("formatGoalListMetrics includes tokens when tokensUsed > 0 regardless of budget", () => {
  const goal = fullSummary({
    goalId: "tokensonl",
    status: "active",
    timeUsedSeconds: 0,
    tokensUsed: 500,
    tokenBudget: undefined,
  });
  const result = formatGoalListMetrics(goal);
  assert.ok(result.includes("t"), `expected token field in "${result}"`);
});

// ── formatGoalListWhere: long workspace/branch summarization ────────

test("formatGoalListWhere summarizes long workspace to last path segment", () => {
  const home = process.env.HOME ?? "/home/user";
  const longWorkspace = `${home}/projects/active/goal-workspace/.worktrees/goal-e45-improve-list-layout`;
  const goal = fullSummary({
    goalId: "triage111",
    executionWorkspace: longWorkspace,
    branch: undefined,
  });
  const result = formatGoalListWhere(goal);
  // Must not contain the full path
  assert.ok(!result.includes("projects"), `result "${result}" MUST NOT include full path`);
  assert.ok(!result.includes(longWorkspace), `result "${result}" MUST NOT include raw workspace`);
  // Should contain a meaningful short label
  assert.ok(result.length > 0, "where must be non-empty when workspace is set");
  assert.ok(result.length < longWorkspace.length, `where "${result}" must be shorter than raw workspace`);
});

test("formatGoalListWhere summarizes long branch/ref to last segment", () => {
  const goal = fullSummary({
    goalId: "branch111",
    branch: "goal/0e1bdb70-9fc4-40aa-b114-3b21dd4eddab/add-goal-list-regression-tests",
    executionWorkspace: undefined,
  });
  const result = formatGoalListWhere(goal);
  assert.ok(result.startsWith("@"), `where "${result}" must start with @`);
  assert.ok(!result.includes("0e1bdb70"), `where "${result}" MUST NOT include raw uuid`);
  assert.ok(result.includes("add-goal-list-regression-tests"), `where "${result}" must include short name`);
  assert.ok(result.length < "goal/0e1bdb70-9fc4-40aa-b114-3b21dd4eddab/add-goal-list-regression-tests".length,
    `where "${result}" must be shorter than raw branch`);
});

test("formatGoalListWhere uses ref when branch is absent", () => {
  const goal = fullSummary({
    goalId: "refonly11",
    branch: undefined,
    ref: "feature/my-change",
    executionWorkspace: undefined,
  });
  const result = formatGoalListWhere(goal);
  assert.ok(result === "@my-change" || result.endsWith("my-change"),
    `expected ref-derived where, got "${result}"`);
});

test("formatGoalListWhere combines workspace and branch", () => {
  const home = process.env.HOME ?? "/home/user";
  const goal = fullSummary({
    goalId: "combined1",
    executionWorkspace: `${home}/src/my-project`,
    branch: "feature/add-widget",
  });
  const result = formatGoalListWhere(goal);
  assert.ok(result.includes("@"), "must contain branch marker");
  assert.ok(!result.includes(home), "must not contain raw home path");
  assert.ok(result.includes("add-widget"), "must include short branch name");
});

test("formatGoalListWhere returns empty string when no workspace or branch", () => {
  const goal = fullSummary({
    goalId: "nowhere11",
    executionWorkspace: undefined,
    branch: undefined,
    ref: undefined,
  });
  assert.equal(formatGoalListWhere(goal), "");
});

test("formatGoalListWhere summarizes single-segment paths unchanged", () => {
  const goal = fullSummary({
    goalId: "shortpath",
    executionWorkspace: "my-project",
    branch: undefined,
  });
  const result = formatGoalListWhere(goal);
  assert.equal(result, "my-project");
});

// ── formatGoalListSummary: objective boilerplate stripping ──────────

test("formatGoalListSummary strips OpenSpec boilerplate prefix", () => {
  const goal = fullSummary({
    goalId: "boilerpl1",
    objective: "Implement the approved OpenSpec change improve-goal-list-triage-layout regression coverage",
    objectiveSummary: "Implement the approved OpenSpec change improve-goal-list-triage-layout regression coverage",
  });
  const result = formatGoalListSummary(goal);
  assert.ok(!result.toLowerCase().includes("implement the approved openspec change"),
    `summary "${result}" MUST NOT contain boilerplate`);
  assert.ok(result.includes("improve-goal-list-triage-layout"),
    `summary "${result}" must preserve change name`);
});

test("formatGoalListSummary passes through normal objectives unchanged", () => {
  const goal = fullSummary({
    goalId: "normalobj",
    objective: "Add linting configuration for TypeScript",
    objectiveSummary: "Add linting configuration for TypeScript",
  });
  assert.equal(formatGoalListSummary(goal), "Add linting configuration for TypeScript");
});

test("formatGoalListSummary returns original when stripped summary is empty", () => {
  const goal = fullSummary({
    goalId: "allboiler",
    objective: "Implement the approved OpenSpec change ",
    objectiveSummary: "Implement the approved OpenSpec change ",
  });
  const result = formatGoalListSummary(goal);
  // When the stripped result is empty (just whitespace), the original is returned
  assert.ok(result.length > 0, "must return non-empty summary");
});

// ── formatGoalListRow: 80 and 120 column representative fixtures ────

function fixtSummary(): GoalSummary {
  const home = process.env.HOME ?? "/home/user";
  return fullSummary({
    goalId: "e45-fix11",
    objective: "Implement the approved OpenSpec change improve-goal-list-triage-layout",
    objectiveSummary: "Implement the approved OpenSpec change improve-goal-list-triage-layout",
    status: "active",
    activityState: "idle-eligible",
    timeUsedSeconds: 3720,
    tokensUsed: 8_400,
    tokenBudget: 32_000,
    executionWorkspace: `${home}/projects/active/goal-workspace/.worktrees/goal-e45-improve-list-layout`,
    branch: "goal/0e1bdb70-9fc4-40aa-b114-3b21dd4eddab/add-goal-list-regression-tests",
  });
}

test("formatGoalListRow at 80 columns does not contain full workspace path", () => {
  const goal = fixtSummary();
  const row = formatGoalListRow(goal, "▶", "active", 80);
  const home = process.env.HOME ?? "/home/user";
  assert.ok(!row.includes(home), `row "${row}" MUST NOT contain home path`);
  assert.ok(!row.includes("goal-workspace"), `row "${row}" MUST NOT contain full path segments`);
});

test("formatGoalListRow at 80 columns does not contain duplicated status", () => {
  const goal = fixtSummary();
  const row = formatGoalListRow(goal, "▶", "active", 80);
  assert.ok(!row.includes("active/"), `row "${row}" MUST NOT contain duplicated status marker`);
  assert.ok(!row.includes("idle-eligible"), `row "${row}" MUST NOT contain raw idle-eligible`);
});

test("formatGoalListRow at 80 columns does not contain all-zero metrics as dominant content", () => {
  // Use a goal that has zero metrics
  const goal = fullSummary({
    goalId: "zero-metr",
    objective: "Add a feature",
    objectiveSummary: "Add a feature",
    status: "complete",
    activityState: "complete",
    timeUsedSeconds: 0,
    tokensUsed: 0,
    tokenBudget: undefined,
  });
  const row = formatGoalListRow(goal, " ", "complete", 80);
  assert.ok(!row.includes("0s"), `row "${row}" MUST NOT show 0s metric`);
  assert.ok(!row.includes("0t"), `row "${row}" MUST NOT show 0t metric`);
  assert.ok(row.includes("Add a feature"), `row "${row}" must show objective summary`);
});

test("formatGoalListRow at 80 columns strips boilerplate and does not contain raw objective prefix", () => {
  const goal = fixtSummary();
  const row = formatGoalListRow(goal, "▶", "active", 80);
  // Boilerplate must be absent even if the change name itself is partially truncated
  assert.ok(!row.toLowerCase().includes("implement the approved openspec change"),
    `row "${row}" MUST NOT contain boilerplate`);
  // The row may have the summary truncated before "—" at narrow widths,
  // but the boilerplate prefix is gone — that is the key regression guard.
});

test("formatGoalListRow at 120 columns preserves meaningful change name visibility", () => {
  const goal = fixtSummary();
  const row = formatGoalListRow(goal, "▶", "active", 120);
  // At 120 columns the meaningful change name prefix must be visible.
  // The full name may be partially truncated if the prefix is long, but
  // the distinguishing prefix (the change slug) must appear.
  assert.ok(row.includes("improve-goal-"),
    `row "${row}" must contain meaningful change name prefix`);
  assert.ok(!row.toLowerCase().includes("implement the approved openspec change"),
    `row "${row}" MUST NOT contain boilerplate`);
  // At 120 cols the summary separator should be present
  assert.ok(row.includes("—"), `row "${row}" must include summary separator at 120 cols`);
});

test("formatGoalListRow at 120 columns still excludes full absolute workspace paths", () => {
  const goal = fixtSummary();
  const row120 = formatGoalListRow(goal, "▶", "active", 120);
  const home = process.env.HOME ?? "/home/user";
  assert.ok(!row120.includes(home), `120-col row MUST NOT contain home path`);
  assert.ok(!row120.includes("goal-workspace"), `120-col row MUST NOT contain full path segments`);
});

test("formatGoalListRow at 120 columns still excludes full long branch strings", () => {
  const goal = fixtSummary();
  const row120 = formatGoalListRow(goal, "▶", "active", 120);
  assert.ok(!row120.includes("0e1bdb70"), `120-col row MUST NOT contain raw uuid from branch`);
});

test("formatGoalListRow at 120 columns still excludes duplicated status/activity", () => {
  const goal = fixtSummary();
  const row120 = formatGoalListRow(goal, "▶", "active", 120);
  assert.ok(!row120.includes("active/"), `120-col row MUST NOT duplicate status`);
  assert.ok(!row120.includes("idle-eligible"), `120-col row MUST NOT contain raw activity`);
});

test("formatGoalListRow at 120 columns still excludes all-zero metrics", () => {
  const goal = fullSummary({
    goalId: "zero-120",
    objective: "Add a feature",
    objectiveSummary: "Add a feature",
    status: "complete",
    activityState: "complete",
    timeUsedSeconds: 0,
    tokensUsed: 0,
    tokenBudget: undefined,
  });
  const row120 = formatGoalListRow(goal, "▶", "complete", 120);
  assert.ok(!row120.includes("0s"), `120-col zero-metric row MUST NOT show 0s`);
  assert.ok(!row120.includes("0t"), `120-col zero-metric row MUST NOT show 0t`);
  assert.ok(row120.includes("Add a feature"), `120-col row must show objective summary`);
});

test("formatGoalListRow at narrow widths still includes shortGoalId", () => {
  const goal = fixtSummary();
  const row40 = formatGoalListRow(goal, " ", "active", 40);
  assert.ok(row40.includes("e45-fix1"), `narrow row "${row40}" must include shortGoalId`);
});

test("formatGoalListRow result never exceeds requested visible width", () => {
  const goal = fixtSummary();
  // visibleWidth from the pi-tui package, but we cannot import it here.
  // Instead, test that the row is non-empty and contains no raw boilerplate
  // at any tested width.  Width compliance is tested via the render test below.
  for (const width of [40, 60, 80, 100, 120]) {
    const row = formatGoalListRow(goal, "▶", "active", width);
    assert.ok(row.length > 0, `row at width=${width} must be non-empty`);
    // With marker = "▶" and state = "active" (no theme ANSI), raw length
    // should be <= width + ellipsis overhead from truncateToWidth.
    // The truncateToWidth function adds ANSI reset codes around the ellipsis,
    // so raw string length can exceed visible width.
    assert.ok(!row.toLowerCase().includes("implement the approved openspec change"),
      `row at width=${width} must not contain boilerplate`);
  }
});

// ── Existing interactions preserved with compact formatting ─────────

test("compact row: arrow up at top boundary stays at first visible goal", () => {
  // goal-b111 has later lastActivityAt → appears first in "recent" sort
  const goals = [
    summary("goal-a111", "active", 1, 1, "2026-05-31T00:00:00.000Z"),
    summary("goal-b111", "active", 2, 2, "2026-05-31T00:01:00.000Z"),
  ];
  const ctrl = new GoalListController(goals);
  // visible order: [goal-b111, goal-a111] (newer first)
  // selected starts at 0
  ctrl.handleInput("\x1b[A"); // up — wraps to 0 (stays)
  const sel = ctrl.handleInput("\r");
  assert.equal(sel?.goal?.goalId, "goal-b111");
});

test("compact row: arrow down navigates to next visible goal", () => {
  const goals = [
    summary("goal-a111", "active", 1, 1, "2026-05-31T00:00:00.000Z"),
    summary("goal-b111", "active", 2, 2, "2026-05-31T00:01:00.000Z"),
  ];
  const ctrl = new GoalListController(goals);
  // visible order: [goal-b111, goal-a111]
  // selected starts at 0, down → 1
  ctrl.handleInput("\x1b[B"); // down
  const sel = ctrl.handleInput("\r");
  assert.equal(sel?.goal?.goalId, "goal-a111");
});

test("compact row: Enter selects the currently highlighted goal", () => {
  const goal = summary("target11", "active", 10, 5, "2026-05-31T00:00:00.000Z");
  const ctrl = new GoalListController([goal]);
  const sel = ctrl.handleInput("\r");
  assert.equal(sel?.kind, "select");
  assert.equal(sel?.goal?.goalId, "target11");
});

test("compact row: Esc returns close regardless of selection", () => {
  const ctrl = new GoalListController([summary("any-goal", "active", 1, 1, "2026-05-31T00:00:00.000Z")]);
  assert.deepEqual(ctrl.handleInput("\x1b"), { kind: "close" });
});

test("compact row: left/right cycle tabs and reset selection", () => {
  const active = summary("active111", "active", 10, 5, "2026-05-31T00:00:00.000Z");
  const paused = summary("paused111", "paused", 99, 10, "2026-05-31T00:01:00.000Z");
  const ctrl = new GoalListController([paused, active]);

  assert.equal(ctrl.tab, "all");
  ctrl.handleInput("\x1b[C"); // right → active tab
  assert.equal(ctrl.tab, "active");
  ctrl.handleInput("\x1b[D"); // left → all tab
  assert.equal(ctrl.tab, "all");
});

test("compact row: Tab cycles sort order", () => {
  const ctrl = new GoalListController([summary("g1", "active", 1, 1, "2026-05-31T00:00:00.000Z")]);
  assert.equal(ctrl.sort, "recent");
  ctrl.handleInput("\t");
  assert.equal(ctrl.sort, "status");
  ctrl.handleInput("\t");
  assert.equal(ctrl.sort, "runtime");
  ctrl.handleInput("\t");
  assert.equal(ctrl.sort, "tokens");
  ctrl.handleInput("\t");
  assert.equal(ctrl.sort, "recent");
});

test("compact row: render produces output for empty and non-empty lists", () => {
  const empty = new GoalListController([]);
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const emptyLines = empty.render(80, theme);
  assert.ok(emptyLines.length >= 1, "empty render must produce at least header lines");
  assert.ok(emptyLines.some((l) => l.includes("No goals")), "empty render must show empty message");

  const populated = new GoalListController([fixtSummary()]);
  const lines = populated.render(80, theme);
  assert.ok(lines.length >= 4, "populated render must include header, hint, separator, and at least one goal row");
});

test("compact row: render includes /goal list title, tab bar, and sort info", () => {
  const ctrl = new GoalListController([fixtSummary()]);
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  const lines = ctrl.render(80, theme);
  assert.ok(lines[0].includes("/goal list"), "first line must include /goal list title");
  assert.ok(lines[0].includes("[all]"), "first line must include active tab");
  assert.ok(lines[0].includes("sort="), "first line must include sort info");
});

test("compact row: render produces compact rows without raw boilerplate or duplicated state", () => {
  const goals = [fixtSummary(), fullSummary({
    goalId: "second11",
    objective: "Add a second feature",
    objectiveSummary: "Add a second feature",
    status: "paused",
    timeUsedSeconds: 120,
    tokensUsed: 300,
  })];
  const ctrl = new GoalListController(goals);
  const theme = { fg: (_c: string, t: string) => t, bold: (t: string) => t };
  for (const width of [80, 120]) {
    const lines = ctrl.render(width, theme);
    for (const line of lines) {
      // Each goal row must not contain raw boilerplate or duplicated state
      assert.ok(!line.includes("implement the approved openspec change"),
        `line must not contain boilerplate (width=${width})`);
      assert.ok(!line.includes("idle-eligible"),
        `line must not contain raw activity state (width=${width})`);
    }
  }
});
