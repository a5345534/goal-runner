import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalSummary } from "../../core/index.js";

export type GoalListTab = "all" | "active" | "attention" | "terminal";
export type GoalListSort = "recent" | "status" | "runtime" | "tokens";

export interface GoalListSelection {
  kind: "select" | "close";
  goal?: GoalSummary;
}

export interface GoalListThemeLike {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

const TABS: GoalListTab[] = ["all", "active", "attention", "terminal"];
const SORTS: GoalListSort[] = ["recent", "status", "runtime", "tokens"];

// ---------------------------------------------------------------------------
// Compact formatting helpers for /goal list primary rows
// ---------------------------------------------------------------------------

/** Collapse duplicate status/activity labels into a compact state label. */
export function formatGoalListState(goal: GoalSummary): string {
  const activity = goal.activityState;
  if (!activity || activity === goal.status) {
    return goal.status;
  }
  // Activity adds information that differs from status but we keep the
  // primary state as the dominant signal.  Idle-eligibility is noise for
  // list scanning; users who need it can open the monitor view.
  return goal.status;
}

/** Return a compact metric string, omitting all-zero runtime/token pairs. */
export function formatGoalListMetrics(goal: GoalSummary): string {
  const parts: string[] = [];
  if (goal.timeUsedSeconds > 0) {
    parts.push(formatCompactDuration(goal.timeUsedSeconds));
  }
  const hasBudget = goal.tokenBudget !== undefined;
  if (goal.tokensUsed > 0 || hasBudget) {
    parts.push(formatCompactTokenField(goal.tokensUsed, goal.tokenBudget));
  }
  return parts.join(" ");
}

/** Return a compact workspace/branch location label. */
export function formatGoalListWhere(goal: GoalSummary): string {
  const wsLabel = goal.executionWorkspace ? formatCompactWorkspace(goal.executionWorkspace) : "";
  const branchLabel = goal.branch ?? goal.ref ? formatCompactBranch(goal.branch ?? goal.ref ?? "") : "";

  if (wsLabel && branchLabel && wsLabel === branchLabel) return wsLabel;
  if (wsLabel && branchLabel) return `${wsLabel}@${branchLabel}`;
  if (wsLabel) return wsLabel;
  if (branchLabel) return `@${branchLabel}`;
  return "";
}

/** Shorten common objective boilerplate to preserve the meaningful change phrase. */
export function formatGoalListSummary(goal: GoalSummary): string {
  let summary = goal.objectiveSummary;

  // Strip the most common OpenSpec boilerplate prefix so the change name
  // (which is the useful scannable signal) occupies the remaining width.
  const boilerplatePrefixes: RegExp[] = [
    /^Implement and verify the approved OpenSpec change\s+/i,
    /^Implement the approved OpenSpec change\s+/i,
  ];
  for (const pattern of boilerplatePrefixes) {
    summary = summary.replace(pattern, "");
  }
  summary = summary.replace(/\s+in\s+goal-runner:\s+/i, " — ");

  return summary.trim() || goal.objectiveSummary;
}

/** Build a compact primary row and apply final display-width truncation. */
export function formatGoalListRow(goal: GoalSummary, marker: string, state: string, width: number): string {
  const parts = [marker, goal.shortGoalId, state];

  const metrics = formatGoalListMetrics(goal);
  if (metrics) parts.push(metrics);

  const where = formatGoalListWhere(goal);
  if (where) parts.push(where);

  const summary = formatGoalListSummary(goal);
  parts.push(`— ${summary}`);

  return truncateToWidth(parts.join(" "), width);
}

// ---------------------------------------------------------------------------
// Internal compact-value formatters
// ---------------------------------------------------------------------------

function formatCompactDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60}m`;
}

function formatCompactTokenField(used: number, budget?: number): string {
  const fmt = formatCompactTokenCount;
  if (budget !== undefined) {
    return `${fmt(used)}/${fmt(budget)}t`;
  }
  return `${fmt(used)}t`;
}

function formatCompactTokenCount(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) {
    return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
  }
  return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function formatCompactWorkspace(ws: string): string {
  // Replace the home directory with ~ for readability.
  const home = process.env.HOME;
  let normalized = ws;
  if (home && ws.startsWith(`${home}/`)) {
    normalized = `~/${ws.slice(home.length + 1)}`;
  }
  // Keep only the last path segment so full absolute paths do not
  // dominate the primary row.  Users who need the full path can open
  // the monitor view.
  const segments = normalized.split("/").filter(Boolean);
  const keep = segments.length <= 1 ? normalized : (segments[segments.length - 1] ?? normalized);
  return formatCompactGoalSlug(keep);
}

function formatCompactBranch(branch: string): string {
  // Strip noisy prefix groups (e.g. "goal/uuid/short-name" → "short-name").
  const keep = branch.split("/").pop() ?? branch;
  return formatCompactGoalSlug(keep);
}

function formatCompactGoalSlug(value: string): string {
  return value
    .replace(/^goal-[a-f0-9]{3,}-/i, "")
    .replace(/^implement-and-verify-the-approved-openspec-change-/i, "")
    .replace(/^implement-the-approved-openspec-change-/i, "")
    .replace(/^approved-openspec-change-/i, "")
    .replace(/^implement-and-verify-/i, "")
    .replace(/^implement-/i, "");
}

export class GoalListController {
  private selected = 0;
  private tabIndex = 0;
  private sortIndex = 0;

  constructor(private readonly goals: GoalSummary[]) {}

  get tab(): GoalListTab {
    return TABS[this.tabIndex] ?? "all";
  }

  get sort(): GoalListSort {
    return SORTS[this.sortIndex] ?? "recent";
  }

  get visibleGoals(): GoalSummary[] {
    return sortGoals(filterGoals(this.goals, this.tab), this.sort);
  }

  handleInput(data: string): GoalListSelection | undefined {
    if (matchesKey(data, Key.escape)) return { kind: "close" };
    if (matchesKey(data, Key.enter)) return { kind: "select", goal: this.visibleGoals[this.selected] };
    if (matchesKey(data, Key.up)) {
      this.selected = Math.max(0, this.selected - 1);
      return undefined;
    }
    if (matchesKey(data, Key.down)) {
      this.selected = Math.min(Math.max(0, this.visibleGoals.length - 1), this.selected + 1);
      return undefined;
    }
    if (matchesKey(data, Key.left)) {
      this.tabIndex = (this.tabIndex + TABS.length - 1) % TABS.length;
      this.selected = 0;
      return undefined;
    }
    if (matchesKey(data, Key.right)) {
      this.tabIndex = (this.tabIndex + 1) % TABS.length;
      this.selected = 0;
      return undefined;
    }
    if (matchesKey(data, Key.tab)) {
      this.sortIndex = (this.sortIndex + 1) % SORTS.length;
      this.selected = 0;
      return undefined;
    }
    return undefined;
  }

  render(width: number, theme: GoalListThemeLike): string[] {
    const title = theme.bold ? theme.bold("/goal list") : "/goal list";
    const tabs = TABS.map((tab) => (tab === this.tab ? theme.fg("accent", `[${tab}]`) : theme.fg("dim", ` ${tab} `))).join(" ");
    const lines = [
      truncateToWidth(`${theme.fg("accent", title)}  ${tabs}  sort=${theme.fg("accent", this.sort)}`, width),
      truncateToWidth(theme.fg("dim", "↑↓ select • ←→ tab/page • Tab sort • Enter monitor • Esc close"), width),
      truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];

    const visible = this.visibleGoals;
    if (visible.length === 0) {
      lines.push(truncateToWidth(theme.fg("muted", "No goals in this view"), width));
      return lines;
    }

    visible.forEach((goal, index) => {
      const selected = index === this.selected;
      const marker = selected ? theme.fg("accent", "▶") : " ";
      const raw = formatGoalListState(goal);
      const state = selected ? theme.fg("accent", raw) : raw;
      lines.push(formatGoalListRow(goal, marker, state, width));
    });
    return lines;
  }
}

export function filterGoals(goals: GoalSummary[], tab: GoalListTab): GoalSummary[] {
  switch (tab) {
    case "active":
      return goals.filter((goal) => goal.status === "active");
    case "attention":
      return goals.filter((goal) => ["paused", "blocked", "budgetLimited", "usageLimited"].includes(goal.status));
    case "terminal":
      return goals.filter((goal) => goal.status === "complete");
    case "all":
    default:
      return [...goals];
  }
}

export function sortGoals(goals: GoalSummary[], sort: GoalListSort): GoalSummary[] {
  const sorted = [...goals];
  switch (sort) {
    case "status":
      return sorted.sort((a, b) => statusPriority(a.status) - statusPriority(b.status) || b.lastActivityAt.localeCompare(a.lastActivityAt));
    case "runtime":
      return sorted.sort((a, b) => b.timeUsedSeconds - a.timeUsedSeconds || b.lastActivityAt.localeCompare(a.lastActivityAt));
    case "tokens":
      return sorted.sort((a, b) => b.tokensUsed - a.tokensUsed || b.lastActivityAt.localeCompare(a.lastActivityAt));
    case "recent":
    default:
      return sorted.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));
  }
}

function statusPriority(status: GoalSummary["status"]): number {
  switch (status) {
    case "active":
      return 0;
    case "paused":
    case "blocked":
    case "budgetLimited":
    case "usageLimited":
      return 1;
    case "complete":
      return 2;
    default:
      return 3;
  }
}
