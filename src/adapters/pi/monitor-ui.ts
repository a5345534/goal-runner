import { existsSync, readFileSync } from "node:fs";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { GoalSummary } from "../../core/index.js";
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

const DEFAULT_VISIBLE_TRANSCRIPT_LINES = 36;

export class GoalMonitorController {
  private buttonIndex = 0;
  private scroll = 0;
  private followTail = true;

  constructor(
    private readonly goal: GoalSummary,
    private readonly readTranscript: () => GoalTranscriptSnapshot = () => readGoalTranscript(this.goal.sessionFile),
  ) {}

  get actions(): GoalMonitorAction[] {
    const actions: GoalMonitorAction[] = [];
    if (this.goal.status === "active") actions.push("pause");
    if (["paused", "blocked", "budgetLimited", "usageLimited"].includes(this.goal.status)) actions.push("resume");
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
    const transcriptLines = snapshot.lines;
    const visibleCount = DEFAULT_VISIBLE_TRANSCRIPT_LINES;
    if (this.followTail) this.scroll = Math.max(0, transcriptLines.length - visibleCount);
    else this.scroll = Math.min(this.scroll, Math.max(0, transcriptLines.length - 1));

    const lines = [
      truncateToWidth(`${theme.fg("accent", title)}  ${actions}`, width),
      truncateToWidth(`status=${this.goal.status}/${this.goal.activityState ?? "-"} workspace=${this.goal.executionWorkspace ?? "legacy"}`, width),
      truncateToWidth(`branch/ref=${this.goal.branch ?? this.goal.ref ?? "-"} verification=${this.goal.branchVerificationStatus ?? "unknown"}`, width),
      truncateToWidth(`session=${this.goal.sessionFile ?? "unavailable"} entries=${snapshot.entryCount} messages=${snapshot.messageCount}`, width),
      truncateToWidth(theme.fg("dim", "↑↓ scroll • Home top • End live tail • ←→/Tab action • Enter action • Esc close without mutation"), width),
      truncateToWidth(theme.fg("borderMuted", "─".repeat(Math.max(0, width))), width),
    ];

    if (snapshot.diagnostic) lines.push(truncateToWidth(theme.fg("warning", snapshot.diagnostic), width));
    if (transcriptLines.length === 0) {
      lines.push(truncateToWidth(theme.fg("muted", "No transcript entries available"), width));
      return lines;
    }

    const end = Math.min(transcriptLines.length, this.scroll + visibleCount);
    for (const line of transcriptLines.slice(this.scroll, end)) {
      lines.push(truncateToWidth(line, width));
    }
    lines.push(truncateToWidth(theme.fg("dim", `${this.scroll + 1}-${end}/${transcriptLines.length}${this.followTail ? " live" : ""}`), width));
    return lines;
  }
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
