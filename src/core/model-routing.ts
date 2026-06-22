import type { GoalDagNode } from "./types.js";
import {
  parseGoalModelRoutingConfig,
  parseGoalModelRoutingConfigJson,
  type GoalModelRoutingConfig,
  type GoalModelRoutingRule,
  type GoalModelRoutingRuleMatch,
  type GoalModelScenario,
} from "goal-contract";

export type { GoalModelRoutingConfig, GoalModelRoutingRule, GoalModelRoutingRuleMatch, GoalModelScenario };
export { parseGoalModelRoutingConfig, parseGoalModelRoutingConfigJson };

// ---------------------------------------------------------------------------
// Runtime behaviour (goal-runner only — not in goal-contract)
// ---------------------------------------------------------------------------

export interface GoalModelScenarioSelection {
  scenario?: string;
  modelClass?: string;
  reason: string;
}

export function resolveControllerModelClass(
  config: GoalModelRoutingConfig | undefined,
): GoalModelScenarioSelection {
  if (config?.controllerScenario && config.scenarios[config.controllerScenario]) {
    return {
      scenario: config.controllerScenario,
      modelClass: config.scenarios[config.controllerScenario].modelClass,
      reason: `controller scenario ${config.controllerScenario}`,
    };
  }
  return { scenario: undefined, modelClass: "controller", reason: "implicit controller modelClass" };
}


export function selectModelScenarioForNode(
  node: {
    nodeId: string;
    objective: string;
    scope?: string;
    risk?: GoalDagNode["risk"];
    expectedOutputs: string[];
    validators: string[];
    conflictHints?: { files?: string[]; modules?: string[]; capabilities?: string[] };
    modelScenario?: string;
  },
  config?: GoalModelRoutingConfig,
): GoalModelScenarioSelection {
  if (!config) return { scenario: undefined, modelClass: "implementation", reason: "implicit implementation modelClass" };

  if (node.modelScenario && config.scenarios[node.modelScenario]) {
    return {
      scenario: node.modelScenario,
      modelClass: config.scenarios[node.modelScenario].modelClass,
      reason: `explicit node modelScenario ${node.modelScenario}`,
    };
  }
  if (config.rules) {
    for (const rule of config.rules) {
      if (matchesRule(node, rule.when)) {
        const scenario = config.scenarios[rule.scenario];
        if (!scenario) throw new Error(`Model resolution blocked for node ${node.nodeId}: routing rule references unknown scenario ${rule.scenario}`);
        return { scenario: rule.scenario, modelClass: scenario.modelClass, reason: `routing rule ${rule.scenario}` };
      }
    }
  }
  if (config.defaultSubagentScenario && config.scenarios[config.defaultSubagentScenario]) {
    return {
      scenario: config.defaultSubagentScenario,
      modelClass: config.scenarios[config.defaultSubagentScenario].modelClass,
      reason: `default subagent scenario ${config.defaultSubagentScenario}`,
    };
  }
  return { scenario: undefined, modelClass: "implementation", reason: "implicit implementation modelClass" };
}

export function assertKnownModelScenario(
  config: GoalModelRoutingConfig | undefined,
  scenario: string,
  path: string,
): void {
  if (!config || !(scenario in (config.scenarios ?? {}))) {
    throw new Error(
      `Invalid goal DAG file: ${path} modelScenario references unknown scenario ${JSON.stringify(scenario)}`,
    );
  }
}

function matchesRule(
  node: {
    nodeId: string;
    objective: string;
    scope?: string;
    risk?: GoalDagNode["risk"];
    expectedOutputs: string[];
    validators: string[];
    conflictHints?: { files?: string[]; modules?: string[]; capabilities?: string[] };
  },
  when: GoalModelRoutingRuleMatch | undefined,
): boolean {
  if (!when) return true;
  if (when.nodeIds && !when.nodeIds.includes(node.nodeId)) return false;
  if (when.scopes && (!node.scope || !when.scopes.includes(node.scope))) return false;
  if (when.risks && (!node.risk || !when.risks.includes(node.risk))) return false;
  if (when.modules && (!node.conflictHints?.modules || !when.modules.some((m) => node.conflictHints!.modules!.includes(m)))) return false;
  if (when.capabilities && (!node.conflictHints?.capabilities || !when.capabilities.some((c) => node.conflictHints!.capabilities!.includes(c)))) return false;
  if (when.files && (!node.conflictHints?.files || !when.files.some((f) => node.conflictHints!.files!.includes(f)))) return false;
  if (when.objectiveIncludes && !when.objectiveIncludes.some((t) => node.objective.toLowerCase().includes(t.toLowerCase()))) return false;
  if (when.hasValidators !== undefined && (node.validators.length > 0) !== when.hasValidators) return false;
  if (when.hasOutputs !== undefined && (node.expectedOutputs.length > 0) !== when.hasOutputs) return false;
  return true;
}
