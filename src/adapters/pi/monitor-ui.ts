import { existsSync, readFileSync } from "node:fs";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalDagNode, GoalSubagentRecord, GoalSummary } from "../../core/index.js";
import type { PiBackgroundRunnerRecord } from "./runner-ops.js";
import type { GoalListThemeLike } from "./goal-list-ui.js";

export type GoalMonitorAction = "close" | "pause" | "resume" | "clear" | "openSession";
export type GoalMonitorRunnerOperation = "openSession" | "stop" | "kill" | "archive";

export type GoalMonitorSelection =
  | { kind: "action"; action: GoalMonitorAction }
  | { kind: "runnerOperation"; operation: GoalMonitorRunnerOperation; subagentId: string }
  | { kind: "close" };

export interface GoalTranscriptSnapshot {
  lines: string[];
  diagnostic?: string;
  entryCount: number;
  messageCount: number;
}

export interface GoalMonitorDagSnapshot {
  nodes: GoalDagNode[];
  subagents: GoalSubagentRecord[];
  runners?: PiBackgroundRunnerRecord[];
  refreshedAt?: string;
}

const DEFAULT_VISIBLE_LIVE_LINES = 18;
const DEFAULT_VISIBLE_LIST_LINES = 14;

type GoalMonitorPane = "live" | "list";
type GoalMonitorScope =
  | { kind: "controller" }
  | { kind: "nodes" }
  | { kind: "runners"; nodeId: string };
type GoalMonitorListItem =
  | { kind: "controller" }
  | { kind: "node"; nodeId: string }
  | { kind: "runner"; nodeId: string; subagentId: string };
type GoalMonitorInternalOperation = "nodeList" | "runnerList" | "view" | "back";
type GoalMonitorRowOperation =
  | { kind: "internal"; operation: GoalMonitorInternalOperation; label: string }
  | { kind: "action"; action: GoalMonitorAction; label: string }
  | { kind: "runner"; operation: GoalMonitorRunnerOperation; subagentId: string; label: string };

interface GoalMonitorViewModel {
  scopeLabel: string;
  liveTitle: string;
  liveLines: string[];
  liveDiagnostic?: string;
  liveFollowsTail: boolean;
  listTitle: string;
  listRows: string[];
  listItems: GoalMonitorListItem[];
}

export class GoalMonitorController {
  private activePane: GoalMonitorPane = "list";
  private scope: GoalMonitorScope = { kind: "controller" };
  private listIndex = 0;
  private listScroll = 0;
  private liveScroll = 0;
  private followLiveTail = true;
  private rowOperationIndex = 0;
  private lastLiveLineCount = 0;
  private lastListLineCount = 0;
  private lastListItems: GoalMonitorListItem[] = [];
  private lastSelectedOperations: GoalMonitorRowOperation[] = [];

