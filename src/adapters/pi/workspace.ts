import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import type { BranchVerificationStatus, WorkspaceProfile, WorkspaceProfileKind, WorkspaceStatus } from "../../core/index.js";

export interface GoalWorkspaceFlags {
  workspace?: string;
  branch?: string;
  ref?: string;
  remainingArgs: string;
}

export interface ResolvedWorkspaceBinding {
  workspace: string;
  branch?: string;
  ref?: string;
  profileName?: string;
}

export interface WorkspaceValidationResult {
  ok: boolean;
  workspace: string;
  workspaceStatus: WorkspaceStatus;
  branchVerificationStatus: BranchVerificationStatus;
  isGit: boolean;
  currentBranch?: string;
  currentRef?: string;
  dirty?: boolean;
  untracked?: boolean;
  message?: string;
}

export type WorkspaceProfileCommand =
  | { kind: "add"; profile: Omit<WorkspaceProfile, "createdAt" | "updatedAt"> }
  | { kind: "list" }
  | { kind: "show"; name: string }
  | { kind: "remove"; name: string };

export function parseGoalWorkspaceFlags(args: string): GoalWorkspaceFlags {
  const tokens = tokenize(args);
  const remaining: string[] = [];
  let workspace: string | undefined;
  let branch: string | undefined;
  let ref: string | undefined;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--workspace") {
      workspace = requireFlagValue(tokens, ++index, "--workspace");
      continue;
    }
    if (token === "--branch") {
      branch = requireFlagValue(tokens, ++index, "--branch");
      continue;
    }
    if (token === "--ref") {
      ref = requireFlagValue(tokens, ++index, "--ref");
      continue;
    }
    remaining.push(token);
  }

  if (branch && ref) throw new Error("only one of --branch or --ref may be supplied");
  return { workspace, branch, ref, remainingArgs: remaining.join(" ") };
}

export function parseWorkspaceProfileCommand(args: string, cwd: string): WorkspaceProfileCommand | undefined {
  const tokens = tokenize(args);
  if (tokens[0] !== "workspace") return undefined;
  const action = tokens[1];
  if (action === "list") return { kind: "list" };
  if ((action === "show" || action === "remove") && tokens[2]) return { kind: action, name: tokens[2] };
  if (action !== "add" || !tokens[2]) throw new Error("usage: /goal workspace add <name> --path <path> [--branch <branch>|--ref <ref>]");

  const name = tokens[2];
  let path: string | undefined;
  let branch: string | undefined;
  let ref: string | undefined;
  let kind: WorkspaceProfileKind = "git";

  for (let index = 3; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "--path") {
      path = resolve(cwd, requireFlagValue(tokens, ++index, "--path"));
      continue;
    }
    if (token === "--branch") {
      branch = requireFlagValue(tokens, ++index, "--branch");
      continue;
    }
    if (token === "--ref") {
      ref = requireFlagValue(tokens, ++index, "--ref");
      continue;
    }
    if (token === "--non-git") {
      kind = "nonGit";
      continue;
    }
    throw new Error(`unknown workspace profile option: ${token}`);
  }

  if (!path) throw new Error("workspace profile requires --path");
  if (branch && ref) throw new Error("workspace profile accepts only one of --branch or --ref");
  if (kind === "git" && !branch && !ref) throw new Error("git workspace profile requires --branch or --ref");
  if (kind === "nonGit" && (branch || ref)) throw new Error("non-git workspace profile must not set --branch or --ref");
  return { kind: "add", profile: { name, path, kind, branch, ref } };
}

export function resolveWorkspaceBinding(
  flags: Pick<GoalWorkspaceFlags, "workspace" | "branch" | "ref">,
  profiles: WorkspaceProfile[],
  cwd: string,
): ResolvedWorkspaceBinding {
  if (!flags.workspace) throw new Error("/goal requires --workspace <path-or-profile> for goal-owned execution sessions");
  const profile = profiles.find((candidate) => candidate.name === flags.workspace);
  const workspace = profile ? profile.path : resolve(cwd, flags.workspace);
  const branch = flags.branch ?? profile?.branch;
  const ref = flags.ref ?? profile?.ref;
  if (branch && ref) throw new Error("only one of --branch or --ref may be supplied");
  return { workspace, branch, ref, profileName: profile?.name };
}

