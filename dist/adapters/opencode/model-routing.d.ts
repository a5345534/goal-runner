import { type GoalModelRoutingConfig } from "../../core/index.js";
import type { GoalDagNode } from "../../core/index.js";
export interface OpencodeModelSelection {
    scenario?: string;
    model?: string;
    reason: string;
}
/** Read the model routing config from the supplied inline JSON/file/env precedence chain. */
export declare function readOpencodeModelRoutingConfig(input: {
    inlineJson?: string;
    filePath?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): GoalModelRoutingConfig | undefined;
/**
 * Pick a subagent model for an opencode DAG node. The opencode adapter
 * does not have a host-level model registry, so the "current model" is
 * provided by the caller (typically the opencode session model passed in
 * through `ctx`).
 */
export declare function selectOpencodeSubagentModel(node: Pick<GoalDagNode, "nodeId" | "scope" | "risk" | "objective" | "validators" | "expectedOutputs" | "conflictHints" | "modelScenario" | "modelArg">, modelRouting: GoalModelRoutingConfig | undefined, fallbackModelArg: string | undefined): OpencodeModelSelection;
/**
 * Resolve the controller model. The controller can use a model-routing
 * scenario (when `controllerScenario` is set) or fall back to the opencode
 * session's current model.
 */
export declare function resolveOpencodeControllerModel(modelRouting: GoalModelRoutingConfig | undefined, fallbackModelArg: string | undefined): OpencodeModelSelection;
/** Resolve the opencode session's current model from the opencode plugin context. */
export declare function modelArgFromOpencodeContext(ctx: {
    model?: unknown;
    [key: string]: unknown;
}): string | undefined;
