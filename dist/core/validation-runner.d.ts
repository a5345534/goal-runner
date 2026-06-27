import type { GoalControllerValidationRequest, GoalControllerValidationResult, GoalControllerValidator } from "./controller-loop.js";
export interface ControllerValidationRunnerOptions {
    /** Execute node.validators as shell commands. Defaults true so declared validators are enforced. */
    executeValidators?: boolean;
    /** Maximum captured stdout/stderr characters per command. Defaults 4000. */
    maxCommandOutputChars?: number;
    /** Build a follow-up prompt for failed validation. */
    renderFollowupPrompt?: (request: GoalControllerValidationRequest, result: ControllerValidationRunResult) => string;
}
export interface ControllerValidationCommandResult {
    command: string;
    ok: boolean;
    output?: string;
    error?: string;
}
export interface ControllerValidationArtifactLockResult {
    path: string;
    ok: boolean;
    expectedSha256: string;
    actualSha256?: string;
    error?: string;
}
export interface ControllerValidationRunResult {
    workspacePreparationSignals: string[];
    workspacePreparationFailures: string[];
    missingOutputs: string[];
    skippedValidators: string[];
    commandResults: ControllerValidationCommandResult[];
    artifactLockResults: ControllerValidationArtifactLockResult[];
    satisfiedEvidence: string[];
    missingEvidence: string[];
    policyFailures: string[];
}
export declare function createControllerValidationRunner(options?: ControllerValidationRunnerOptions): GoalControllerValidator;
export declare function runControllerValidation(request: GoalControllerValidationRequest, options?: ControllerValidationRunnerOptions): GoalControllerValidationResult;