export function validateExecutionWorkspace(binding: ResolvedWorkspaceBinding): WorkspaceValidationResult {
  const allowedRoots = readAllowedWorkspaceRoots();
  if (allowedRoots.length > 0 && !isUnderAllowedRoot(binding.workspace, allowedRoots)) {
    return failure(
      binding,
      "notAllowed",
      "notApplicable",
      false,
      `execution workspace is outside allowed roots: ${binding.workspace}`,
    );
  }

  if (!existsSync(binding.workspace)) {
    return failure(binding, "missing", "notApplicable", false, `execution workspace does not exist: ${binding.workspace}`);
  }
  if (!statSync(binding.workspace).isDirectory()) {
    return failure(binding, "inaccessible", "notApplicable", false, `execution workspace is not a directory: ${binding.workspace}`);
  }

  const isGit = isGitWorkspace(binding.workspace);
  if (!isGit) {
    if (binding.branch || binding.ref) {
      return failure(binding, "configured", "notGit", false, "--branch/--ref was supplied for a non-git workspace");
    }
    return {
      ok: true,
      workspace: binding.workspace,
      workspaceStatus: "configured",
      branchVerificationStatus: "notApplicable",
      isGit: false,
    };
  }

  if (!binding.branch && !binding.ref) {
    return failure(binding, "configured", "unknown", true, "git-backed execution workspace requires --branch or --ref");
  }

  const currentBranch = safeGitOutput(binding.workspace, ["branch", "--show-current"]);
  const currentRef = safeGitOutput(binding.workspace, ["rev-parse", "HEAD"]);
  const expectedMatches = binding.branch ? currentBranch === binding.branch : currentRef === binding.ref;
  const status = gitOutput(binding.workspace, ["status", "--porcelain"]);
  const dirty = status.split("\n").some((line) => line.length > 0 && !line.startsWith("??"));
  const untracked = status.split("\n").some((line) => line.startsWith("??"));

  return {
    ok: expectedMatches,
    workspace: binding.workspace,
    workspaceStatus: "configured",
    branchVerificationStatus: expectedMatches ? "verified" : "mismatch",
    isGit: true,
    currentBranch: currentBranch || undefined,
    currentRef: currentRef || undefined,
    dirty,
    untracked,
    message: expectedMatches ? undefined : `workspace branch/ref mismatch: expected ${binding.branch ?? binding.ref}, got ${currentBranch || currentRef}`,
  };
}

function failure(
  binding: ResolvedWorkspaceBinding,
  workspaceStatus: WorkspaceStatus,
  branchVerificationStatus: BranchVerificationStatus,
  isGit: boolean,
  message: string,
): WorkspaceValidationResult {
  return { ok: false, workspace: binding.workspace, workspaceStatus, branchVerificationStatus, isGit, message };
}

function readAllowedWorkspaceRoots(): string[] {
  return (process.env.AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(entry));
}

function isUnderAllowedRoot(workspace: string, allowedRoots: string[]): boolean {
  const resolvedWorkspace = resolve(workspace);
  return allowedRoots.some((root) => resolvedWorkspace === root || resolvedWorkspace.startsWith(`${root}/`));
}

function isGitWorkspace(cwd: string): boolean {
  try {
    return gitOutput(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch {
    return false;
  }
}

function safeGitOutput(cwd: string, args: string[]): string {
  try {
    return gitOutput(cwd, args);
  } catch {
    return "";
  }
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

function requireFlagValue(tokens: string[], index: number, flag: string): string {
  const value = tokens[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of input) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/u.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (quote) throw new Error("unterminated quote in /goal command");
  if (escaped) current += "\\";
  if (current) tokens.push(current);
  return tokens;
}
