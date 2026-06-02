import { existsSync, readFileSync } from "node:fs";
import type {
  GoalSubagentRecord,
  HarnessSubagentAbortRequest,
  HarnessSubagentAdapter,
  HarnessSubagentPromptRequest,
  HarnessSubagentSessionState,
  HarnessSubagentStartRequest,
  HarnessSubagentStartResult,
  HarnessSubagentStateRequest,
} from "../../core/index.js";
import {
  launchPiRpcBackgroundGoalSession,
  type BackgroundGoalSessionHandle,
  type BackgroundGoalSessionLauncher,
  type BackgroundGoalSessionLaunchRequest,
} from "./background-session.js";

export interface PiHarnessSubagentAdapterOptions {
  launcher?: BackgroundGoalSessionLauncher;
  modelArg?: string;
  now?: () => Date;
}

export interface PiSubagentSessionInspectionOptions {
  readFile?: (path: string) => string;
  exists?: (path: string) => boolean;
  live?: boolean;
}

interface ParsedPiSessionState {
  entryCount: number;
  messageCount: number;
  lastActivityAt?: string;
  lastMessageRole?: string;
  lastAssistantText?: string;
  lastError?: string;
}

const RESULT_MARKER = /(?:^|\n)\s*SUBAGENT_RESULT\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_BLOCKED\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const STATUS_BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_STATUS\s*:\s*blocked\b/i;

export class PiHarnessSubagentAdapter implements HarnessSubagentAdapter {
  readonly adapterId = "pi";
  private readonly launcher: BackgroundGoalSessionLauncher;
  private readonly modelArg?: string;
  private readonly now: () => Date;
  private readonly handles = new Map<string, BackgroundGoalSessionHandle>();

  constructor(options: PiHarnessSubagentAdapterOptions = {}) {
    this.launcher = options.launcher ?? launchPiRpcBackgroundGoalSession;
    this.modelArg = options.modelArg;
    this.now = options.now ?? (() => new Date());
  }

  async startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult> {
    const launch = launchRequestForStart(request, this.modelArg);
    const handle = await this.launcher(launch);
    this.rememberHandle(request.subagentId, handle);
    await handle.sendPrompt(renderPiSubagentInitialPrompt(request));
    return {
      sessionId: handle.sessionId,
      sessionFile: handle.sessionFile,
      workspacePath: request.cwd,
      branch: request.branch,
      ref: request.ref,
      status: "running",
      lastActivityAt: this.now().toISOString(),
      metadata: { sessionName: launch.sessionName },
    };
  }

  async sendPrompt(request: HarnessSubagentPromptRequest): Promise<void> {
    const handle = await this.launchForExistingSubagent(request.subagent);
    await handle.sendPrompt(request.prompt);
  }

  getSessionState(request: HarnessSubagentStateRequest): HarnessSubagentSessionState {
    return readPiSubagentSessionState(request.subagent, {
      live: this.handles.has(keyForSubagent(request.subagent)) || isLiveSubagentStatus(request.subagent.status),
    });
  }

  async abortSession(request: HarnessSubagentAbortRequest): Promise<void> {
    const key = keyForSubagent(request.subagent);
    const handle = this.handles.get(key);
    if (!handle) return;
    handle.stop();
    this.handles.delete(key);
  }

  private async launchForExistingSubagent(subagent: GoalSubagentRecord): Promise<BackgroundGoalSessionHandle> {
    if (!subagent.sessionFile) throw new Error(`Pi subagent ${subagent.subagentId} has no sessionFile to resume`);
    const launch: BackgroundGoalSessionLaunchRequest = {
      cwd: subagent.workspacePath ?? process.cwd(),
      sessionFile: subagent.sessionFile,
      sessionName: sessionNameForSubagent(subagent),
      modelArg: this.modelArg,
    };
    this.stopExistingHandle(subagent);
    const handle = await this.launcher(launch);
    this.rememberHandle(subagent.subagentId, handle);
    return handle;
  }

  private rememberHandle(subagentId: string, handle: BackgroundGoalSessionHandle): void {
    this.handles.set(subagentId, handle);
  }

  private stopExistingHandle(subagent: GoalSubagentRecord): void {
    const key = keyForSubagent(subagent);
    const handle = this.handles.get(key);
    if (!handle) return;
    handle.stop();
    this.handles.delete(key);
  }
}

export function createPiHarnessSubagentAdapter(options: PiHarnessSubagentAdapterOptions = {}): PiHarnessSubagentAdapter {
  return new PiHarnessSubagentAdapter(options);
}

export function renderPiSubagentInitialPrompt(request: HarnessSubagentStartRequest): string {
  const lines = [
    request.systemPrompt,
    "You are a goal-orchestration subagent controlled by a parent controller.",
    "Work only on your assigned DAG node. Do not mark the parent goal complete and do not claim global completion.",
    "When your assigned node is done, report a concise result using this exact marker on its own line:",
    "SUBAGENT_RESULT: <summary of changes, verification, and remaining risks>",
    "If blocked, report this exact marker instead:",
    "SUBAGENT_BLOCKED: <specific blocker and what input/state change is needed>",
    "",
    `Goal: ${request.goalId}`,
    `Node: ${request.node.nodeId} (${request.node.slug})`,
    `Node objective: ${request.node.objective}`,
    request.node.scope ? `Scope: ${request.node.scope}` : undefined,
    request.cwd ? `Workspace: ${request.cwd}` : undefined,
    request.branch ? `Branch: ${request.branch}` : request.ref ? `Ref: ${request.ref}` : undefined,
    request.node.expectedOutputs.length ? `Expected outputs: ${request.node.expectedOutputs.join(", ")}` : undefined,
    request.node.validators.length ? `Validators: ${request.node.validators.join(", ")}` : undefined,
    "",
    request.initialPrompt,
  ];
  return lines.filter((line): line is string => Boolean(line && line.trim())).join("\n");
}

