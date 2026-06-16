import { createGoalDagNodes } from "./dag-scheduler.js";
import { selectModelScenarioForNode } from "./model-routing.js";
import { parseGoalDagFileContent, parseGoalDagFileDocument, } from "goal-contract";
export { parseGoalDagFileContent, parseGoalDagFileDocument };
const DEFAULT_MAX_NODES = 20;
export function planGoalDagFromFileDocument(goalId, document, options = {}) {
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    if (document.nodes.length > maxNodes)
        throw new Error(`goal DAG file contains ${document.nodes.length} nodes, exceeding maxNodes=${maxNodes}`);
    const defaultOutputs = document.defaults?.outputs ?? [];
    const defaultValidators = document.defaults?.validators ?? [];
    const defaultWorkspaceStrategy = document.defaults?.workspaceStrategy ?? options.defaultWorkspaceStrategy;
    const defaultCompletionGates = document.defaults?.completionGates ?? options.defaultCompletionGates;
    const defaultConflicts = document.defaults?.conflicts;
    const defaultModelScenario = document.defaults?.modelScenario;
    const defaultThinkingLevel = document.defaults?.thinkingLevel;
    return {
        goalId,
        nodeInputs: document.nodes.map((node) => {
            const expectedOutputs = [...(node.outputs ?? defaultOutputs)];
            const validators = [...(node.validators ?? defaultValidators)];
            const conflictHints = cloneConflictHints(node.conflicts ?? defaultConflicts);
            const selection = selectModelScenarioForNode({
                nodeId: node.id,
                objective: node.objective,
                scope: node.scope,
                risk: node.risk,
                expectedOutputs,
                validators,
                conflictHints,
                modelScenario: node.modelScenario ?? defaultModelScenario,
            }, document.modelRouting);
            const modelScenario = node.modelScenario ?? defaultModelScenario ?? selection.scenario;
            return {
                nodeId: node.id,
                slug: node.id,
                objective: node.objective,
                scope: node.scope,
                kind: node.kind,
                validation: cloneValidationContract(node.validation),
                dependencyNodeIds: [...(node.after ?? [])],
                expectedOutputs,
                validators,
                workspaceStrategy: node.workspaceStrategy ?? defaultWorkspaceStrategy,
                workspace: cloneWorkspaceBinding(node.workspace),
                risk: node.risk,
                modelScenario,
                modelArg: selection.model,
                thinkingLevel: node.thinkingLevel ?? defaultThinkingLevel,
                conflictHints,
                completionGates: [...(node.completionGates ?? defaultCompletionGates ?? ["controller-validation"])],
            };
        }),
        rationale: [`Loaded ${document.nodes.length} DAG node${document.nodes.length === 1 ? "" : "s"} from goal DAG file.`],
        warnings: [],
    };
}
export function createGoalDagNodesFromFileDocument(goalId, document, options = {}) {
    const plan = planGoalDagFromFileDocument(goalId, document, options);
    return {
        ...plan,
        nodes: createGoalDagNodes(goalId, plan.nodeInputs, options),
    };
}
export function createGoalDagNodesFromFileContent(goalId, content, options = {}) {
    return createGoalDagNodesFromFileDocument(goalId, parseGoalDagFileContent(content), options);
}
// ---------------------------------------------------------------------------
// Remaining helpers (used by planGoalDagFromFileDocument)
// ---------------------------------------------------------------------------
function cloneConflictHints(hints) {
    if (!hints)
        return undefined;
    return {
        files: hints.files ? [...hints.files] : undefined,
        modules: hints.modules ? [...hints.modules] : undefined,
        capabilities: hints.capabilities ? [...hints.capabilities] : undefined,
    };
}
function cloneWorkspaceBinding(binding) {
    return binding ? { ...binding } : undefined;
}
function cloneValidationContract(contract) {
    if (!contract)
        return undefined;
    return {
        ...contract,
        artifactLocks: contract.artifactLocks?.map((lock) => ({ ...lock })),
        requiredEvidence: contract.requiredEvidence ? [...contract.requiredEvidence] : undefined,
        auditReportPaths: contract.auditReportPaths ? [...contract.auditReportPaths] : undefined,
        allowedPaths: contract.allowedPaths ? [...contract.allowedPaths] : undefined,
        forbiddenPaths: contract.forbiddenPaths ? [...contract.forbiddenPaths] : undefined,
    };
}
//# sourceMappingURL=dag-file.js.map