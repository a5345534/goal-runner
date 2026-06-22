import { type GoalModelRoutingConfig } from "../../core/index.js";
import type { GoalDagNode } from "../../core/index.js";
export interface OpencodeModelSelection {
    scenario?: string;
    modelClass: string;
    model?: string;
    reason: string;
    evidence?: GoalDagNode["modelResolution"];
}
/** Read the model routing config from the supplied inline JSON/file/env precedence chain. */
export declare function readOpencodeModelRoutingConfig(input: {
    inlineJson?: string;
    filePath?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
}): GoalModelRoutingConfig | undefined;
export declare function selectOpencodeSubagentModel(node: Pick<GoalDagNode, "nodeId" | "scope" | "risk" | "objective" | "validators" | "expectedOutputs" | "conflictHints" | "modelScenario" | "modelClass" | "modelArg" | "modelResolution">, modelRouting: GoalModelRoutingConfig | undefined): OpencodeModelSelection;
export declare function resolveOpencodeControllerModel(modelRouting: GoalModelRoutingConfig | undefined): OpencodeModelSelection;
/** Resolve the opencode session's current model from the opencode plugin context. Kept only for display/back-compat diagnostics. */
export declare function modelArgFromOpencodeContext(ctx: {
    model?: unknown;
    [key: string]: unknown;
}): string | undefined;
