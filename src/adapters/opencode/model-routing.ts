// Model-class routing helpers for the opencode adapter.
//
// Shared routing config contains abstract `modelClass` values only. Concrete
// opencode model args are resolved from goal-runner harness binding catalogs.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseGoalModelRoutingConfigJson,
  resolveControllerModelClass,
  resolveGoalModelForHarness,
  selectModelScenarioForNode,
  type GoalModelRoutingConfig,
} from "../../core/index.js";
import type { GoalDagNode } from "../../core/index.js";

export interface OpencodeModelSelection {
  scenario?: string;
  modelClass: string;
  model?: string;
  reason: string;
  evidence?: GoalDagNode["modelResolution"];
}

/** Read the model routing config from the supplied inline JSON/file/env precedence chain. */
export function readOpencodeModelRoutingConfig(input: {
  inlineJson?: string;
  filePath?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): GoalModelRoutingConfig | undefined {
  const env = input.env ?? process.env;
  if (input.filePath?.trim()) {
    const resolved = resolve(input.cwd ?? process.cwd(), input.filePath.trim());
    if (!existsSync(resolved)) throw new Error(`Model routing file not found: ${resolved}`);
    return parseGoalModelRoutingConfigJson(readFileSync(resolved, "utf8"), `AGENT_GOAL_MODEL_ROUTING_FILE:${resolved}`);
  }
  if (input.inlineJson?.trim()) {
    return parseGoalModelRoutingConfigJson(input.inlineJson, "AGENT_GOAL_MODEL_ROUTING_INLINE");
  }
  const envFile = env.AGENT_GOAL_MODEL_ROUTING_FILE;
  if (envFile?.trim()) {
    const resolved = resolve(input.cwd ?? process.cwd(), envFile.trim());
    if (!existsSync(resolved)) throw new Error(`Model routing file not found: ${resolved}`);
    return parseGoalModelRoutingConfigJson(readFileSync(resolved, "utf8"), `AGENT_GOAL_MODEL_ROUTING_FILE:${resolved}`);
  }
  const envJson = env.AGENT_GOAL_MODEL_ROUTING_JSON;
  if (envJson?.trim()) return parseGoalModelRoutingConfigJson(envJson, "AGENT_GOAL_MODEL_ROUTING_JSON");
  return undefined;
}

export function selectOpencodeSubagentModel(
  node: Pick<GoalDagNode, "nodeId" | "scope" | "risk" | "objective" | "validators" | "expectedOutputs" | "conflictHints" | "modelScenario" | "modelClass" | "modelArg" | "modelResolution">,
  modelRouting: GoalModelRoutingConfig | undefined,
): OpencodeModelSelection {
  if (node.modelArg && node.modelClass) {
    return {
      scenario: node.modelScenario,
      modelClass: node.modelClass,
      model: node.modelArg,
      reason: node.modelScenario ? `persisted node modelScenario:${node.modelScenario}` : "persisted node model resolution",
      evidence: node.modelResolution,
    };
  }
  const selection = selectModelScenarioForNode(node, modelRouting);
  if (!selection.modelClass) throw new Error(`Model resolution blocked for node ${node.nodeId}: modelClass was not selected`);
  const resolution = resolveGoalModelForHarness({
    harness: "opencode",
    role: "subagent",
    modelScenario: selection.scenario,
    modelClass: selection.modelClass,
  });
  return {
    scenario: selection.scenario,
    modelClass: selection.modelClass,
    model: resolution.modelArg,
    reason: selection.reason,
    evidence: resolution.evidence,
  };
}

export function resolveOpencodeControllerModel(
  modelRouting: GoalModelRoutingConfig | undefined,
): OpencodeModelSelection {
  const selection = resolveControllerModelClass(modelRouting);
  if (!selection.modelClass) throw new Error("Model resolution blocked: controller modelClass was not selected");
  const resolution = resolveGoalModelForHarness({
    harness: "opencode",
    role: "controller",
    modelScenario: selection.scenario,
    modelClass: selection.modelClass,
  });
  return {
    scenario: selection.scenario,
    modelClass: selection.modelClass,
    model: resolution.modelArg,
    reason: selection.reason,
    evidence: resolution.evidence,
  };
}

/** Resolve the opencode session's current model from the opencode plugin context. Kept only for display/back-compat diagnostics. */
export function modelArgFromOpencodeContext(ctx: { model?: unknown; [key: string]: unknown }): string | undefined {
  const m: any = ctx.model;
  if (typeof m === "string") return m;
  if (!m) return undefined;
  const provider = m.providerID ?? m.providerId;
  const modelId = m.modelID ?? m.modelId ?? m.id;
  if (typeof provider === "string" && typeof modelId === "string" && provider && modelId) return `${provider}/${modelId}`;
  return undefined;
}
