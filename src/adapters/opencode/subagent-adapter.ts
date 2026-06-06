// HarnessSubagentAdapter implementation for opencode.
//
// Mirrors the Pi adapter's `PiHarnessSubagentAdapter`: the controller
// loop calls `startSession` to spin up a detached `opencode serve`
// background process in the subagent's worktree, sends the initial
// prompt with the `SUBAGENT_RESULT` / `SUBAGENT_BLOCKED` marker
// instructions, then later calls `getSessionState` to read the
// subagent's session messages and detect the marker.
//
// `adapterId` is `"opencode"`, which makes the records inspectable
// cross-harness: the portable store carries the adapter id and a
// future Pi or Claude Code adapter can correlate subagent records
// from the same goal.

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
import type {
  OpencodeBackgroundSessionHandle,
  OpencodeBackgroundSessionLauncher,
  OpencodeBackgroundSessionLaunchRequest,
} from "./background-server.js";
import { readOpencodeSessionMessages, summariseOpencodeSession } from "./session-transcript.js";

export interface OpencodeHarnessSubagentAdapterOptions {
  launcher?: OpencodeBackgroundSessionLauncher;
  modelArg?: string;
  now?: () => Date;
}

let moduleTestLauncher: OpencodeBackgroundSessionLauncher | undefined;

export function setOpencodeBackgroundSessionLauncherForTests(launcher?: OpencodeBackgroundSessionLauncher): void {
  moduleTestLauncher = launcher;
}

async function resolveDefaultLauncher(): Promise<OpencodeBackgroundSessionLauncher> {
  if (moduleTestLauncher) return moduleTestLauncher;
  const { launchOpencodeServeBackgroundSession } = await import("./background-server.js");
  return launchOpencodeServeBackgroundSession();
}

export class OpencodeHarnessSubagentAdapter implements HarnessSubagentAdapter {
  readonly adapterId = "opencode";
  private readonly launcher: OpencodeBackgroundSessionLauncher | undefined;
  private readonly modelArg?: string;
  private readonly now: () => Date;
  private readonly handles = new Map<string, OpencodeBackgroundSessionHandle>();

  constructor(options: OpencodeHarnessSubagentAdapterOptions = {}) {
    this.launcher = options.launcher;
    this.modelArg = options.modelArg;
    this.now = options.now ?? (() => new Date());
  }

  private async pickLauncher(): Promise<OpencodeBackgroundSessionLauncher> {
    if (this.launcher) return this.launcher;
    return resolveDefaultLauncher();
  }

  async startSession(request: HarnessSubagentStartRequest): Promise<HarnessSubagentStartResult> {
    const launch: OpencodeBackgroundSessionLaunchRequest = {
      cwd: request.cwd ?? process.cwd(),
      sessionTitle: subagentTitle(request),
      modelArg: this.modelArg,
    };
    const resumeSessionID = readSessionIdFromMetadata(request.metadata);
    if (resumeSessionID) launch.sessionID = resumeSessionID;
    const handle = await (await this.pickLauncher())(launch);
    this.handles.set(request.subagentId, handle);
    await handle.sendPrompt(renderOpencodeSubagentInitialPrompt(request));
    return {
      sessionId: handle.sessionID,
      sessionFile: handle.serverUrl,
      workspacePath: request.cwd,
      branch: request.branch,
      ref: request.ref,
      status: "running",
      lastActivityAt: this.now().toISOString(),
      metadata: { sessionTitle: launch.sessionTitle, serverUrl: handle.serverUrl },
    };
  }

  async sendPrompt(request: HarnessSubagentPromptRequest): Promise<void> {
    const handle = await this.launchForExistingSubagent(request.subagent);
    await handle.sendPrompt(request.prompt);
  }

  getSessionState(request: HarnessSubagentStateRequest): HarnessSubagentSessionState {
    return readOpencodeSubagentSessionState(request.subagent, { live: this.handles.has(request.subagent.subagentId) });
  }

  async abortSession(request: HarnessSubagentAbortRequest): Promise<void> {
    const handle = this.handles.get(request.subagent.subagentId);
    if (!handle) return;
    handle.stop();
    this.handles.delete(request.subagent.subagentId);
  }