  constructor(
    private readonly goal: GoalSummary,
    private readonly readTranscript: () => GoalTranscriptSnapshot = () => readGoalTranscript(this.goal.sessionFile),
    private readonly readDagSnapshot: () => GoalMonitorDagSnapshot = () => ({ nodes: [], subagents: [] }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  get actions(): GoalMonitorAction[] {
    return controllerActions(this.goal);
  }

  handleInput(data: string): GoalMonitorSelection | undefined {
    if (matchesKey(data, Key.escape)) return { kind: "close" };
    if (matchesKey(data, Key.left)) {
      this.moveRowOperation(-1);
      return undefined;
    }
    if (matchesKey(data, Key.right)) {
      this.moveRowOperation(1);
      return undefined;
    }
    if (matchesKey(data, Key.tab)) {
      this.activePane = this.activePane === "live" ? "list" : "live";
      return undefined;
    }
    if (data === "l" || data === "L" || data === "d" || data === "D") {
      this.activePane = "list";
      return undefined;
    }
    if (data === "v" || data === "V" || data === "t" || data === "T") {
      this.activePane = "live";
      return undefined;
    }
    if (data === "b" || data === "B" || matchesKey(data, Key.backspace)) {
      this.goBack();
      return undefined;
    }
    if (matchesKey(data, Key.up)) {
      this.moveActivePane(-1);
      return undefined;
    }
    if (matchesKey(data, Key.down)) {
      this.moveActivePane(1);
      return undefined;
    }
    if (matchesKey(data, Key.pageUp)) {
      this.moveActivePane(-this.activePageSize());
      return undefined;
    }
    if (matchesKey(data, Key.pageDown)) {
      this.moveActivePane(this.activePageSize());
      return undefined;
    }
    if (matchesKey(data, Key.home)) {
      this.moveActivePaneToTop();
      return undefined;
    }
    if (matchesKey(data, Key.end)) {
      this.moveActivePaneToEnd();
      return undefined;
    }
    if (matchesKey(data, Key.enter)) {
      return this.confirmSelectedOperation();
    }
    return undefined;
  }

  private activePageSize(): number {
    const visibleCount = this.activePane === "list" ? DEFAULT_VISIBLE_LIST_LINES : DEFAULT_VISIBLE_LIVE_LINES;
    return Math.max(1, visibleCount - 1);
  }

  private moveActivePane(delta: number): void {
    if (this.activePane === "list") {
      this.moveListSelection(delta);
      return;
    }
    this.followLiveTail = false;
    this.liveScroll = Math.max(0, this.liveScroll + delta);
  }

  private moveActivePaneToTop(): void {
    if (this.activePane === "list") {
      this.listIndex = 0;
      this.listScroll = 0;
      return;
    }
    this.followLiveTail = false;
    this.liveScroll = 0;
  }

  private moveActivePaneToEnd(): void {
    if (this.activePane === "list") {
      this.listIndex = Math.max(0, this.lastListLineCount - 1);
      this.listScroll = Math.max(0, this.lastListLineCount - DEFAULT_VISIBLE_LIST_LINES);
      return;
    }
    this.followLiveTail = true;
    this.liveScroll = Math.max(0, this.lastLiveLineCount - DEFAULT_VISIBLE_LIVE_LINES);
  }

  private moveListSelection(delta: number): void {
    if (this.lastListLineCount <= 0) return;
    this.listIndex = Math.min(Math.max(0, this.listIndex + delta), this.lastListLineCount - 1);
    this.rowOperationIndex = 0;
    this.keepSelectedListRowVisible();
  }

  private keepSelectedListRowVisible(): void {
    if (this.listIndex < this.listScroll) this.listScroll = this.listIndex;
    if (this.listIndex >= this.listScroll + DEFAULT_VISIBLE_LIST_LINES) this.listScroll = this.listIndex - DEFAULT_VISIBLE_LIST_LINES + 1;
  }

  private moveRowOperation(delta: number): void {
    const count = this.lastSelectedOperations.length;
    if (count <= 0) return;
    this.rowOperationIndex = (this.rowOperationIndex + delta + count) % count;
  }

  private confirmSelectedOperation(): GoalMonitorSelection | undefined {
    const operation = this.lastSelectedOperations[this.rowOperationIndex];
    if (!operation) return undefined;
    if (operation.kind === "action") {
      return operation.action === "close" ? { kind: "close" } : { kind: "action", action: operation.action };
    }
    if (operation.kind === "runner") {
      return { kind: "runnerOperation", operation: operation.operation, subagentId: operation.subagentId };
    }
    switch (operation.operation) {
      case "nodeList":
        this.enterNodeList();
        return undefined;
      case "runnerList": {
        const selected = this.lastListItems[Math.min(this.listIndex, this.lastListItems.length - 1)];
        if (selected?.kind === "node") this.enterRunnerList(selected.nodeId);
        return undefined;
      }
      case "back":
        this.goBack();
        return undefined;
      case "view":
        return undefined;
    }
  }

  private enterNodeList(): void {
    this.scope = { kind: "nodes" };
    this.resetListAndLive({ followLiveTail: false });
  }

  private enterRunnerList(nodeId: string): void {
    this.scope = { kind: "runners", nodeId };
    this.resetListAndLive({ followLiveTail: true });
  }

  private goBack(): void {
    if (this.scope.kind === "controller") return;
    this.scope = this.scope.kind === "runners" ? { kind: "nodes" } : { kind: "controller" };
    this.resetListAndLive({ followLiveTail: this.scope.kind !== "nodes" });
  }

  private resetListAndLive(options: { followLiveTail: boolean }): void {
    this.activePane = "list";
    this.listIndex = 0;
    this.listScroll = 0;
    this.liveScroll = 0;
    this.rowOperationIndex = 0;
    this.followLiveTail = options.followLiveTail;
  }

  render(width: number, theme: GoalListThemeLike): string[] {
    const title = theme.bold ? theme.bold(`Goal ${this.goal.shortGoalId}`) : `Goal ${this.goal.shortGoalId}`;
    const controllerTranscript = this.readTranscript();
    const dag = this.readDagSnapshot();
    const view = this.buildView(dag, controllerTranscript);
    const visibleLiveCount = DEFAULT_VISIBLE_LIVE_LINES;
    const visibleListCount = DEFAULT_VISIBLE_LIST_LINES;

    this.lastListItems = view.listItems;
    this.lastListLineCount = view.listRows.length;
    this.lastLiveLineCount = view.liveLines.length;
    this.listIndex = Math.min(Math.max(0, this.listIndex), Math.max(0, view.listRows.length - 1));
    this.keepSelectedListRowVisible();
    this.listScroll = clampScroll(this.listScroll, view.listRows.length, visibleListCount);
    this.lastSelectedOperations = operationsForListItem(this.lastListItems[this.listIndex], this.goal, dag);
    this.rowOperationIndex = Math.min(Math.max(0, this.rowOperationIndex), Math.max(0, this.lastSelectedOperations.length - 1));
    if (view.liveFollowsTail && this.followLiveTail) this.liveScroll = Math.max(0, view.liveLines.length - visibleLiveCount);
    else this.liveScroll = clampScroll(this.liveScroll, view.liveLines.length, visibleLiveCount);

    const lines = [
      truncateToWidth(theme.fg("accent", title), width),
      truncateToWidth(`scope=${view.scopeLabel} focus=${this.activePane} rowOp=${formatPlainOperation(this.lastSelectedOperations[this.rowOperationIndex])} status=${derivedMonitorStatus(this.goal, dag)} tokens=${formatMonitorTokens(this.goal)} elapsed=${formatElapsedSeconds(this.goal.timeUsedSeconds)} controllerModel=${formatMonitorModel(this.goal.controllerModelScenario, this.goal.controllerModelArg)}`, width),
      truncateToWidth(`workspace=${shortenPath(this.goal.executionWorkspace ?? "legacy")} branch=${shortenMiddle(this.goal.branch ?? this.goal.ref ?? "-", 72)}`, width),
      truncateToWidth(`DAG nodes=${formatStatusCounts(dag.nodes.map((node) => node.status))} subagents=${formatStatusCounts(dag.subagents.map((subagent) => subagent.status))} refreshed=${compactTimestamp(dag.refreshedAt ?? new Date(0).toISOString())}`, width),
      truncateToWidth(theme.fg("dim", `row-action monitor • ←→ select row op • Enter confirm row op • b/Backspace back • l/v focus • Tab switch • ↑↓ move/scroll • PgUp/PgDn • Esc close`), width),
      truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
      truncateToWidth(theme.fg(this.activePane === "live" ? "accent" : "muted", `${this.activePane === "live" ? "▶ " : "  "}LIVE: ${view.liveTitle}`), width),
    ];

    if (view.liveDiagnostic) lines.push(truncateToWidth(theme.fg("warning", view.liveDiagnostic), width));
    if (view.liveLines.length === 0) lines.push(truncateToWidth(theme.fg("muted", "No live entries available"), width));
    const liveStart = this.liveScroll;
    const liveEnd = Math.min(view.liveLines.length, liveStart + visibleLiveCount);
    for (const line of view.liveLines.slice(liveStart, liveEnd)) lines.push(truncateToWidth(line, width));
    if (view.liveLines.length > 0) lines.push(truncateToWidth(theme.fg("dim", formatLiveRange(liveStart, liveEnd, view.liveLines.length, this.activePane === "live", view.liveFollowsTail && this.followLiveTail)), width));

    lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    lines.push(truncateToWidth(theme.fg(this.activePane === "list" ? "accent" : "muted", `${this.activePane === "list" ? "▶ " : "  "}LIST: ${view.listTitle}`), width));
    if (view.listRows.length === 0) {
      lines.push(truncateToWidth(theme.fg("muted", "No selectable rows for this scope"), width));
      return lines;
    }
    const listStart = this.listScroll;
    const listEnd = Math.min(view.listRows.length, listStart + visibleListCount);
    for (let index = listStart; index < listEnd; index += 1) {
      const row = view.listRows[index] ?? "";
      const selected = index === this.listIndex;
      const ops = selected ? formatRowOperations(this.lastSelectedOperations, this.rowOperationIndex, theme) : "";
      lines.push(truncateToWidth(selected ? theme.fg("accent", `> ${row}${ops ? `  ops: ${ops}` : ""}`) : `  ${row}`, width));
    }
    lines.push(truncateToWidth(theme.fg("dim", formatListRange(listStart, listEnd, view.listRows.length, this.listIndex, this.activePane === "list")), width));
    return lines;
  }

  private buildView(dag: GoalMonitorDagSnapshot, controllerTranscript: GoalTranscriptSnapshot): GoalMonitorViewModel {
    const now = this.now();
    const nodesById = new Map(dag.nodes.map((node) => [node.nodeId, node]));
    const subagentsByNode = groupSubagentsByNode(dag.subagents);
    let scope = this.scope;
    if (scope.kind === "runners" && !nodesById.has(scope.nodeId)) scope = { kind: "nodes" };
    this.scope = scope;

    if (scope.kind === "controller") {
      return {
        scopeLabel: "controller",
        liveTitle: `Controller execution (${controllerTranscript.entryCount} entries / ${controllerTranscript.messageCount} messages)`,
        liveLines: controllerTranscript.lines,
        liveDiagnostic: controllerTranscript.diagnostic,
        liveFollowsTail: true,
        listTitle: "Controller",
        listRows: [renderControllerListRow(this.goal, dag)],
        listItems: [{ kind: "controller" }],
      };
    }

    if (scope.kind === "nodes") {
      return {
        scopeLabel: "nodes",
        liveTitle: "Node list mode",
        liveLines: [],
        liveFollowsTail: false,
        listTitle: `Nodes ${dag.nodes.length ? `${Math.min(this.listIndex + 1, dag.nodes.length)}/${dag.nodes.length}` : "0"}`,
        listRows: dag.nodes.map((node, index) => renderNodeListRow(node, subagentsByNode.get(node.nodeId) ?? [], index, now)),
        listItems: dag.nodes.map((node) => ({ kind: "node", nodeId: node.nodeId })),
      };
    }

    const node = nodesById.get(scope.nodeId)!;
    const nodeSubagents = subagentsByNode.get(node.nodeId) ?? [];
    const selectedIndex = Math.min(Math.max(0, this.listIndex), Math.max(0, nodeSubagents.length - 1));
    const runner = nodeSubagents[selectedIndex];
    if (!runner) {
      return {
        scopeLabel: `runners/${shortenMiddle(node.slug || node.nodeId, 40)}`,
        liveTitle: `Runner live for ${node.nodeId}`,
        liveLines: [],
        liveDiagnostic: "No runners recorded for selected node",
        liveFollowsTail: false,
        listTitle: `Runners for ${shortenMiddle(node.slug || node.nodeId, 48)} 0`,
        listRows: [],
        listItems: [],
      };
    }
    const transcript = readGoalTranscript(runner.sessionFile);
    return {
      scopeLabel: `runners/${shortenMiddle(node.slug || node.nodeId, 40)}`,
      liveTitle: `Runner ${runner.subagentId}`,
      liveLines: renderRunnerLiveLines(node, runner, transcript, now),
      liveDiagnostic: transcript.diagnostic,
      liveFollowsTail: Boolean(runner.sessionFile),
      listTitle: `Runners for ${shortenMiddle(node.slug || node.nodeId, 48)} ${nodeSubagents.length ? `${Math.min(this.listIndex + 1, nodeSubagents.length)}/${nodeSubagents.length}` : "0"}`,
      listRows: nodeSubagents.map((subagent, index) => renderRunnerListRow(subagent, index, now, dag.runners)),
      listItems: nodeSubagents.map((subagent) => ({ kind: "runner", nodeId: node.nodeId, subagentId: subagent.subagentId })),
    };
  }
}

function clampScroll(scroll: number, totalLines: number, visibleLines: number): number {
  return Math.min(Math.max(0, scroll), Math.max(0, totalLines - visibleLines));
}

function formatLiveRange(start: number, end: number, total: number, active: boolean, followTail: boolean): string {
  const details = [active ? "active" : undefined, followTail ? "live" : undefined, start > 0 ? `${start} previous live lines` : undefined, total > end ? `${total - end} more live lines` : undefined].filter(Boolean);
  return `Live lines: ${start + 1}-${end}/${total}${details.length ? ` • ${details.join(" • ")}` : ""}`;
}

function formatListRange(start: number, end: number, total: number, selected: number, active: boolean): string {
  const details = [active ? "active" : undefined, start > 0 ? `${start} previous rows` : undefined, total > end ? `${total - end} more rows` : undefined].filter(Boolean);
  return `Rows: ${start + 1}-${end}/${total} selected=${Math.min(selected + 1, total)}${details.length ? ` • ${details.join(" • ")}` : ""}`;
}

function controllerActions(goal: GoalSummary): GoalMonitorAction[] {
  const actions: GoalMonitorAction[] = [];
  if (goal.status === "active") actions.push("pause");
  if (["active", "paused", "blocked", "budgetLimited", "usageLimited"].includes(goal.status)) actions.push("resume");
  actions.push("clear");
  if (goal.sessionFile) actions.push("openSession");
  actions.push("close");
  return actions;
}

function operationsForListItem(item: GoalMonitorListItem | undefined, goal: GoalSummary, dag: GoalMonitorDagSnapshot): GoalMonitorRowOperation[] {
  if (!item) return [];
  if (item.kind === "controller") {
    return [
      { kind: "internal", operation: "nodeList", label: "nodeList" },
      ...controllerActions(goal).map((action): GoalMonitorRowOperation => ({ kind: "action", action, label: action })),
    ];
  }
  if (item.kind === "node") {
    const runnerCount = dag.subagents.filter((subagent) => subagent.nodeId === item.nodeId).length;
    return [
      { kind: "internal", operation: "runnerList", label: `runnerList(${runnerCount})` },
      { kind: "internal", operation: "back", label: "back" },
    ];
  }
  const subagent = dag.subagents.find((record) => record.subagentId === item.subagentId);
  const runnerRecords = (dag.runners ?? []).filter((runner) => runner.subagentId === item.subagentId);
  const hasLiveRunner = runnerRecords.some((runner) => runner.runnerAlive || runner.childAlive);
  const operations: GoalMonitorRowOperation[] = [{ kind: "internal", operation: "view", label: "view" }];
  if (subagent?.sessionFile) operations.push({ kind: "runner", operation: "openSession", subagentId: item.subagentId, label: "openSession" });
  if (hasLiveRunner) operations.push({ kind: "runner", operation: "stop", subagentId: item.subagentId, label: "stop" });
  if (hasLiveRunner) operations.push({ kind: "runner", operation: "kill", subagentId: item.subagentId, label: "kill" });
  if (runnerRecords.length > 0) operations.push({ kind: "runner", operation: "archive", subagentId: item.subagentId, label: "archive" });
  operations.push({ kind: "internal", operation: "back", label: "back" });
  return operations;
}

function formatPlainOperation(operation: GoalMonitorRowOperation | undefined): string {
  return operation?.label ?? "-";
}

function formatRowOperations(operations: GoalMonitorRowOperation[], selectedIndex: number, theme: GoalListThemeLike): string {
  return operations
    .map((operation, index) => index === selectedIndex ? theme.fg("accent", `[${operation.label}]`) : theme.fg("dim", ` ${operation.label} `))
    .join(" ");
}

function groupSubagentsByNode(subagents: GoalSubagentRecord[]): Map<string, GoalSubagentRecord[]> {
  const grouped = new Map<string, GoalSubagentRecord[]>();
  for (const subagent of subagents) {
    const list = grouped.get(subagent.nodeId) ?? [];
    list.push(subagent);
    grouped.set(subagent.nodeId, list);
  }
  for (const list of grouped.values()) {
    list.sort((left, right) => compareIso(left.createdAt, right.createdAt) || left.subagentId.localeCompare(right.subagentId));
  }
  return grouped;
}

function latestSubagent(subagents: GoalSubagentRecord[]): GoalSubagentRecord | undefined {
  return [...subagents].sort((left, right) => compareIso(right.updatedAt, left.updatedAt) || compareIso(right.lastActivityAt, left.lastActivityAt))[0];
}

function compareIso(left: string | undefined, right: string | undefined): number {
  return Date.parse(left ?? "") - Date.parse(right ?? "");
}

function renderControllerListRow(goal: GoalSummary, dag: GoalMonitorDagSnapshot): string {
  return `[controller] status=${goal.status}/${goal.activityState ?? "-"} nodes=${formatStatusCounts(dag.nodes.map((node) => node.status))} runners=${formatStatusCounts(dag.subagents.map((subagent) => subagent.status))}`;
}

function renderNodeListRow(node: GoalDagNode, subagents: GoalSubagentRecord[], index: number, now: Date): string {
  const latest = latestSubagent(subagents);
  const latestLabel = latest ? ` latest=${latest.status}` : " latest=-";
  const model = node.modelScenario || node.modelArg ? ` model=${formatMonitorModel(node.modelScenario, node.modelArg, node.thinkingLevel)}` : "";
  return `${index + 1}. [${node.status}] ${shortenMiddle(node.slug || node.nodeId, 58)} runners=${subagents.length}${latestLabel} updated=${formatAgo(node.updatedAt, now)}${model}`;
}

function renderRunnerListRow(subagent: GoalSubagentRecord, index: number, now: Date, runners: PiBackgroundRunnerRecord[] = []): string {
  const activity = formatAgo(subagent.lastActivityAt ?? subagent.updatedAt, now);
  const integration = subagent.integrationState ? ` integration=${subagent.integrationState}` : "";
  const matchingRunners = runners.filter((runner) => runner.subagentId === subagent.subagentId);
  const liveCount = matchingRunners.filter((runner) => runner.runnerAlive || runner.childAlive).length;
  const processSummary = matchingRunners.length > 0
    ? ` proc=${liveCount}/${matchingRunners.length}${matchingRunners[0]?.runnerPid ? ` pid=${matchingRunners[0].runnerPid}` : ""}`
    : " proc=-";
  return `${index + 1}. [${subagent.status}] ${shortenMiddle(subagent.subagentId, 62)} last=${activity}${integration}${processSummary}`;
}

function renderRunnerLiveLines(node: GoalDagNode, subagent: GoalSubagentRecord, transcript: GoalTranscriptSnapshot, now: Date): string[] {
  const integration = formatSubagentIntegration(subagent);
  const note = subagent.integrationStatus ?? subagent.selfReportedResult;
  return [
    `runner: [${subagent.status}] ${subagent.subagentId}`,
    `node: ${node.nodeId} (${node.status})`,
    `runtime=${formatRuntime(subagent.createdAt, now)} last=${formatAgo(subagent.lastActivityAt ?? subagent.updatedAt, now)}`,
    subagent.branch ? `branch: ${subagent.branch}` : undefined,
    subagent.workspacePath ? `workspace: ${shortenPath(subagent.workspacePath)}` : undefined,
    subagent.sessionFile ? `session: ${shortenPath(subagent.sessionFile)}` : undefined,
    integration ? `integration: ${integration}` : undefined,
    note ? `note: ${note}` : undefined,
    "transcript:",
    ...transcript.lines,
  ].filter((line): line is string => Boolean(line));
}

function formatSubagentIntegration(subagent: GoalSubagentRecord): string | undefined {
  if (!subagent.integrationState && !subagent.integrationCommitSha && !subagent.integrationSourceHead && !subagent.integrationError) return undefined;
  const parts = [
    subagent.integrationState ?? "unknown",
    subagent.integrationSourceHead ? `source=${shortSha(subagent.integrationSourceHead)}` : undefined,
    subagent.integrationCommitSha ? `controller=${shortSha(subagent.integrationCommitSha)}` : undefined,
    subagent.integrationError ? `error=${subagent.integrationError}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" ");
}

function shortSha(value: string): string {
  return value.slice(0, 12);
}

function derivedMonitorStatus(goal: GoalSummary, dag: GoalMonitorDagSnapshot): string {
  const nodeStatuses = dag.nodes.map((node) => node.status);
  if (goal.status === "active" && nodeStatuses.length > 0 && nodeStatuses.every((status) => ["failed", "blocked", "superseded"].includes(status))) {
    return "stalled";
  }
  return `${goal.status}/${goal.activityState ?? "-"}`;
}

function formatStatusCounts(statuses: string[]): string {
  if (statuses.length === 0) return "0";
  const counts = new Map<string, number>();
  for (const status of statuses) counts.set(status, (counts.get(status) ?? 0) + 1);
  return `${statuses.length} (${[...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([status, count]) => `${status}=${count}`).join(",")})`;
}

function formatMonitorTokens(goal: GoalSummary): string {
  return goal.tokenBudget === undefined ? formatCompactNumber(goal.tokensUsed) : `${formatCompactNumber(goal.tokensUsed)}/${formatCompactNumber(goal.tokenBudget)}`;
}

function formatMonitorModel(scenario: string | undefined, model: string | undefined, thinkingLevel?: string): string {
  const parts = [scenario, model, thinkingLevel ? `[${thinkingLevel}]` : undefined].filter((p): p is string => Boolean(p));
  return parts.join(" -> ") || "-";
}

function formatMonitorValidationContract(node: GoalDagNode): string {
  const parts = [
    node.kind ? `kind=${node.kind}` : undefined,
    node.validation?.profile ? `profile=${node.validation.profile}` : undefined,
    node.validation?.requiredEvidence?.length ? `evidence=${node.validation.requiredEvidence.join(",")}` : undefined,
    node.validation?.artifactLocks?.length ? `locks=${node.validation.artifactLocks.length}` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? shortenMiddle(parts.join(" "), 120) : "-";
}

function formatCompactNumber(value: number): string {
  if (value < 1_000) return `${value}`;
  if (value < 1_000_000) return `${Number.isInteger(value / 1_000) ? value / 1_000 : (value / 1_000).toFixed(1)}k`;
  return `${Number.isInteger(value / 1_000_000) ? value / 1_000_000 : (value / 1_000_000).toFixed(1)}m`;
}

function formatRuntime(startedAt: string | undefined, now: Date): string {
  if (!startedAt) return "-";
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started)) return "-";
  return formatElapsedSeconds(Math.max(0, Math.floor((now.getTime() - started) / 1_000)));
}

function formatAgo(timestamp: string | undefined, now: Date): string {
  if (!timestamp) return "-";
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return "-";
  return `${formatElapsedSeconds(Math.max(0, Math.floor((now.getTime() - parsed) / 1_000)))} ago`;
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
}

function shortenPath(value: string): string {
  const home = process.env.HOME;
  const normalized = home && value.startsWith(`${home}/`) ? `~/${value.slice(home.length + 1)}` : value;
  return shortenMiddle(normalized, 98);
}

function shortenMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const keep = Math.max(1, maxLength - 1);
  const head = Math.ceil(keep * 0.6);
  const tail = Math.floor(keep * 0.4);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

export function readGoalTranscriptLines(sessionFile: string | undefined): string[] {
  return readGoalTranscript(sessionFile).lines;
}

export function readGoalTranscript(sessionFile: string | undefined): GoalTranscriptSnapshot {
  if (!sessionFile) return { lines: [], diagnostic: "Goal metadata has no sessionFile; use openSession or recreate the goal with the current runtime.", entryCount: 0, messageCount: 0 };
  if (!existsSync(sessionFile)) return { lines: [], diagnostic: `Session file not found: ${sessionFile}`, entryCount: 0, messageCount: 0 };

  const lines: string[] = [];
  let entryCount = 0;
  let messageCount = 0;
  for (const rawLine of readFileSync(sessionFile, "utf8").split("\n")) {
    if (!rawLine.trim()) continue;
    try {
      const entry = JSON.parse(rawLine) as Record<string, unknown>;
      entryCount += 1;
      const rendered = renderSessionEntry(entry);
      if (rendered.length === 0) continue;
      if (entry.type === "message" || entry.type === "custom_message") messageCount += 1;
      lines.push(...rendered);
    } catch {
      lines.push("[malformed session entry]");
    }
  }
  return { lines, entryCount, messageCount };
}

function renderSessionEntry(entry: Record<string, unknown>): string[] {
  const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
  const prefix = timestamp ? `[${compactTimestamp(timestamp)}] ` : "";
  switch (entry.type) {
    case "session": {
      const cwd = typeof entry.cwd === "string" ? ` cwd=${entry.cwd}` : "";
      return [`${prefix}session start${cwd}`];
    }
    case "session_info": {
      const name = typeof entry.name === "string" ? entry.name : "(unnamed)";
      return [`${prefix}session name: ${name}`];
    }
    case "message": {
      const message = entry.message as Record<string, unknown> | undefined;
      if (!message) return [];
      const role = typeof message.role === "string" ? message.role : "message";
      const text = textFromMessage(message);
      const toolName = typeof message.toolName === "string" ? ` ${message.toolName}` : "";
      const stopReason = typeof message.stopReason === "string" ? ` stop=${message.stopReason}` : "";
      return splitDisplayText(`${prefix}${role}${toolName}${stopReason}: ${text || summarizeObject(message)}`);
    }
    case "custom_message": {
      const customType = typeof entry.customType === "string" ? entry.customType : "custom";
      const text = textFromContent(entry.content);
      return splitDisplayText(`${prefix}custom:${customType}: ${text}`);
    }
    case "compaction": {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      return splitDisplayText(`${prefix}compaction: ${summary}`);
    }
    case "branch_summary": {
      const summary = typeof entry.summary === "string" ? entry.summary : "";
      return splitDisplayText(`${prefix}branch summary: ${summary}`);
    }
    case "model_change": {
      return [`${prefix}model: ${String(entry.provider ?? "?")}/${String(entry.modelId ?? "?")}`];
    }
    case "thinking_level_change": {
      return [`${prefix}thinking: ${String(entry.thinkingLevel ?? "?")}`];
    }
    case "label": {
      return [`${prefix}label: ${String(entry.label ?? "(cleared)")}`];
    }
    default:
      return [];
  }
}

function textFromMessage(message: Record<string, unknown>): string {
  const contentText = textFromContent(message.content);
  const fields: string[] = [];
  if (contentText) fields.push(contentText);
  const error = typeof message.errorMessage === "string" ? message.errorMessage : undefined;
  if (error) fields.push(`error=${error}`);
  const result = typeof message.result === "string" ? message.result : undefined;
  if (result) fields.push(result);
  return fields.join(" ").replace(/\s+/g, " ").trim();
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.replace(/\s+/g, " ").trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.thinking === "string") return `[thinking] ${record.thinking}`;
      if (record.type === "toolCall") return `[tool call] ${String(record.name ?? "unknown")} ${summarizeObject(record.arguments)}`;
      if (record.type === "image") return "[image]";
      return summarizeObject(record);
    })
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitDisplayText(text: string): string[] {
  return text.split("\n").map((line) => line.trim()).filter(Boolean);
}

function compactTimestamp(timestamp: string): string {
  return timestamp.replace(/^\d{4}-/, "").replace(/\.\d{3}Z$/, "Z");
}

function summarizeObject(value: unknown): string {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
