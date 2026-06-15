// Public entry point for the opencode adapter.
//
// Default export is the opencode plugin (the `Plugin` type from
// `@opencode-ai/plugin`). Named exports expose the harness subagent
// adapter, the launcher test seam, and the lower-level helpers so
// other consumers (tests, the CLI, third-party harnesses) can reuse
// them without going through the plugin entry.
export { opencodeGoalPlugin, createOpencodeGoalPluginContext, setOpencodeClientForTests, resetOpencodeClientForTests } from "./plugin.js";
export { OpencodeHarnessSubagentAdapter, createOpencodeHarnessSubagentAdapter, readOpencodeSubagentSessionState, renderOpencodeSubagentInitialPrompt, setOpencodeBackgroundSessionLauncherForTests, } from "./subagent-adapter.js";
export { launchOpencodeServeBackgroundSession, writeOpencodeBackgroundReadyFile, readOpencodeBackgroundReadyFile, opencodeBackgroundRunDir, opencodeBackgroundCommandPath, } from "./background-server.js";
export { parseOpencodeGoalCommand, formatOpencodeGoalToolDescription, stripSlashPrefix, OPENCODE_GOAL_TOOL, OPENCODE_GOAL_SLASH, OPENCODE_GOAL_SUBCOMMAND_SET, } from "./slash-command.js";
export { readOpencodeSessionMessages, readOpencodeSessionTranscript, summariseOpencodeSession, readOpencodeTokenUsage, buildOpencodeCompletionEvidence, } from "./session-transcript.js";
export { startOpencodeHiddenGoalTurn, OpencodeHiddenContinuationRegistry, rewriteOpencodeQueuedContinuations, extractOpencodeGoalContinuationMetadata, isOpencodeSessionIdleEvent, isOpencodeSessionErrorEvent, isOpencodeSessionCompactedEvent, extractOpencodeEventSessionID, OPENCODE_GOAL_CONTINUATION_MARKER, } from "./hidden-continuation.js";
export { isOpencodeCompletionAuditEnabled, opencodeHeuristicCompletionAudit } from "./completion-audit.js";
export { buildOpencodeBlockedAuditEvidence } from "./blocked-audit.js";
export { createNoopOpencodeClient, isAbortError, isUnavailableError } from "./opencode-client.js";
export { parseGoalWorkspaceFlags, resolveWorkspaceBinding, validateExecutionWorkspace, } from "./workspace.js";
export { readOpencodeModelRoutingConfig, resolveOpencodeControllerModel, selectOpencodeSubagentModel, modelArgFromOpencodeContext, } from "./model-routing.js";
export { renderOpencodeMonitorLines, readOpencodeGoalMonitorSnapshot } from "./monitor-ui.js";
export { finalizeOpencodeGoalFromDagTerminalState, formatOpencodeCloseoutDiagnostics } from "./closeout.js";
// Default export for `import agentGoalOpencode from 'goal-runner/opencode'`.
import { opencodeGoalPlugin } from "./plugin.js";
export default opencodeGoalPlugin;
//# sourceMappingURL=index.js.map