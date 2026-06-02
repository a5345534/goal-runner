import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
export function createControllerValidationRunner(options = {}) {
    return (request) => runControllerValidation(request, options);
}
export function runControllerValidation(request, options = {}) {
    const result = {
        missingOutputs: expectedOutputsMissing(request),
        skippedValidators: [],
        commandResults: [],
    };
    if (options.executeValidators) {
        result.commandResults = request.node.validators.map((command) => runValidatorCommand(command, request.subagent.workspacePath, options));
    }
    else {
        result.skippedValidators = [...request.node.validators];
    }
    const failedCommands = result.commandResults.filter((item) => !item.ok);
    const validationSignals = buildValidationSignals(result);
    const ok = result.missingOutputs.length === 0 && failedCommands.length === 0;
    if (ok) {
        const skippedSuffix = result.skippedValidators.length ? `; skipped ${result.skippedValidators.length} validator(s) by policy` : "";
        return {
            status: "passed",
            summary: `Controller validation passed (${validationSignals.length} signal(s)${skippedSuffix}).`,
            validationSignals,
        };
    }
    const summaryParts = [
        result.missingOutputs.length ? `missing outputs: ${result.missingOutputs.join(", ")}` : undefined,
        failedCommands.length ? `failed validators: ${failedCommands.map((item) => item.command).join(", ")}` : undefined,
    ].filter((item) => Boolean(item));
    return {
        status: "failed",
        summary: `Controller validation failed: ${summaryParts.join("; ")}`,
        validationSignals,
        followupPrompt: options.renderFollowupPrompt?.(request, result) ?? defaultFollowupPrompt(request, result),
    };
}
function expectedOutputsMissing(request) {
    const cwd = request.subagent.workspacePath;
    return request.node.expectedOutputs.filter((output) => {
        const path = isAbsolute(output) ? output : cwd ? resolve(cwd, output) : output;
        return !existsSync(path);
    });
}
function runValidatorCommand(command, cwd, options) {
    try {
        const output = execFileSync("sh", ["-lc", command], {
            cwd: cwd ?? process.cwd(),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { command, ok: true, output: truncate(output, options.maxCommandOutputChars) };
    }
    catch (error) {
        const record = error;
        const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
        return { command, ok: false, output: truncate(output, options.maxCommandOutputChars), error: record.message ?? String(error) };
    }
}
function buildValidationSignals(result) {
    const signals = [];
    for (const output of result.missingOutputs)
        signals.push(`missing output: ${output}`);
    for (const command of result.commandResults) {
        signals.push(`${command.ok ? "passed" : "failed"} validator: ${command.command}${command.output ? `\n${command.output}` : ""}`);
    }
    for (const command of result.skippedValidators)
        signals.push(`skipped validator by policy: ${command}`);
    if (signals.length === 0)
        signals.push("self-report accepted; no expected outputs or executable validators configured");
    return signals;
}
function defaultFollowupPrompt(request, result) {
    const failedCommands = result.commandResults.filter((item) => !item.ok);
    return [
        `Controller validation for DAG node ${request.node.nodeId} did not pass.`,
        result.missingOutputs.length ? `Create or fix the missing expected outputs: ${result.missingOutputs.join(", ")}.` : undefined,
        failedCommands.length ? `Fix the failing validators: ${failedCommands.map((item) => item.command).join(", ")}.` : undefined,
        "After addressing the issues, report again with SUBAGENT_RESULT: <summary>.",
    ].filter((line) => Boolean(line)).join("\n");
}
function truncate(value, maxChars = 4_000) {
    if (!value)
        return undefined;
    return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}
function toText(value) {
    if (!value)
        return "";
    return typeof value === "string" ? value : value.toString("utf8");
}
//# sourceMappingURL=validation-runner.js.map