import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import type { GoalControllerValidationRequest, GoalControllerValidationResult, GoalControllerValidator } from "./controller-loop.js";
import { unsupportedQualityProfilesOf, GOAL_QUALITY_PROFILES } from "./quality-profiles.js";
import { isSupportedRequiredEvidence, SUPPORTED_REQUIRED_EVIDENCE, type GoalValidationEvidenceRequirement } from "./validation-evidence.js";

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
  missingOutputs: string[];
  skippedValidators: string[];
  commandResults: ControllerValidationCommandResult[];
  artifactLockResults: ControllerValidationArtifactLockResult[];
  satisfiedEvidence: string[];
  missingEvidence: string[];
  policyFailures: string[];
}

export function createControllerValidationRunner(options: ControllerValidationRunnerOptions = {}): GoalControllerValidator {
  return (request) => runControllerValidation(request, options);
}

export function runControllerValidation(
  request: GoalControllerValidationRequest,
  options: ControllerValidationRunnerOptions = {},
): GoalControllerValidationResult {
  // Old-state guard: reject persisted unsupported requiredEvidence tokens.
  // Subagents cannot repair an invalid DAG contract, so no followupPrompt.
  const unsupportedEvidence = (request.node.validation?.requiredEvidence ?? [])
    .filter((token) => !isSupportedRequiredEvidence(token));
  if (unsupportedEvidence.length > 0) {
    return {
      status: "blocked",
      summary:
        `Invalid validation contract: unsupported requiredEvidence token(s): ${unsupportedEvidence.join(", ")}. ` +
        `Supported evidence tokens: ${SUPPORTED_REQUIRED_EVIDENCE.join(", ")}. ` +
        `Natural-language acceptance checks belong in validators, audit reports, objective/scope, path policy, or producer trace/review metadata.`,
      validationSignals: [
        `invalid contract: unsupported required evidence: ${unsupportedEvidence.join(", ")}`,
      ],
    };
  }

  const unsupportedQualityProfiles = unsupportedQualityProfilesOf(request.node);
  if (unsupportedQualityProfiles.length > 0) {
    return {
      status: "blocked",
      summary:
        `Invalid DAG node contract: unsupported qualityProfiles token(s): ${unsupportedQualityProfiles.join(", ")}. ` +
        `Supported quality profiles: ${GOAL_QUALITY_PROFILES.join(", ")}.`,
      validationSignals: [
        `invalid contract: unsupported quality profiles: ${unsupportedQualityProfiles.join(", ")}`,
      ],
    };
  }

  const result: ControllerValidationRunResult = {
    missingOutputs: expectedOutputsMissing(request),
    skippedValidators: [],
    commandResults: [],
    artifactLockResults: checkArtifactLocks(request),
    satisfiedEvidence: [],
    missingEvidence: [],
    policyFailures: [...highRiskValidationPolicyFailures(request), ...scopePolicyFailures(request)],
  };

  const executeValidators = options.executeValidators !== false;
  if (executeValidators) {
    result.commandResults = request.node.validators.map((command) => runValidatorCommand(command, request.subagent.workspacePath, options));
  } else {
    result.skippedValidators = [...request.node.validators];
  }

  const evidence = evaluateRequiredEvidence(request, result);
  result.satisfiedEvidence = evidence.satisfied;
  result.missingEvidence = evidence.missing;

  const failedCommands = result.commandResults.filter((item) => !item.ok);
  const failedLocks = result.artifactLockResults.filter((item) => !item.ok);
  const validationSignals = buildValidationSignals(request, result);
  const skippedValidatorsBlockPass = result.skippedValidators.length > 0;
  const ok =
    result.missingOutputs.length === 0 &&
    failedCommands.length === 0 &&
    failedLocks.length === 0 &&
    result.missingEvidence.length === 0 &&
    result.policyFailures.length === 0 &&
    !skippedValidatorsBlockPass;
  if (ok) {
    return {
      status: "passed",
      summary: `Controller validation passed (${validationSignals.length} signal(s)).`,
      validationSignals,
    };
  }

  const summaryParts = [
    result.missingOutputs.length ? `missing outputs: ${result.missingOutputs.join(", ")}` : undefined,
    failedCommands.length ? `failed validators: ${failedCommands.map((item) => item.command).join(", ")}` : undefined,
    failedLocks.length ? `artifact locks changed or missing: ${failedLocks.map((item) => item.path).join(", ")}` : undefined,
    result.missingEvidence.length ? `missing evidence: ${result.missingEvidence.join(", ")}` : undefined,
    result.policyFailures.length ? `policy failures: ${result.policyFailures.join(", ")}` : undefined,
    skippedValidatorsBlockPass ? `skipped validators are not accepted: ${result.skippedValidators.join(", ")}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return {
    status: "failed",
    summary: `Controller validation failed: ${summaryParts.join("; ")}`,
    validationSignals,
    followupPrompt: options.renderFollowupPrompt?.(request, result) ?? defaultFollowupPrompt(request, result),
  };
}

function expectedOutputsMissing(request: GoalControllerValidationRequest): string[] {
  const changedBasenames = new Set(changedPaths(request).map((path) => basename(path)));
  return request.node.expectedOutputs.filter((output) => !expectedOutputExists(request, output, changedBasenames));
}

function expectedOutputExists(request: GoalControllerValidationRequest, output: string, changedBasenames: Set<string>): boolean {
  const cwd = request.subagent.workspacePath;
  const path = isAbsolute(output) ? output : cwd ? resolve(cwd, output) : output;
  if (existsSync(path)) return true;
  if (!cwd || isPathLikeOutput(output)) return false;
  if (changedBasenames.has(output)) return true;
  return workspaceBasenameMatchCount(cwd, output, 2) === 1;
}

function isPathLikeOutput(output: string): boolean {
  return output.includes("/") || output.includes("\\");
}

function workspaceBasenameMatchCount(root: string, expectedBasename: string, limit: number): number {
  let count = 0;
  const visit = (dir: string) => {
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (count >= limit) return;
      if (entry.isDirectory()) {
        if (shouldSkipExpectedOutputScanDir(entry.name)) continue;
        visit(resolve(dir, entry.name));
        continue;
      }
      if (entry.isFile() && entry.name === expectedBasename) count += 1;
    }
  };
  visit(root);
  return count;
}

function shouldSkipExpectedOutputScanDir(name: string): boolean {
  return name === ".git" || name === "node_modules" || name === "target" || name === "dist" || name === "build" || name === ".gradle";
}

function runValidatorCommand(
  command: string,
  cwd: string | undefined,
  options: ControllerValidationRunnerOptions,
): ControllerValidationCommandResult {
  try {
    const output = execFileSync("sh", ["-lc", command], {
      cwd: cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { command, ok: true, output: truncate(output, options.maxCommandOutputChars) };
  } catch (error) {
    const record = error as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
    return { command, ok: false, output: truncate(output, options.maxCommandOutputChars), error: record.message ?? String(error) };
  }
}

function checkArtifactLocks(request: GoalControllerValidationRequest): ControllerValidationArtifactLockResult[] {
  const locks = request.node.validation?.artifactLocks ?? [];
  const cwd = request.subagent.workspacePath;
  return locks.map((lock) => {
    const path = isAbsolute(lock.path) ? lock.path : cwd ? resolve(cwd, lock.path) : lock.path;
    try {
      const actualSha256 = sha256File(path);
      return { path: lock.path, ok: actualSha256 === lock.sha256.toLowerCase(), expectedSha256: lock.sha256.toLowerCase(), actualSha256 };
    } catch (error) {
      return { path: lock.path, ok: false, expectedSha256: lock.sha256.toLowerCase(), error: error instanceof Error ? error.message : String(error) };
    }
  });
}

function highRiskValidationPolicyFailures(request: GoalControllerValidationRequest): string[] {
  const node = request.node;
  if (node.kind !== "implementation" || node.risk !== "high") return [];
  const contract = node.validation;
  const hasSupportedRequiredEvidence = (contract?.requiredEvidence ?? [])
    .filter((token) => isSupportedRequiredEvidence(token)).length > 0;
  const hasValidation =
    node.expectedOutputs.length > 0 ||
    node.validators.length > 0 ||
    Boolean(contract?.profile) ||
    Boolean(contract?.testSpecNodeId) ||
    Boolean(contract?.approvedByNodeId) ||
    Boolean(contract?.artifactLocks?.length) ||
    hasSupportedRequiredEvidence;
  return hasValidation ? [] : ["high-risk implementation nodes require validators, outputs, a validation profile, or an approved test contract"];
}

function scopePolicyFailures(request: GoalControllerValidationRequest): string[] {
  const contract = request.node.validation;
  const allowed = contract?.allowedPaths ?? [];
  const forbidden = contract?.forbiddenPaths ?? [];
  if (allowed.length === 0 && forbidden.length === 0) return [];

  const changed = changedPaths(request);
  const forbiddenHits: string[] = [];
  const allowedMisses: string[] = [];
  const submoduleFailures: string[] = [];

  for (const path of changed) {
    const submoduleResult = validateChangedSubmoduleGitlinkPath(request, path, allowed, forbidden);
    if (submoduleResult.kind === "validated") {
      for (const mappedPath of submoduleResult.mappedPaths) {
        if (matchesAnyPathPolicy(mappedPath, forbidden)) forbiddenHits.push(mappedPath);
        else if (allowed.length > 0 && !matchesAnyPathPolicy(mappedPath, allowed)) allowedMisses.push(mappedPath);
      }
      continue;
    }
    if (submoduleResult.kind === "failed") {
      submoduleFailures.push(...submoduleResult.failures);
      continue;
    }

    if (matchesAnyPathPolicy(path, forbidden)) forbiddenHits.push(path);
    else if (allowed.length > 0 && !matchesAnyPathPolicy(path, allowed)) allowedMisses.push(path);
  }

  return [
    allowedMisses.length > 0 ? `changed files outside allowed paths: ${dedupe(allowedMisses).join(", ")}` : undefined,
    forbiddenHits.length > 0 ? `changed files touched forbidden paths: ${dedupe(forbiddenHits).join(", ")}` : undefined,
    ...dedupe(submoduleFailures),
  ].filter((item): item is string => Boolean(item));
}

type SubmoduleGitlinkScopeResult =
  | { kind: "not-submodule" }
  | { kind: "validated"; mappedPaths: string[] }
  | { kind: "failed"; failures: string[] };

interface SubmoduleGitlinkDiffEntry {
  root: string;
  oldSha: string;
  newSha: string;
  source: string;
}

function validateChangedSubmoduleGitlinkPath(
  request: GoalControllerValidationRequest,
  path: string,
  allowed: string[],
  forbidden: string[],
): SubmoduleGitlinkScopeResult {
  const cwd = request.subagent.workspacePath;
  const root = normalizeWorkspacePath(path);
  if (!cwd || !root || !pathPolicyMentionsSubmoduleRoot(root, [...allowed, ...forbidden])) return { kind: "not-submodule" };

  const entries = submoduleGitlinkDiffEntries(request, root);
  if (entries.length === 0) return { kind: "not-submodule" };

  const mappedPaths = new Set<string>();
  const failures: string[] = [];
  for (const entry of entries) {
    if (!isFullGitSha(entry.oldSha) || !isFullGitSha(entry.newSha)) {
      failures.push(submoduleGitlinkFailure(root, `${entry.source} did not provide full old/new revisions`));
      continue;
    }
    if (isZeroGitSha(entry.oldSha) || isZeroGitSha(entry.newSha)) {
      if (entry.source === "working tree diff" && recoverMissingSubmoduleWorkingTreeDiff(cwd, root)) continue;
      failures.push(submoduleGitlinkFailure(root, `${entry.source} has an all-zero revision; initialize/fetch the submodule and commit a real gitlink before retrying`));
      continue;
    }
    const availabilityFailure = ensureSubmoduleDiffCommitsAvailable(cwd, root, entry.oldSha, entry.newSha);
    if (availabilityFailure) {
      failures.push(submoduleGitlinkFailure(root, `${entry.source} internal revisions are unavailable: ${availabilityFailure}`));
      continue;
    }
    const diff = safeExecResult("git", ["diff", "--name-status", "-z", `${entry.oldSha}..${entry.newSha}`], resolve(cwd, root));
    if (!diff.ok) {
      failures.push(submoduleGitlinkFailure(root, `${entry.source} internal diff failed${diff.error ? `: ${diff.error}` : ""}`));
      continue;
    }
    addNameStatusPaths(diff.output, (internalPath) => {
      const normalizedInternal = internalPath ? normalizeWorkspacePath(internalPath) : "";
      if (normalizedInternal) mappedPaths.add(`${root}/${normalizedInternal}`);
    });
  }

  return failures.length > 0 ? { kind: "failed", failures } : { kind: "validated", mappedPaths: [...mappedPaths] };
}

function pathPolicyMentionsSubmoduleRoot(root: string, patterns: string[]): boolean {
  return patterns.some((pattern) => {
    const prefix = staticPolicyPathPrefix(pattern);
    return prefix === root || Boolean(prefix?.startsWith(`${root}/`));
  });
}

function staticPolicyPathPrefix(pattern: string): string | undefined {
  const normalized = normalizeWorkspacePath(pattern);
  if (!normalized) return undefined;
  const globIndex = normalized.search(/[*?[\]{}]/);
  return (globIndex >= 0 ? normalized.slice(0, globIndex) : normalized).replace(/\/+$/u, "") || undefined;
}

function submoduleGitlinkDiffEntries(request: GoalControllerValidationRequest, root: string): SubmoduleGitlinkDiffEntry[] {
  const cwd = request.subagent.workspacePath;
  if (!cwd) return [];
  const entries: SubmoduleGitlinkDiffEntry[] = [];
  const addEntries = (output: string, source: string) => addRawSubmoduleGitlinkEntries(output, root, source, entries);

  const baseRef = diffBaseRefForChangedPaths(request);
  if (baseRef) addEntries(safeExec("git", ["diff", "--raw", "--abbrev=40", "-z", `${baseRef}...HEAD`, "--", root], cwd), `diff ${baseRef}...HEAD`);
  addEntries(safeExec("git", ["diff", "--cached", "--raw", "--abbrev=40", "-z", "--", root], cwd), "cached diff");
  addEntries(safeExec("git", ["diff", "--raw", "--abbrev=40", "-z", "--", root], cwd), "working tree diff");
  return dedupeSubmoduleEntries(entries);
}

function addRawSubmoduleGitlinkEntries(output: string, root: string, source: string, entries: SubmoduleGitlinkDiffEntry[]): void {
  const parts = nulSplit(output);
  for (let index = 0; index < parts.length;) {
    const metadata = parts[index++] ?? "";
    if (!metadata.startsWith(":")) continue;
    const [oldMode, newMode, oldSha, newSha, status = ""] = metadata.slice(1).split(/\s+/);
    const oldPath = parts[index++] ?? "";
    const statusCode = status[0];
    const newPath = statusCode === "R" || statusCode === "C" ? parts[index++] ?? "" : oldPath;
    if (oldMode !== "160000" && newMode !== "160000") continue;
    const normalizedOld = normalizeWorkspacePath(oldPath);
    const normalizedNew = normalizeWorkspacePath(newPath);
    if (normalizedOld !== root && normalizedNew !== root) continue;
    entries.push({ root, oldSha: oldSha ?? "", newSha: newSha ?? "", source });
  }
}

function dedupeSubmoduleEntries(entries: SubmoduleGitlinkDiffEntry[]): SubmoduleGitlinkDiffEntry[] {
  const seen = new Set<string>();
  return entries.filter((entry) => {
    const key = `${entry.root}\0${entry.oldSha}\0${entry.newSha}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function submoduleGitlinkFailure(root: string, reason: string): string {
  return `changed submodule gitlink ${root} cannot be validated against allowedPaths/forbiddenPaths because ${reason}`;
}

function isFullGitSha(value: string): boolean {
  return /^[0-9a-f]{40}$/i.test(value);
}

function isZeroGitSha(value: string): boolean {
  return /^0{40}$/.test(value);
}

function ensureSubmoduleDiffCommitsAvailable(parentCwd: string, root: string, oldSha: string, newSha: string): string | undefined {
  const submoduleCwd = resolve(parentCwd, root);
  ensureSubmoduleWorktreeInitialized(parentCwd, root);
  if (!existsSync(submoduleCwd)) return `submodule worktree ${root} is not initialized`;

  const missingBefore = [oldSha, newSha].filter((sha) => !gitCommitExists(submoduleCwd, sha));
  if (missingBefore.length > 0) {
    safeExecResult("git", ["fetch", "--no-tags", "origin"], submoduleCwd);
    for (const sha of missingBefore) safeExecResult("git", ["fetch", "--no-tags", "origin", sha], submoduleCwd);
  }

  const missingAfter = [oldSha, newSha].filter((sha) => !gitCommitExists(submoduleCwd, sha));
  return missingAfter.length > 0 ? `missing commit(s) ${dedupe(missingAfter).join(", ")}; fetch or retain the submodule refs before controller validation` : undefined;
}

function recoverMissingSubmoduleWorkingTreeDiff(parentCwd: string, root: string): boolean {
  ensureSubmoduleWorktreeInitialized(parentCwd, root);
  const entries: SubmoduleGitlinkDiffEntry[] = [];
  addRawSubmoduleGitlinkEntries(safeExec("git", ["diff", "--raw", "--abbrev=40", "-z", "--", root], parentCwd), root, "working tree diff", entries);
  return entries.every((entry) => !isZeroGitSha(entry.oldSha) && !isZeroGitSha(entry.newSha));
}

function ensureSubmoduleWorktreeInitialized(parentCwd: string, root: string): void {
  safeExecResult("git", ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", root], parentCwd);
}

function gitCommitExists(cwd: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function matchesAnyPathPolicy(path: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPathPolicy(path, pattern));
}

function matchesPathPolicy(path: string, pattern: string): boolean {
  const candidate = normalizeWorkspacePath(path);
  const normalizedPattern = normalizeWorkspacePath(pattern);
  if (!candidate || !normalizedPattern) return false;
  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3).replace(/\/$/, "");
    return candidate === prefix || candidate.startsWith(`${prefix}/`);
  }
  if (normalizedPattern.endsWith("/")) return candidate.startsWith(normalizedPattern);
  return candidate === normalizedPattern;
}

function normalizeWorkspacePath(value: string): string {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");
}

function scopePolicyConfigured(request: GoalControllerValidationRequest): boolean {
  return Boolean(request.node.validation?.allowedPaths?.length || request.node.validation?.forbiddenPaths?.length);
}

function evaluateRequiredEvidence(
  request: GoalControllerValidationRequest,
  result: ControllerValidationRunResult,
): { satisfied: string[]; missing: string[] } {
  const required = request.node.validation?.requiredEvidence ?? [];
  const satisfied: string[] = [];
  const missing: string[] = [];
  for (const item of required) {
    if (item === "post-merge-validation-ran") continue;
    if (isEvidenceSatisfied(item, request, result)) satisfied.push(item);
    else missing.push(item);
  }
  return { satisfied, missing };
}

function isEvidenceSatisfied(
  requirement: GoalValidationEvidenceRequirement,
  request: GoalControllerValidationRequest,
  result: ControllerValidationRunResult,
): boolean {
  switch (requirement) {
    case "validators-ran":
      return request.node.validators.length > 0 && result.commandResults.length === request.node.validators.length && result.skippedValidators.length === 0;
    case "locked-artifacts-unchanged":
      return result.artifactLockResults.length > 0 && result.artifactLockResults.every((item) => item.ok);
    case "implementation-diff-present":
      return changedPaths(request).length > 0;
    case "non-test-diff-present":
      return changedPaths(request).some((path) => !isTestOrValidationArtifactPath(path, request));
    case "post-merge-validation-ran":
      return false;
    case "audit-report-present":
      return auditReportPaths(request).some((path) => auditReportExistsAndAcceptsCompletion(path));
    default:
      return false;
  }
}

function changedPaths(request: GoalControllerValidationRequest): string[] {
  const cwd = request.subagent.workspacePath;
  if (!cwd) return [];
  const paths = new Set<string>();
  const add = (path: string | undefined) => {
    const normalized = path ? normalizeWorkspacePath(path) : "";
    if (normalized) paths.add(normalized);
  };

  const baseRef = diffBaseRefForChangedPaths(request);
  if (baseRef) addNameStatusPaths(safeExec("git", ["diff", "--name-status", "-z", `${baseRef}...HEAD`], cwd), add);
  addNameStatusPaths(safeExec("git", ["diff", "--cached", "--name-status", "-z"], cwd), add);
  addNameStatusPaths(safeExec("git", ["diff", "--name-status", "-z"], cwd), add);
  for (const path of nulSplit(safeExec("git", ["ls-files", "--others", "--exclude-standard", "-z"], cwd))) add(path);
  return [...paths];
}

function diffBaseRefForChangedPaths(request: GoalControllerValidationRequest): string | undefined {
  return firstNonEmptyString(
    request.node.validation?.diffBaseRef,
    request.node.workspace?.baseRef,
    metadataString(request.node.preparedResources?.metadata?.nativeGitWorkspace, "baseRef"),
    request.node.preparedResources?.ref,
    request.subagent.ref,
  );
}

function addNameStatusPaths(output: string, add: (path: string | undefined) => void): void {
  const parts = nulSplit(output);
  for (let index = 0; index < parts.length;) {
    const status = parts[index++] ?? "";
    if (!status) continue;
    const code = status[0];
    if (code === "R" || code === "C") {
      add(parts[index++]);
      add(parts[index++]);
      continue;
    }
    add(parts[index++]);
  }
}

function nulSplit(output: string): string[] {
  return output.split("\0").filter((item) => item.length > 0);
}

function firstNonEmptyString(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function metadataString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === "string" && item.trim() ? item.trim() : undefined;
}

function isTestOrValidationArtifactPath(path: string, request: GoalControllerValidationRequest): boolean {
  if ((request.node.validation?.artifactLocks ?? []).some((lock) => lock.path === path)) return true;
  return /(^|\/)(tests?|specs?|validators?|validation)(\/|$)/i.test(path) || /(^|\/)(test|spec|validator)[^/]*\./i.test(path);
}

function auditReportExistsAndAcceptsCompletion(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    return !auditReportHasRemainingViolations(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
}

function auditReportHasRemainingViolations(content: string): boolean {
  const numbered = content.match(/\b(\d+)\s+(?:violation(?:s)?(?:\s+paths?)?|violating\s+files?|remaining\s+violations?)\b[^\n.]*\bremain(?:s|ing)?\b/i);
  if (numbered) return Number.parseInt(numbered[1] ?? "0", 10) > 0;
  const summary = content.match(/\bviolation(?:s)?\b[^\n.]*\bremain(?:s|ing)?\b/i);
  if (!summary) return false;
  return !/\b0\s+violation(?:s)?\b/i.test(summary[0]);
}

function auditReportPaths(request: GoalControllerValidationRequest): string[] {
  const cwd = request.subagent.workspacePath;
  return (request.node.validation?.auditReportPaths ?? [])
    .concat((request.node.validation?.artifactLocks ?? []).filter((lock) => basename(lock.path).toLowerCase() === "report.md").map((lock) => lock.path))
    .map((path) => isAbsolute(path) ? path : cwd ? resolve(cwd, path) : path);
}

function buildValidationSignals(request: GoalControllerValidationRequest, result: ControllerValidationRunResult): string[] {
  const signals: string[] = [];
  for (const output of result.missingOutputs) signals.push(`missing output: ${output}`);
  for (const lock of result.artifactLockResults) {
    signals.push(`${lock.ok ? "passed" : "failed"} artifact lock: ${lock.path}${lock.actualSha256 ? ` sha256=${lock.actualSha256}` : ""}${lock.error ? ` error=${lock.error}` : ""}`);
  }
  for (const command of result.commandResults) {
    signals.push(`${command.ok ? "passed" : "failed"} validator: ${command.command}${command.output ? `\n${command.output}` : ""}`);
  }
  for (const command of result.skippedValidators) signals.push(`skipped validator by policy: ${command}`);
  for (const evidence of result.satisfiedEvidence) signals.push(`satisfied evidence: ${evidence}`);
  for (const evidence of result.missingEvidence) signals.push(`missing evidence: ${evidence}`);
  for (const failure of result.policyFailures) signals.push(`policy failure: ${failure}`);
  if (result.policyFailures.length === 0 && scopePolicyConfigured(request)) signals.push("scope policy passed");
  if (signals.length === 0) signals.push("self-report accepted; no expected outputs, executable validators, artifact locks, required evidence, or scope policy configured");
  return signals;
}

function scopePolicyFailed(result: ControllerValidationRunResult): boolean {
  return result.policyFailures.some((failure) => /allowed paths|forbidden paths/.test(failure));
}

function defaultFollowupPrompt(request: GoalControllerValidationRequest, result: ControllerValidationRunResult): string {
  const failedCommands = result.commandResults.filter((item) => !item.ok);
  const failedLocks = result.artifactLockResults.filter((item) => !item.ok);
  return [
    `Controller validation for DAG node ${request.node.nodeId} did not pass.`,
    result.missingOutputs.length ? `Create or fix the missing expected outputs: ${result.missingOutputs.join(", ")}.` : undefined,
    failedCommands.length ? `Fix the failing validators: ${failedCommands.map((item) => item.command).join(", ")}.` : undefined,
    failedLocks.length ? `Restore or explicitly revise the locked validation artifacts: ${failedLocks.map((item) => item.path).join(", ")}.` : undefined,
    result.missingEvidence.length ? `Provide the missing validation evidence: ${result.missingEvidence.join(", ")}.` : undefined,
    result.policyFailures.length ? `Resolve validation policy failures: ${result.policyFailures.join(", ")}.` : undefined,
    scopePolicyFailed(result) ? "Do not expand scope. Revert or move out-of-scope changes, or stop and ask the controller/user for an explicit plan change if the scope policy is wrong." : undefined,
    result.skippedValidators.length ? "Controller validators were configured but explicitly skipped by host policy; enable validator execution before accepting completion." : undefined,
    "After addressing the issues, report again with SUBAGENT_RESULT: <summary>.",
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeExec(command: string, args: string[], cwd: string): string {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return "";
  }
}

function safeExecResult(command: string, args: string[], cwd: string): { ok: boolean; output: string; error?: string } {
  try {
    return { ok: true, output: execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    const record = error as { stderr?: Buffer | string; message?: string };
    const stderr = toText(record.stderr).trim();
    return { ok: false, output: "", error: stderr || record.message || String(error) };
  }
}

function truncate(value: string | undefined, maxChars = 4_000): string | undefined {
  if (!value) return undefined;
  return value.length > maxChars ? value.slice(value.length - maxChars) : value;
}

function toText(value: Buffer | string | undefined): string {
  if (!value) return "";
  return typeof value === "string" ? value : value.toString("utf8");
}
