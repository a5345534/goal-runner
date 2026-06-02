import { existsSync, readFileSync } from "node:fs";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalDagNode, GoalSubagentRecord, GoalSummary } from "../../core/index.js";
import type { GoalListThemeLike } from "./goal-list-ui.js";

export type GoalMonitorAction = "close" | "pause" | "resume" | "clear" | "openSession";

export interface GoalMonitorSelection {
  kind: "action" | "close";
  action?: GoalMonitorAction;
}

export interface GoalTranscriptSnapshot {
  lines: string[];
  diagnostic?: string;
  entryCount: number;
  messageCount: number;
}

export interface GoalMonitorDagSnapshot {
  nodes: GoalDagNode[];
  subagents: GoalSubagentRecord[];
  refreshedAt?: string;
}

const DEFAULT_VISIBLE_TRANSCRIPT_LINES = 18;
const DEFAULT_VISIBLE_DAG_LINES = 18;

export class GoalMonitorController {
  private buttonIndex = 0;
  private scroll = 0;
  private followTail = true;

  constructor(
    private readonly goal: GoalSummary,
    private readonly readTranscript: () => GoalTranscriptSnapshot = () => readGoalTranscript(this.goal.sessionFile),
    private readonly readDagSnapshot: () => GoalMonitorDagSnapshot = () => ({ nodes: [], subagents: [] }),
    private readonly now: () => Date = () => new Date(),
  ) {}

  get actions(): GoalMonitorAction[] {
    const actions: GoalMonitorAction[] = [];
    if (this.goal.status === "active") actions.push("pause");
    if (["active", "paused", "blocked", "budgetLimited", "usageLimited"].includes(this.goal.status)) actions.push("resume");
    actions.push("clear");
    if (this.goal.sessionFile) actions.push("openSession");
    actions.push("close");
    return actions;
  }

  handleInput(data: string): GoalMonitorSelection | undefined {
    if (matchesKey(data, Key.escape)) return { kind: "close" };
    if (matchesKey(data, Key.left)) {
      this.buttonIndex = (this.buttonIndex + this.actions.length - 1) % this.actions.length;
      return undefined;
    }
    if (matchesKey(data, Key.right) || matchesKey(data, Key.tab)) {
      this.buttonIndex = (this.buttonIndex + 1) % this.actions.length;
      return undefined;
    }
    if (matchesKey(data, Key.up)) {
      this.followTail = false;
      this.scroll = Math.max(0, this.scroll - 1);
      return undefined;
    }
    if (matchesKey(data, Key.down)) {
      this.followTail = false;
      this.scroll += 1;
      return undefined;
    }
    if (matchesKey(data, Key.home)) {
      this.followTail = false;
      this.scroll = 0;
      return undefined;
    }
    if (matchesKey(data, Key.end)) {
      this.followTail = true;
      return undefined;
    }
    if (matchesKey(data, Key.enter)) {
      const action = this.actions[this.buttonIndex] ?? "close";
      return action === "close" ? { kind: "close" } : { kind: "action", action };
    }
    return undefined;
  }

