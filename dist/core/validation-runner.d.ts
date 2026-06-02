import type { GoalControllerValidationRequest, GoalControllerValidationResult, GoalControllerValidator } from "./controller-loop.js";
export interface ControllerValidationRunnerOptions {
    /** Execute node.validators as shell commands. Defaults false; command execution must be an explicit host policy choice. */
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
export interface ControllerValidationRunResult {
    missingOutputs: string[];
    skippedValidators: string[];
    commandResults: ControllerValidationCommandResult[];
}
export declare function createControllerValidationRunner(options?: ControllerValidationRunnerOptions): GoalControllerValidator;
export declare function runControllerValidation(request: GoalControllerValidationRequest, options?: ControllerValidationRunnerOptions): GoalControllerValidationResult;