export function readPiSubagentSessionState(
  subagent: GoalSubagentRecord,
  options: PiSubagentSessionInspectionOptions = {},
): HarnessSubagentSessionState {
  const sessionFile = subagent.sessionFile;
  const exists = options.exists ?? existsSync;
  const readFile = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  if (!sessionFile) {
    return { status: "failed", error: `Pi subagent ${subagent.subagentId} has no sessionFile` };
  }
  if (!exists(sessionFile)) {
    return { status: options.live ? "starting" : "failed", error: `Pi subagent session file not found: ${sessionFile}` };
  }

  const parsed = parsePiSessionFile(readFile(sessionFile));
  const blocked = extractBlockedMarker(parsed.lastAssistantText);
  if (blocked) {
    return withInspectionMetadata({ status: "blocked", selfReportedResult: blocked, lastActivityAt: parsed.lastActivityAt }, parsed);
  }
  const result = extractResultMarker(parsed.lastAssistantText);
  if (result) {
    return withInspectionMetadata({ status: "selfReportedComplete", selfReportedResult: result, lastActivityAt: parsed.lastActivityAt }, parsed);
  }
  if (parsed.lastError) {
    return withInspectionMetadata({ status: "failed", error: parsed.lastError, lastActivityAt: parsed.lastActivityAt }, parsed);
  }
  const status = parsed.lastMessageRole === "assistant" ? "idle" : options.live ? "running" : "idle";
  return withInspectionMetadata({ status, lastActivityAt: parsed.lastActivityAt }, parsed);
}

function parsePiSessionFile(content: string): ParsedPiSessionState {
  const parsed: ParsedPiSessionState = { entryCount: 0, messageCount: 0 };
  for (const rawLine of content.split("\n")) {
    if (!rawLine.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      parsed.lastError = "Malformed Pi session entry";
      continue;
    }
    parsed.entryCount += 1;
    if (typeof entry.timestamp === "string") parsed.lastActivityAt = entry.timestamp;
    if (entry.type !== "message") continue;
    parsed.messageCount += 1;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    if (typeof message.role === "string") parsed.lastMessageRole = message.role;
    if (typeof message.errorMessage === "string") parsed.lastError = message.errorMessage;
    if (message.role === "assistant") parsed.lastAssistantText = textFromContent(message.content) || parsed.lastAssistantText;
  }
  return parsed;
}

function withInspectionMetadata(state: HarnessSubagentSessionState, parsed: ParsedPiSessionState): HarnessSubagentSessionState {
  return { ...state, metadata: { ...(state.metadata ?? {}), entryCount: parsed.entryCount, messageCount: parsed.messageCount } };
}

function launchRequestForStart(request: HarnessSubagentStartRequest, modelArg: string | undefined): BackgroundGoalSessionLaunchRequest {
  return {
    cwd: request.cwd ?? process.cwd(),
    sessionId: piSessionId(request.subagentId),
    sessionName: metadataString(request.metadata, "sessionName") ?? `subagent ${request.subagentId}: ${request.node.slug}`,
    modelArg: metadataString(request.metadata, "modelArg") ?? modelArg,
  };
}

function piSessionId(subagentId: string): string {
  const normalized = `subagent-${subagentId}`
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$/g, "");
  return normalized.slice(0, 64).replace(/[^a-zA-Z0-9]+$/g, "") || "subagent";
}

function sessionNameForSubagent(subagent: GoalSubagentRecord): string {
  return `subagent ${subagent.subagentId}: ${subagent.nodeId}`;
}

function keyForSubagent(subagent: GoalSubagentRecord): string {
  return subagent.subagentId;
}

function isLiveSubagentStatus(status: GoalSubagentRecord["status"]): boolean {
  return ["workspaceCreated", "sessionStarted", "running", "idle", "needsFollowup", "selfReportedComplete", "controllerValidating"].includes(status);
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function extractResultMarker(text: string | undefined): string | undefined {
  const match = text?.match(RESULT_MARKER);
  return cleanupMarkerText(match?.[1]);
}

function extractBlockedMarker(text: string | undefined): string | undefined {
  const explicit = cleanupMarkerText(text?.match(BLOCKED_MARKER)?.[1]);
  if (explicit) return explicit;
  return STATUS_BLOCKED_MARKER.test(text ?? "") ? "Subagent reported blocked" : undefined;
}

function cleanupMarkerText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (!part || typeof part !== "object") return "";
      const record = part as Record<string, unknown>;
      if (typeof record.text === "string") return record.text;
      if (typeof record.thinking === "string") return record.thinking;
      if (typeof record.result === "string") return record.result;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