  private async launchForExistingSubagent(subagent: GoalSubagentRecord): Promise<OpencodeBackgroundSessionHandle> {
    if (!subagent.sessionId) {
      throw new Error(`opencode subagent ${subagent.subagentId} has no sessionId to resume`);
    }
    this.stopExistingHandle(subagent);
    const launch: OpencodeBackgroundSessionLaunchRequest = {
      cwd: subagent.workspacePath ?? process.cwd(),
      sessionID: subagent.sessionId,
      sessionTitle: subagentTitleForExisting(subagent),
      modelArg: this.modelArg,
    };
    const launcher = await this.pickLauncher();
    const handle = await launcher(launch);
    this.handles.set(subagent.subagentId, handle);
    return handle;
  }

  private stopExistingHandle(subagent: GoalSubagentRecord): void {
    const handle = this.handles.get(subagent.subagentId);
    if (!handle) return;
    handle.stop();
    this.handles.delete(subagent.subagentId);
  }
}

export function createOpencodeHarnessSubagentAdapter(
  options: OpencodeHarnessSubagentAdapterOptions = {},
): OpencodeHarnessSubagentAdapter {
  return new OpencodeHarnessSubagentAdapter(options);
}

export function renderOpencodeSubagentInitialPrompt(request: HarnessSubagentStartRequest): string {
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
    request.cwd && request.branch ? "If you change repository files, commit the intended changes on this branch before reporting SUBAGENT_RESULT; uncommitted work cannot be integrated by the controller." : undefined,
    request.node.expectedOutputs.length ? `Expected outputs: ${request.node.expectedOutputs.join(", ")}` : undefined,
    request.node.validators.length ? `Validators: ${request.node.validators.join(", ")}` : undefined,
    "",
    request.initialPrompt,
  ];
  return lines.filter((line): line is string => Boolean(line && line.trim())).join("\n");
}

function subagentTitle(request: HarnessSubagentStartRequest): string {
  return `subagent ${request.subagentId}: ${request.node.slug}`;
}

function readSessionIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  if (!metadata) return undefined;
  const value = metadata.sessionId ?? metadata.sessionID;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function subagentTitleForExisting(subagent: GoalSubagentRecord): string {
  return `subagent ${subagent.subagentId}: ${subagent.nodeId}`;
}

const RESULT_MARKER = /(?:^|\n)\s*SUBAGENT_RESULT\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_BLOCKED\s*:\s*([\s\S]*?)(?=\n\s*SUBAGENT_[A-Z_]+\s*:|$)/i;
const STATUS_BLOCKED_MARKER = /(?:^|\n)\s*SUBAGENT_STATUS\s*:\s*blocked\b/i;

export function readOpencodeSubagentSessionState(
  subagent: GoalSubagentRecord,
  options: { live?: boolean; messages?: Awaited<ReturnType<typeof readOpencodeSessionMessages>> } = {},
): HarnessSubagentSessionState {
  if (!subagent.sessionId) {
    return { status: "failed", error: `opencode subagent ${subagent.subagentId} has no sessionId` };
  }
  const messages = options.messages ?? [];
  const snapshot = summariseOpencodeSession(messages);

  if (snapshot.hasBlockedMarker) {
    const match = snapshot.lastAssistantText?.match(BLOCKED_MARKER);
    const explicit = match ? match[1]?.trim() : undefined;
    return { status: "blocked", selfReportedResult: explicit ?? "Subagent reported blocked", lastActivityAt: snapshot.lastActivityAt };
  }
  if (snapshot.hasResultMarker) {
    const match = snapshot.lastAssistantText?.match(RESULT_MARKER);
    const explicit = match ? match[1]?.trim() : undefined;
    return { status: "selfReportedComplete", selfReportedResult: explicit ?? "Subagent reported done", lastActivityAt: snapshot.lastActivityAt };
  }
  if (snapshot.hasError) {
    return { status: "failed", error: "opencode assistant turn ended with an error", lastActivityAt: snapshot.lastActivityAt };
  }
  if (snapshot.hasAborted) {
    return { status: "failed", error: "opencode assistant turn was aborted", lastActivityAt: snapshot.lastActivityAt };
  }
  const status: "idle" | "running" = snapshot.lastToolName !== undefined || snapshot.lastAssistantText ? "idle" : options.live ? "running" : "idle";
  return { status, lastActivityAt: snapshot.lastActivityAt };
}