  render(width: number, theme: GoalListThemeLike): string[] {
    const title = theme.bold ? theme.bold(`Goal ${this.goal.shortGoalId}`) : `Goal ${this.goal.shortGoalId}`;
    const actions = this.actions
      .map((action, index) => (index === this.buttonIndex ? theme.fg("accent", `[${action}]`) : theme.fg("dim", ` ${action} `)))
      .join(" ");
    const snapshot = this.readTranscript();
    const dag = this.readDagSnapshot();
    const transcriptLines = snapshot.lines;
    const dagLines = renderDagLines(dag, this.now());
    const visibleTranscriptCount = DEFAULT_VISIBLE_TRANSCRIPT_LINES;
    if (this.followTail) this.scroll = Math.max(0, transcriptLines.length - visibleTranscriptCount);
    else this.scroll = Math.min(this.scroll, Math.max(0, transcriptLines.length - 1));

    const lines = [
      truncateToWidth(`${theme.fg("accent", title)}  ${actions}`, width),
      truncateToWidth(`status=${derivedMonitorStatus(this.goal, dag)} tokens=${formatMonitorTokens(this.goal)} elapsed=${formatElapsedSeconds(this.goal.timeUsedSeconds)}`, width),
      truncateToWidth(`workspace=${shortenPath(this.goal.executionWorkspace ?? "legacy")} branch=${shortenMiddle(this.goal.branch ?? this.goal.ref ?? "-", 72)}`, width),
      truncateToWidth(`DAG nodes=${formatStatusCounts(dag.nodes.map((node) => node.status))} subagents=${formatStatusCounts(dag.subagents.map((subagent) => subagent.status))} refreshed=${compactTimestamp(dag.refreshedAt ?? new Date(0).toISOString())}`, width),
      truncateToWidth(theme.fg("dim", "live dashboard • ↑↓ transcript scroll • Home top • End live tail • ←→/Tab action • Enter action • Esc close"), width),
      truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
      truncateToWidth(theme.fg("accent", "DAG / Subagents"), width),
    ];

    if (dagLines.length === 0) lines.push(truncateToWidth(theme.fg("muted", "No DAG nodes recorded yet"), width));
    for (const line of dagLines.slice(0, DEFAULT_VISIBLE_DAG_LINES)) lines.push(truncateToWidth(line, width));
    if (dagLines.length > DEFAULT_VISIBLE_DAG_LINES) lines.push(truncateToWidth(theme.fg("dim", `… ${dagLines.length - DEFAULT_VISIBLE_DAG_LINES} more DAG lines`), width));

    lines.push(truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width));
    lines.push(truncateToWidth(theme.fg("accent", `Transcript tail (${snapshot.entryCount} entries / ${snapshot.messageCount} messages)`), width));
    if (snapshot.diagnostic) lines.push(truncateToWidth(theme.fg("warning", snapshot.diagnostic), width));
    if (transcriptLines.length === 0) {
      lines.push(truncateToWidth(theme.fg("muted", "No transcript entries available"), width));
      return lines;
    }

    const end = Math.min(transcriptLines.length, this.scroll + visibleTranscriptCount);
    for (const line of transcriptLines.slice(this.scroll, end)) {
      lines.push(truncateToWidth(line, width));
    }
    lines.push(truncateToWidth(theme.fg("dim", `${this.scroll + 1}-${end}/${transcriptLines.length}${this.followTail ? " live" : ""}`), width));
    return lines;
  }
}

function renderDagLines(snapshot: GoalMonitorDagSnapshot, now: Date): string[] {
  if (snapshot.nodes.length === 0 && snapshot.subagents.length === 0) return [];
  const subagentsByNode = new Map<string, GoalSubagentRecord[]>();
  for (const subagent of snapshot.subagents) {
    const list = subagentsByNode.get(subagent.nodeId) ?? [];
    list.push(subagent);
    subagentsByNode.set(subagent.nodeId, list);
  }

  const lines: string[] = [];
  for (const [index, node] of snapshot.nodes.entries()) {
    const nodeRuntime = formatRuntime(node.createdAt, now);
    const nodeActivity = formatAgo(node.updatedAt, now);
    lines.push(`${index + 1}. [${node.status}] ${shortenMiddle(node.slug || node.nodeId, 72)} runtime=${nodeRuntime} updated=${nodeActivity}`);
    if (node.lastValidationSummary) lines.push(`   validation: ${shortenMiddle(node.lastValidationSummary, 92)}`);
    const subagents = subagentsByNode.get(node.nodeId) ?? [];
    if (subagents.length === 0) {
      lines.push("   subagents: none");
      continue;
    }
    for (const subagent of subagents) {
      const runtime = formatRuntime(subagent.createdAt, now);
      const activity = formatAgo(subagent.lastActivityAt ?? subagent.updatedAt, now);
      lines.push(`   ↳ [${subagent.status}] ${shortenMiddle(subagent.subagentId, 62)} runtime=${runtime} last=${activity}`);
      if (subagent.branch) lines.push(`      branch: ${shortenMiddle(subagent.branch, 88)}`);
      if (subagent.workspacePath) lines.push(`      workspace: ${shortenPath(subagent.workspacePath)}`);
      const note = subagent.integrationStatus ?? subagent.selfReportedResult;
      if (note) lines.push(`      note: ${shortenMiddle(note, 92)}`);
    }
  }
  return lines;
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
