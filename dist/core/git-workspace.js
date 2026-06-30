import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { requiredSubagentIntegrationTerminalSuccess } from "./integration.js";
export const TRUSTED_SUBMODULE_URL_PATTERNS_ENV = "AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS";
export const AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY = {
    remoteCloseoutMode: "block-if-cannot-push",
    submodulePublishMode: "publish-retained-ref-if-trusted",
    cleanupAutoAllocatedWorktrees: true,
    allowExplicitWorkspaceCleanup: false,
    parentRemote: "origin",
    durableRefPatterns: [
        "refs/heads/main",
        "refs/heads/master",
        "refs/heads/release/*",
        "refs/heads/goal-runner/retained/*",
    ],
    trustedSubmoduleUrlPatterns: [],
    verifyNestedSubmodules: true,
    prePushCheckoutSimulation: true,
    postPushRemoteCheckoutVerification: true,
};
export const EXPLICIT_WORKSPACE_DEFAULT_CLOSEOUT_POLICY = {
    remoteCloseoutMode: "local-only",
    submodulePublishMode: "block-if-unpublished",
    cleanupAutoAllocatedWorktrees: false,
    allowExplicitWorkspaceCleanup: false,
    parentRemote: "origin",
    durableRefPatterns: [
        "refs/heads/main",
        "refs/heads/master",
        "refs/heads/release/*",
        "refs/heads/goal-runner/retained/*",
    ],
    trustedSubmoduleUrlPatterns: [],
    verifyNestedSubmodules: true,
    prePushCheckoutSimulation: false,
    postPushRemoteCheckoutVerification: false,
};
export function resolveNativeGitCloseoutPolicy(policy, options = {}) {
    const configuredPatterns = options.trustedSubmoduleUrlPatterns
        ?? parseTrustedSubmoduleUrlPatterns(options.env?.[TRUSTED_SUBMODULE_URL_PATTERNS_ENV]);
    return {
        ...policy,
        durableRefPatterns: [...policy.durableRefPatterns],
        trustedSubmoduleUrlPatterns: uniqueNonEmptyStrings([
            ...policy.trustedSubmoduleUrlPatterns,
            ...configuredPatterns,
        ]),
    };
}
export function parseTrustedSubmoduleUrlPatterns(value) {
    if (!value?.trim())
        return [];
    const trimmed = value.trim();
    if (trimmed.startsWith("[")) {
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed))
                return uniqueNonEmptyStrings(parsed.map((item) => String(item)));
        }
        catch {
            // Fall through to delimiter parsing so malformed JSON remains non-fatal.
        }
    }
    return uniqueNonEmptyStrings(trimmed.split(/[\n,]+/));
}
function uniqueNonEmptyStrings(values) {
    const result = [];
    for (const value of values) {
        const trimmed = value.trim();
        if (!trimmed || result.includes(trimmed))
            continue;
        result.push(trimmed);
    }
    return result;
}
/**
 * Environment variable that can supply additional trusted submodule URL
 * patterns for target-branch publication, layered on top of the policy's
 * built-in patterns. Value may be a JSON array of strings or a
 * newline/comma-delimited list.
 */
export const TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS_ENV = "AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS";
/**
 * Default target-branch policy for auto-allocated remote closeout.
 * - enforcementScope is "final-tree": only submodules in the final tree
 *   are enforced.
 * - branchMappings is empty: the default remote branch is used for all
 *   submodules.
 * - trustedSubmoduleTargetBranchUrlPatterns is empty: only URLs that
 *   match the closeout policy's trusted patterns are published.
 * - verifyRemoteReachability is true: fails if remote verification fails.
 */
export const DEFAULT_SUBMODULE_TARGET_BRANCH_POLICY = {
    enforcementScope: "final-tree",
    branchMappings: [],
    trustedSubmoduleTargetBranchUrlPatterns: [],
    verifyRemoteReachability: true,
};
/**
 * Resolves a {@link NativeGitSubmoduleTargetBranchPolicy} by merging
 * environment-configured trusted URL patterns.
 */
export function resolveSubmoduleTargetBranchPolicy(policy, options = {}) {
    const configuredPatterns = parseTrustedSubmoduleUrlPatterns(options.env?.[TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS_ENV]);
    return {
        ...policy,
        enforcementScope: policy.enforcementScope ?? "final-tree",
        branchMappings: [...(policy.branchMappings ?? [])],
        trustedSubmoduleTargetBranchUrlPatterns: uniqueNonEmptyStrings([
            ...policy.trustedSubmoduleTargetBranchUrlPatterns,
            ...configuredPatterns,
        ]),
        verifyRemoteReachability: policy.verifyRemoteReachability ?? true,
    };
}
// ── Target branch resolution primitives ──
/**
 * Resolves the target branch for a submodule by checking, in order:
 * 1. Explicit {@link NativeGitSubmoduleTargetBranchMapping.branchMappings} entries
 *    (direct path match or trailing glob `*` match, with longest match winning).
 * 2. The `branch` key in the submodule&#39;s `.gitmodules` entry (versioned in the
 *    parent tree).
 * 3. The remote default branch of the submodule&#39;s canonical URL
 *    (via `git ls-remote --symref`).
 * 4. The parent target branch, if one is provided, as a controlled fallback.
 *
 * Returns the resolved branch name or undefined when no resolution strategy
 * produces a result.
 */
export function resolveSubmoduleTargetBranch(submodulePath, policy, parentWorkspacePath, treeish, parentTargetBranch) {
    // Priority 1: explicit branchMappings (longest match wins)
    const mapping = matchBranchMapping(submodulePath, policy.branchMappings);
    if (mapping)
        return mapping.targetBranch;
    // Priority 2: .gitmodules branch key
    const gitmodulesBranch = resolveGitmodulesSubmoduleBranch(parentWorkspacePath, submodulePath, treeish);
    if (gitmodulesBranch)
        return gitmodulesBranch;
    // Priority 3: remote default branch from canonical URL
    const canonicalUrl = resolveSubmoduleCanonicalUrl(parentWorkspacePath, submodulePath, treeish);
    if (canonicalUrl) {
        const remoteDefault = resolveRemoteDefaultBranch(canonicalUrl);
        if (remoteDefault)
            return remoteDefault;
    }
    // Priority 4: parent target branch fallback
    if (parentTargetBranch)
        return parentTargetBranch;
    return undefined;
}
/**
 * Matches a submodule path against branch mappings. Returns the mapping with
 * the longest matching path (most specific wins). Supports glob patterns where
 * the mapping path ends with `*`.
 */
function matchBranchMapping(submodulePath, mappings) {
    const normalized = normalizeGitPath(submodulePath);
    let best;
    let bestLength = 0;
    for (const mapping of mappings) {
        const pattern = normalizeGitPath(mapping.path);
        let matched = false;
        if (pattern.endsWith("*")) {
            const prefix = pattern.slice(0, -1);
            if (normalized.startsWith(prefix))
                matched = true;
        }
        else if (pattern === normalized) {
            matched = true;
        }
        if (matched) {
            const length = pattern.endsWith("*") ? pattern.length - 1 : pattern.length;
            if (length > bestLength) {
                best = mapping;
                bestLength = length;
            }
        }
    }
    return best;
}
/**
 * Resolves the `branch` key from the submodule&#39;s section in `.gitmodules`.
 * Reads from the versioned treeish (HEAD/INDEX) or the WORKTREE file.
 */
export function resolveGitmodulesSubmoduleBranch(parentWorkspacePath, submodulePath, treeish) {
    const config = readGitmodulesAtTreeish(parentWorkspacePath, treeish);
    if (!config)
        return undefined;
    let currentPath;
    let currentBranch;
    let inSubmoduleSection = false;
    const flush = () => {
        if (inSubmoduleSection && currentPath === submodulePath && currentBranch) {
            return currentBranch.trim() || undefined;
        }
        return undefined;
    };
    for (const raw of config.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#"))
            continue;
        const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]$/);
        if (sectionMatch) {
            const resolved = flush();
            if (resolved)
                return resolved;
            inSubmoduleSection = true;
            currentPath = undefined;
            currentBranch = undefined;
            continue;
        }
        if (!inSubmoduleSection)
            continue;
        if (line.startsWith("[")) {
            // Entering a new section — flush current submodule
            const resolved = flush();
            if (resolved)
                return resolved;
            inSubmoduleSection = false;
            currentPath = undefined;
            currentBranch = undefined;
            continue;
        }
        const eq = line.indexOf("=");
        if (eq === -1)
            continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === "path")
            currentPath = value;
        if (key === "branch")
            currentBranch = value;
    }
    return flush();
}
/**
 * Resolves the default branch of a remote Git repository using
 * `git ls-remote --symref`. Returns the branch name or undefined.
 */
export function resolveRemoteDefaultBranch(canonicalUrl) {
    try {
        const output = execFileSync("git", ["ls-remote", "--symref", canonicalUrl, "HEAD"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
        });
        // Parse: ref: refs/heads/main	HEAD
        const match = output.match(/^ref:\s*refs\/heads\/(\S+)\s+HEAD$/m);
        return match?.[1] || undefined;
    }
    catch {
        return undefined;
    }
}
// ── Target branch verification primitives ──
/**
 * Checks whether a remote branch already contains a given commit SHA,
 * without requiring any publish trust. Uses an isolated bare clone to
 * fetch the candidate branch and runs `git merge-base --is-ancestor`.
 *
 * This is the non-trusting containment check: the caller does not need
 * push access or trust; they only need fetch access to inspect.
 */
export function branchContainsCommitRemotely(canonicalUrl, sha, targetBranch) {
    const tmpDir = resolve("/tmp", `goal-target-branch-contains-${uniqueTempSuffix()}`);
    try {
        mkdirSync(tmpDir, { recursive: true });
        git(tmpDir, ["init", "--bare"]);
        // Fetch the target branch only — no trust required, no push involved
        const refspec = `refs/heads/${targetBranch}:refs/heads/${targetBranch}`;
        git(tmpDir, ["fetch", "--no-tags", canonicalUrl, refspec]);
        const fetchedSha = safeGit(tmpDir, ["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`]);
        if (!fetchedSha) {
            return { contained: false, error: `target branch ${targetBranch} does not exist on remote ${canonicalUrl}` };
        }
        const isAncestor = gitIsAncestor(tmpDir, sha, fetchedSha);
        return { contained: isAncestor };
    }
    catch (error) {
        return { contained: false, error: `failed to inspect remote branch ${targetBranch}: ${gitErrorMessage(error)}` };
    }
    finally {
        rmRecursiveSafe(tmpDir);
    }
}
// ── Source-object resolution for target branch publication ──
/**
 * Ensures a submodule commit SHA is available in the submodule worktree
 * by locating it in source workspaces or fetching from remote.
 *
 * This extends {@link ensureSubmoduleCommitAvailable} with target-branch-
 * specific fetch sources: it first checks retained/durable refs, then
 * source workspaces, then falls back to fetching the target branch itself.
 *
 * Returns true when the SHA object is available in `submoduleWorktree`
 * after the operation.
 */
export function ensureSubmoduleTargetShaAvailable(submoduleWorktree, submodulePath, sha, sourceWorkspacePaths, canonicalUrl, targetBranch) {
    // Fast path: already present
    if (gitCommitObjectExists(submoduleWorktree, sha))
        return true;
    // Step 1: Try retained/durable refs from canonical URL
    if (canonicalUrl) {
        const durablePatterns = [
            "refs/heads/goal-runner/retained/*",
            "refs/heads/main",
            "refs/heads/master",
        ];
        for (const pattern of durablePatterns) {
            try {
                const refsOutput = git("/tmp", ["ls-remote", "--refs", canonicalUrl, pattern]);
                if (!refsOutput)
                    continue;
                for (const line of refsOutput.split("\n")) {
                    const parts = line.split(/\s+/);
                    const ref = parts[1];
                    if (!ref)
                        continue;
                    try {
                        git(submoduleWorktree, ["fetch", "--no-tags", canonicalUrl, `${ref}:${ref}`]);
                        if (gitCommitObjectExists(submoduleWorktree, sha))
                            return true;
                    }
                    catch {
                        // Try next ref
                    }
                }
            }
            catch {
                // Try next pattern
            }
        }
        // Step 2: Try fetching the target branch itself (may contain the SHA)
        if (targetBranch) {
            try {
                git(submoduleWorktree, ["fetch", "--no-tags", canonicalUrl, `refs/heads/${targetBranch}:refs/heads/${targetBranch}`]);
                if (gitCommitObjectExists(submoduleWorktree, sha))
                    return true;
            }
            catch {
                // Fall through
            }
        }
    }
    // Step 3: Try source workspaces (existing logic)
    for (const workspacePath of sourceWorkspacePaths) {
        const objectSource = locateSubmoduleCommitObject(sha, [workspacePath], submodulePath);
        if (!objectSource)
            continue;
        const sourceRepo = objectSource.includes(`${sep}.git${sep}modules${sep}`) ? objectSource : resolve(objectSource, submodulePath);
        if (!existsSync(sourceRepo))
            continue;
        try {
            git(submoduleWorktree, ["fetch", "--no-tags", sourceRepo, sha]);
        }
        catch {
            continue;
        }
        if (gitCommitObjectExists(submoduleWorktree, sha))
            return true;
    }
    return false;
}
export function publishShaToSubmoduleTargetBranch(submoduleWorktree, canonicalUrl, sha, targetBranch, policy) {
    // Check if branch already contains the SHA (no publish needed)
    const containment = branchContainsCommitRemotely(canonicalUrl, sha, targetBranch);
    if (containment.contained) {
        return { published: false, alreadyContained: true };
    }
    if (containment.error?.includes("does not exist")) {
        // Branch does not exist on remote — that&#39;s a blocking condition
        return { published: false, alreadyContained: false, error: `target branch ${targetBranch} does not exist on remote ${canonicalUrl}` };
    }
    if (containment.error && !containment.contained) {
        // Unexpected failure inspecting the branch — fail closed
        return { published: false, alreadyContained: false, error: `cannot inspect target branch ${targetBranch}: ${containment.error}` };
    }
    // Verify ancestor proof: SHA must be a descendant of the current branch tip
    const tmpDir = resolve("/tmp", `goal-target-branch-ff-${uniqueTempSuffix()}`);
    try {
        mkdirSync(tmpDir, { recursive: true });
        git(tmpDir, ["init", "--bare"]);
        // Fetch the current branch tip
        const fetchRefspec = `refs/heads/${targetBranch}:refs/heads/${targetBranch}`;
        git(tmpDir, ["fetch", "--no-tags", canonicalUrl, fetchRefspec]);
        const currentTip = safeGit(tmpDir, ["rev-parse", "--verify", `refs/heads/${targetBranch}^{commit}`]);
        if (currentTip) {
            // SHA must be a descendant of currentTip (fast-forward check)
            if (!gitIsAncestor(tmpDir, currentTip, sha)) {
                return {
                    published: false,
                    alreadyContained: false,
                    error: `cannot publish ${shortSha(sha)} to ${targetBranch}: not a fast-forward (${shortSha(sha)} is not a descendant of ${shortSha(currentTip)})`,
                };
            }
        }
        // If currentTip is missing (empty repo or new branch), fast-forward is vacuously true
    }
    catch (error) {
        return {
            published: false,
            alreadyContained: false,
            error: `failed to verify fast-forward proof: ${gitErrorMessage(error)}`,
        };
    }
    finally {
        rmRecursiveSafe(tmpDir);
    }
    // Non-force push: the remote will reject if the push is not a fast-forward
    try {
        const refspec = `${sha}:refs/heads/${targetBranch}`;
        execFileSync("git", ["push", "--no-verify", canonicalUrl, refspec], {
            cwd: submoduleWorktree,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 60_000,
        });
    }
    catch (error) {
        const message = gitErrorMessage(error);
        // Classify the error for diagnostic purposes
        if (/protected\s+branch|cannot\s+force\s+update|denyNonFastForward/i.test(message)) {
            return {
                published: false,
                alreadyContained: false,
                error: `target branch ${targetBranch} is protected or rejects non-fast-forward pushes: ${message}`,
            };
        }
        if (/rejected|push\s+failed|remote\s+rejected/i.test(message)) {
            return {
                published: false,
                alreadyContained: false,
                error: `push to ${targetBranch} rejected: ${message}`,
            };
        }
        return {
            published: false,
            alreadyContained: false,
            error: `failed to push ${shortSha(sha)} to ${targetBranch}: ${message}`,
        };
    }
    // Post-push reachability verification (when policy requires it)
    if (policy.verifyRemoteReachability) {
        const verification = branchContainsCommitRemotely(canonicalUrl, sha, targetBranch);
        if (!verification.contained) {
            return {
                published: true,
                alreadyContained: false,
                verificationError: verification.error || `pushed ${shortSha(sha)} to ${targetBranch} but post-push verification failed: SHA not reachable`,
            };
        }
    }
    return { published: true, alreadyContained: false };
}
// ── Evaluation entry point ──
/**
 * Evaluates and applies the target-branch publication policy for a set of
 * changed submodule gitlinks. This is the main entry point for target-branch
 * enforcement during closeout or integration.
 *
 * For each submodule in the enforcement scope:
 * 1. Resolves the target branch via policy, .gitmodules, remote default.
 * 2. Checks if the branch already contains the target SHA (containment).
 * 3. Ensures the SHA object is available in the submodule push source.
 * 4. Publishes only with fast-forward proof and non-force refspec.
 * 5. Blocks on: missing branch, ambiguous branch, divergence,
 *    missing target object, missing trust, protected branch, push rejection.
 */
export function evaluateSubmoduleTargetBranchPolicy(parentWorkspacePath, policy, submoduleGitlinks, sourceWorkspacePaths, options = {}) {
    const treeish = options.treeish ?? "HEAD";
    const remoteName = options.remoteName ?? "origin";
    const parentTargetBranch = options.parentTargetBranch;
    // Determine which submodules to enforce
    let enforcedGitlinks;
    if (policy.enforcementScope === "none") {
        return {
            status: "skipped",
            summary: "target-branch enforcement scope is none",
            published: [],
            blocked: [],
            diagnostics: [],
        };
    }
    if (policy.enforcementScope === "final-tree") {
        // Only submodules present in the final tree with a new SHA (added or modified)
        enforcedGitlinks = submoduleGitlinks.filter((g) => g.status !== "deleted" && g.newSha);
    }
    else {
        // "all-submodules": include all gitlinks (even deleted, for diagnostic)
        enforcedGitlinks = submoduleGitlinks;
    }
    if (enforcedGitlinks.length === 0) {
        return {
            status: "skipped",
            summary: "no submodule gitlinks in enforcement scope",
            published: [],
            blocked: [],
            diagnostics: [],
        };
    }
    const published = [];
    const blocked = [];
    const diagnostics = [];
    for (const gitlink of enforcedGitlinks) {
        const submodulePath = gitlink.path;
        const sha = gitlink.newSha;
        // Resolve canonical URL for diagnostics
        const canonicalUrl = resolveSubmoduleCanonicalUrl(parentWorkspacePath, submodulePath, treeish)
            ?? resolveSubmoduleCanonicalUrl(parentWorkspacePath, submodulePath, "WORKTREE");
        if (!canonicalUrl) {
            const diagnostic = {
                path: submodulePath,
                sourceObjectRef: sha ?? "",
                canonicalUrl: "",
                enforcementMatched: true,
                published: false,
                error: "cannot resolve canonical URL for submodule",
            };
            diagnostics.push(diagnostic);
            if (sha) {
                blocked.push({ path: submodulePath, sha, reason: "cannot resolve canonical URL for submodule" });
            }
            continue;
        }
        // URL trust check: must match target-branch-trusted patterns or closeout policy
        if (!isSubmoduleUrlTrustedByPolicy(canonicalUrl, policy)) {
            const diagnostic = {
                path: submodulePath,
                sourceObjectRef: sha ?? "",
                canonicalUrl,
                enforcementMatched: true,
                published: false,
                error: `submodule URL ${canonicalUrl} is not trusted for target-branch publication`,
            };
            diagnostics.push(diagnostic);
            if (sha) {
                blocked.push({ path: submodulePath, sha, reason: `URL ${canonicalUrl} not in trusted patterns` });
            }
            continue;
        }
        // Resolve target branch
        const targetBranch = resolveSubmoduleTargetBranch(submodulePath, policy, parentWorkspacePath, treeish, parentTargetBranch);
        if (!targetBranch) {
            const diagnostic = {
                path: submodulePath,
                sourceObjectRef: sha ?? "",
                canonicalUrl,
                enforcementMatched: true,
                published: false,
                error: "cannot resolve target branch for submodule: no mapping, no .gitmodules branch, no remote default, no parent fallback",
            };
            diagnostics.push(diagnostic);
            if (sha) {
                blocked.push({ path: submodulePath, sha, reason: "cannot resolve target branch" });
            }
            continue;
        }
        if (!sha) {
            // Deleted submodule or missing SHA — skip publication but record diagnostic
            diagnostics.push({
                path: submodulePath,
                sourceObjectRef: sha ?? "",
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: false,
                error: sha === undefined ? "deleted submodule: no SHA to publish" : "missing SHA",
            });
            continue;
        }
        // Check remote containment (no trust required for inspection)
        const containment = branchContainsCommitRemotely(canonicalUrl, sha, targetBranch);
        if (containment.contained) {
            diagnostics.push({
                path: submodulePath,
                sourceObjectRef: sha,
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: true,
            });
            published.push({ path: submodulePath, sha, canonicalUrl, targetBranch });
            continue;
        }
        // Branch missing on remote
        if (containment.error?.includes("does not exist")) {
            const diagnostic = {
                path: submodulePath,
                sourceObjectRef: sha,
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: false,
                error: containment.error,
            };
            diagnostics.push(diagnostic);
            blocked.push({ path: submodulePath, sha, reason: containment.error });
            continue;
        }
        // Ensure SHA object is available locally
        const submoduleWorktree = resolve(parentWorkspacePath, submodulePath);
        const shaAvailable = ensureSubmoduleTargetShaAvailable(submoduleWorktree, submodulePath, sha, sourceWorkspacePaths, canonicalUrl, targetBranch);
        if (!shaAvailable) {
            const diagnostic = {
                path: submodulePath,
                sourceObjectRef: sha,
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: false,
                error: `cannot locate submodule commit ${shortSha(sha)} in any source workspace or remote ref for publication to ${targetBranch}`,
            };
            diagnostics.push(diagnostic);
            blocked.push({ path: submodulePath, sha, reason: `missing target object ${shortSha(sha)}` });
            continue;
        }
        // Publish with fast-forward-only semantics
        const publishResult = publishShaToSubmoduleTargetBranch(submoduleWorktree, canonicalUrl, sha, targetBranch, policy);
        if (publishResult.published || publishResult.alreadyContained) {
            diagnostics.push({
                path: submodulePath,
                sourceObjectRef: sha,
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: true,
                error: publishResult.verificationError,
            });
            if (!publishResult.alreadyContained) {
                published.push({ path: submodulePath, sha, canonicalUrl, targetBranch });
            }
            else {
                published.push({ path: submodulePath, sha, canonicalUrl, targetBranch });
            }
        }
        else {
            const errorMessage = publishResult.error ?? "unknown publication error";
            diagnostics.push({
                path: submodulePath,
                sourceObjectRef: sha,
                canonicalUrl,
                mappedBranch: targetBranch,
                enforcementMatched: true,
                published: false,
                error: errorMessage,
            });
            blocked.push({ path: submodulePath, sha, reason: errorMessage });
        }
    }
    if (blocked.length > 0) {
        return {
            status: "blocked",
            summary: `target-branch publication blocked for ${blocked.length} submodule(s): ${blocked.map((b) => `${b.path}: ${b.reason}`).join("; ")}`,
            published,
            blocked,
            diagnostics,
        };
    }
    return {
        status: "passed",
        summary: `target-branch publication passed: ${published.length} submodule(s) published to target branches`,
        published,
        blocked: [],
        diagnostics,
    };
}
/**
 * Checks whether a canonical URL is trusted for target-branch publication.
 * Checks both the target-branch-specific patterns and the closeout policy patterns.
 */
function isSubmoduleUrlTrustedByPolicy(url, policy) {
    if (policy.trustedSubmoduleTargetBranchUrlPatterns.some((pattern) => submoduleUrlMatchesPattern(url, pattern))) {
        return true;
    }
    return false;
}
export class NativeGitWorkspaceManager {
    options;
    constructor(options = {}) {
        this.options = {
            worktreeRoot: options.worktreeRoot,
            defaultBaseRef: options.defaultBaseRef,
            remote: options.remote ?? "origin",
            branchPrefix: options.branchPrefix ?? "goal",
            fetch: options.fetch ?? true,
        };
    }
    allocateControllerWorkspace(request) {
        const repoRoot = findGitRepositoryRoot(request.invocationCwd);
        if (!repoRoot) {
            throw new Error(`cannot allocate goal workspace: ${request.invocationCwd} is not inside a Git repository`);
        }
        if (this.options.fetch)
            safeGit(repoRoot, ["fetch", this.options.remote, "--prune"]);
        const baseRef = this.resolveBaseRef(repoRoot, request.baseRef);
        const baseSlug = slugForGoal(request.goalId, request.objective);
        const worktreeRoot = this.resolveWorktreeRoot(repoRoot);
        mkdirSync(worktreeRoot, { recursive: true });
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
            const branch = `${this.options.branchPrefix}/${slug}`;
            const worktreePath = resolve(worktreeRoot, slug);
            if (existsSync(worktreePath) || gitRefExists(repoRoot, branch))
                continue;
            git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
            initializeNewNativeGitWorktreeSubmodules(repoRoot, worktreePath, branch, false);
            return {
                repoRoot,
                worktreePath,
                branch,
                baseRef,
                slug,
                allocationReason: "workspace-and-branch-omitted",
                created: true,
            };
        }
        throw new Error(`cannot allocate unique goal workspace for objective: ${request.objective}`);
    }
    allocateSubagentWorkspace(request) {
        const seedPath = request.repoRoot ?? request.invocationCwd ?? request.controllerWorkspacePath;
        if (!seedPath)
            throw new Error("cannot allocate subagent workspace: repoRoot, invocationCwd, or controllerWorkspacePath is required");
        const repoRoot = findGitRepositoryRoot(seedPath);
        if (!repoRoot)
            throw new Error(`cannot allocate subagent workspace: ${seedPath} is not inside a Git repository`);
        if (this.options.fetch)
            safeGit(repoRoot, ["fetch", this.options.remote, "--prune"]);
        const baseRef = this.resolveSubagentBaseRef(repoRoot, request);
        const goalPrefix = sanitizeSlug(request.goalId).slice(0, 12);
        const baseSlug = request.worktreeSlug ? assertSafeWorktreeSlug(request.worktreeSlug) : slugForGoalSubagent(request.goalId, request.nodeSlug ?? request.nodeId, request.nodeObjective);
        const baseSubagentId = sanitizeSlug(request.subagentId ?? `subagent-${baseSlug}`);
        const worktreeRoot = this.resolveWorktreeRoot(repoRoot);
        mkdirSync(worktreeRoot, { recursive: true });
        if (request.worktreeSlug || request.branch) {
            const branch = request.branch ?? `${this.options.branchPrefix}/${goalPrefix}/${baseSlug}`;
            assertSafeBranchName(repoRoot, branch);
            return this.ensureBoundSubagentWorkspace({
                repoRoot,
                worktreeRoot,
                worktreePath: resolve(worktreeRoot, baseSlug),
                branch,
                baseRef,
                slug: baseSlug,
                nodeId: request.nodeId,
                subagentId: baseSubagentId,
            });
        }
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
            const subagentId = attempt === 0 ? baseSubagentId : `${baseSubagentId}-${attempt + 1}`;
            const branch = `${this.options.branchPrefix}/${goalPrefix}/${slug}`;
            const worktreePath = resolve(worktreeRoot, slug);
            if (existsSync(worktreePath) || gitRefExists(repoRoot, branch))
                continue;
            git(repoRoot, ["worktree", "add", "-b", branch, worktreePath, baseRef]);
            initializeNewNativeGitWorktreeSubmodules(repoRoot, worktreePath, branch, false);
            return {
                repoRoot,
                worktreePath,
                branch,
                baseRef,
                slug,
                nodeId: request.nodeId,
                subagentId,
                allocationReason: "subagent-dag-node",
                created: true,
            };
        }
        throw new Error(`cannot allocate unique subagent workspace for DAG node: ${request.nodeId}`);
    }
    ensureBoundSubagentWorkspace(request) {
        const resolvedRoot = resolve(request.worktreeRoot);
        const resolvedWorktree = resolve(request.worktreePath);
        if (resolvedWorktree !== resolvedRoot && !resolvedWorktree.startsWith(`${resolvedRoot}/`)) {
            throw new Error(`bound subagent worktree must stay under worktree root: ${request.worktreePath}`);
        }
        if (existsSync(resolvedWorktree)) {
            const workspaceRepo = findGitRepositoryRoot(resolvedWorktree);
            if (!workspaceRepo)
                throw new Error(`bound subagent worktree path exists but is not a Git worktree: ${resolvedWorktree}`);
            const currentBranch = safeGit(resolvedWorktree, ["branch", "--show-current"]);
            if (currentBranch !== request.branch) {
                throw new Error(`bound subagent worktree branch mismatch: expected ${request.branch}, got ${currentBranch || "detached"}. ` +
                    `This worktree may belong to a different goal or node. Remove it manually or use a different worktreeSlug.`);
            }
            const dirty = gitStatusPorcelain(resolvedWorktree);
            if (dirty)
                throw new Error(`bound subagent worktree has uncommitted changes; cannot reuse safely:\n${dirty}`);
            initializeNativeGitWorktreeSubmodules(resolvedWorktree);
            return {
                repoRoot: request.repoRoot,
                worktreePath: resolvedWorktree,
                branch: request.branch,
                baseRef: request.baseRef,
                slug: request.slug,
                nodeId: request.nodeId,
                subagentId: request.subagentId,
                allocationReason: "subagent-dag-node",
                created: false,
            };
        }
        const branchExisted = gitRefExists(request.repoRoot, request.branch);
        if (branchExisted)
            git(request.repoRoot, ["worktree", "add", resolvedWorktree, request.branch]);
        else
            git(request.repoRoot, ["worktree", "add", "-b", request.branch, resolvedWorktree, request.baseRef]);
        initializeNewNativeGitWorktreeSubmodules(request.repoRoot, resolvedWorktree, request.branch, branchExisted);
        return {
            repoRoot: request.repoRoot,
            worktreePath: resolvedWorktree,
            branch: request.branch,
            baseRef: request.baseRef,
            slug: request.slug,
            nodeId: request.nodeId,
            subagentId: request.subagentId,
            allocationReason: "subagent-dag-node",
            created: true,
        };
    }
    cleanupWorkspace(request) {
        const repoRoot = request.repoRoot ?? findGitCommonRepositoryRoot(request.worktreePath) ?? findGitRepositoryRoot(request.worktreePath) ?? process.cwd();
        let reachabilityVerified;
        if (request.force && request.verifyReachable) {
            if (!request.integrationSourceHead) {
                throw new Error("cannot force-delete worktree because integrationSourceHead is required for reachability verification");
            }
            reachabilityVerified = branchContainsCommit(repoRoot, request.integrationSourceHead);
            if (!reachabilityVerified) {
                throw new Error(`cannot force-delete worktree for ${request.branch ?? "<unknown branch>"}: integration source ${shortSha(request.integrationSourceHead)} is not reachable from any local branch`);
            }
        }
        const registeredWorktrees = listGitWorktrees(repoRoot).map((item) => resolve(item.worktreePath));
        const requestedWorktree = resolve(request.worktreePath);
        const worktreeRegistered = registeredWorktrees.includes(requestedWorktree);
        const worktreeExists = existsSync(request.worktreePath);
        if (worktreeRegistered || worktreeExists) {
            if (request.force && worktreeExists)
                git(request.worktreePath, ["clean", "-fd"]);
            git(repoRoot, ["worktree", "remove", ...(request.force ? ["--force"] : []), request.worktreePath]);
        }
        if (request.branch && gitRefExists(repoRoot, request.branch)) {
            git(repoRoot, ["branch", request.force ? "-D" : "-d", request.branch]);
        }
        return { reachabilityVerified };
    }
    syncSubmoduleWorktreesToHeadPins(request) {
        const targetWorkspacePath = resolve(request.targetWorkspacePath);
        const repoRoot = findGitRepositoryRoot(targetWorkspacePath);
        if (!repoRoot) {
            return nativeGitSubmoduleCheckoutSyncBlocked(request, `target workspace is not inside a Git repository: ${targetWorkspacePath}`);
        }
        const changedPaths = listChangedSubmoduleCheckoutPaths(targetWorkspacePath, { recursive: request.recursive ?? true });
        if (changedPaths.length === 0) {
            return {
                status: "skipped",
                summary: "submodule checkout sync skipped: no submodule checkout mismatches detected",
                targetWorkspacePath,
                changedPaths: [],
                updatedPaths: [],
                blockers: [],
            };
        }
        const blockers = [];
        if (!request.allowRootWorktreeChanges) {
            const rootDirty = gitStatusPorcelain(targetWorkspacePath, { ignoreWorktreeRoot: true });
            for (const line of rootDirty.split(/\r?\n/).filter((item) => item.trim())) {
                const dirtyPath = statusPath(line);
                if (!pathTouchesAny(dirtyPath, changedPaths))
                    blockers.push({ path: dirtyPath, reason: `unrelated dirty root worktree status: ${line}` });
            }
        }
        for (const submodulePath of changedPaths) {
            const fullPath = resolve(targetWorkspacePath, submodulePath);
            if (!existsSync(fullPath))
                continue; // uninitialized submodule; git submodule update --init is safe.
            if (!findGitRepositoryRoot(fullPath)) {
                blockers.push({ path: submodulePath, reason: "submodule path exists but is not a Git repository" });
                continue;
            }
            const dirty = gitStatusPorcelain(fullPath);
            if (dirty)
                blockers.push({ path: submodulePath, reason: `submodule worktree has uncommitted changes; refusing checkout update:\n${dirty}` });
        }
        if (blockers.length > 0) {
            return {
                status: "blocked",
                summary: `submodule checkout sync blocked: ${blockers.map((b) => `${b.path}: ${b.reason}`).join("; ")}`,
                targetWorkspacePath,
                changedPaths,
                updatedPaths: [],
                blockers,
            };
        }
        const updatePaths = topmostPaths(changedPaths);
        try {
            git(targetWorkspacePath, ["submodule", "update", "--init", "--recursive", "--", ...updatePaths]);
        }
        catch (error) {
            const message = gitErrorMessage(error);
            return {
                status: "blocked",
                summary: `submodule checkout sync blocked: git submodule update failed: ${message}`,
                targetWorkspacePath,
                changedPaths,
                updatedPaths: [],
                blockers: updatePaths.map((path) => ({ path, reason: message })),
                error: message,
            };
        }
        const remaining = listChangedSubmoduleCheckoutPaths(targetWorkspacePath, { recursive: request.recursive ?? true });
        if (remaining.length > 0) {
            return {
                status: "blocked",
                summary: `submodule checkout sync incomplete: ${remaining.join(", ")} still differs from recorded gitlinks`,
                targetWorkspacePath,
                changedPaths,
                updatedPaths: updatePaths.filter((item) => !remaining.some((remainingPath) => pathsTouch(item, remainingPath))),
                blockers: remaining.map((path) => ({ path, reason: "still differs from recorded gitlink after update" })),
            };
        }
        return {
            status: "passed",
            summary: `submodule checkout sync passed: updated ${updatePaths.length} submodule checkout(s) to recorded gitlinks`,
            targetWorkspacePath,
            changedPaths,
            updatedPaths: updatePaths,
            blockers: [],
        };
    }
    integrateSubagentBranch(request) {
        const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
        const controllerRepo = findGitRepositoryRoot(controllerWorkspacePath);
        if (!controllerRepo) {
            return nativeGitIntegrationFailure(request, `controller workspace is not inside a Git repository: ${controllerWorkspacePath}`);
        }
        const source = resolveSubagentIntegrationSource(controllerWorkspacePath, request.subagent);
        if (!source.ok)
            return nativeGitIntegrationFailure(request, source.error);
        const sourceBranch = source.branch ?? request.subagent.branch;
        const sourceRef = source.ref ?? request.subagent.ref ?? sourceBranch;
        const sourceHead = source.head;
        const preIntegrationCheckoutSync = this.syncSubmoduleWorktreesToHeadPins({ targetWorkspacePath: controllerWorkspacePath, recursive: true });
        if (preIntegrationCheckoutSync.status === "blocked") {
            return nativeGitIntegrationFailure(request, `controller submodule checkout sync failed before integration: ${preIntegrationCheckoutSync.summary}`, { sourceBranch, sourceRef, sourceHead }, undefined, submoduleCheckoutSyncValidationSignals(preIntegrationCheckoutSync));
        }
        const preIntegrationCheckoutSyncSummary = successfulSubmoduleCheckoutSyncSummary(preIntegrationCheckoutSync);
        const preIntegrationCheckoutSyncSignals = submoduleCheckoutSyncValidationSignals(preIntegrationCheckoutSync);
        const controllerDirty = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
        if (controllerDirty) {
            return nativeGitIntegrationFailure(request, `controller workspace has uncommitted changes; cannot integrate safely:\n${controllerDirty}`, { sourceBranch, sourceRef, sourceHead });
        }
        if (source.workspacePath) {
            const sourceDirty = gitStatusPorcelain(source.workspacePath);
            if (sourceDirty) {
                return nativeGitIntegrationFailure(request, `subagent workspace has uncommitted changes; commit them on the subagent branch before reporting completion:\n${sourceDirty}`, { sourceBranch, sourceRef, sourceHead }, buildCommitBeforeIntegrationPrompt(request, sourceDirty));
            }
        }
        const controllerHead = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
        if (!controllerHead)
            return nativeGitIntegrationFailure(request, "controller workspace has no HEAD", { sourceBranch, sourceRef, sourceHead });
        if (sourceHead === controllerHead) {
            const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
            if (!postMergeValidation.ok) {
                if (postMergeValidation.workspaceMutated)
                    cleanPostMergeValidationArtifacts(controllerWorkspacePath);
                return nativeGitIntegrationFailure(request, postMergeValidation.summary, { sourceBranch, sourceRef, sourceHead }, buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary), postMergeValidation.validationSignals);
            }
            return {
                status: "notRequired",
                summary: appendIntegrationSummary(appendIntegrationSummary(`subagent branch already matches controller HEAD ${shortSha(controllerHead)}`, preIntegrationCheckoutSyncSummary), postMergeValidation.summary),
                sourceBranch,
                sourceRef,
                sourceHead,
                integrationCommitSha: controllerHead,
                validationSignals: [...preIntegrationCheckoutSyncSignals, ...postMergeValidation.validationSignals],
                completedAt: new Date().toISOString(),
            };
        }
        if (gitIsAncestor(controllerWorkspacePath, sourceHead, controllerHead)) {
            const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
            if (!postMergeValidation.ok) {
                if (postMergeValidation.workspaceMutated)
                    cleanPostMergeValidationArtifacts(controllerWorkspacePath);
                return nativeGitIntegrationFailure(request, postMergeValidation.summary, { sourceBranch, sourceRef, sourceHead }, buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary), postMergeValidation.validationSignals);
            }
            return {
                status: "complete",
                summary: appendIntegrationSummary(appendIntegrationSummary(`subagent commit ${shortSha(sourceHead)} is already integrated in controller HEAD ${shortSha(controllerHead)}`, preIntegrationCheckoutSyncSummary), postMergeValidation.summary),
                sourceBranch,
                sourceRef,
                sourceHead,
                integrationCommitSha: controllerHead,
                validationSignals: [...preIntegrationCheckoutSyncSignals, ...postMergeValidation.validationSignals],
                completedAt: new Date().toISOString(),
            };
        }
        let submoduleMergeSummary;
        try {
            git(controllerWorkspacePath, ["merge", "--no-ff", "--no-commit", sourceHead]);
        }
        catch (error) {
            const resolution = resolveSubmoduleIntegrationMergeConflicts({
                controllerWorkspacePath,
                sourceWorkspacePath: source.workspacePath,
                sourceHead,
                goalId: request.subagent.goalId,
            });
            if (!resolution.ok) {
                safeGit(controllerWorkspacePath, ["merge", "--abort"]);
                const message = `git merge failed while integrating subagent ${request.subagent.subagentId}: ${gitErrorMessage(error)}${resolution.error ? `; submodule-aware resolution failed: ${resolution.error}` : ""}`;
                return nativeGitIntegrationFailure(request, message, { sourceBranch, sourceRef, sourceHead }, buildMergeConflictFollowupPrompt(request, message), resolution.validationSignals);
            }
            submoduleMergeSummary = resolution.summary;
        }
        try {
            // Integration-time submodule publish gate: scan staged gitlinks and ensure
            // every changed submodule SHA is durably remote-fetchable before the merge
            // commit enters the controller branch history.
            const publish = this.ensureSubmoduleGitlinksDurablyPublished({
                goalId: request.subagent.goalId,
                parentWorkspacePath: controllerWorkspacePath,
                sourceWorkspacePaths: [
                    source.workspacePath,
                    controllerWorkspacePath,
                ].filter((p) => Boolean(p)),
                baseTreeish: "HEAD",
                targetTreeish: "INDEX",
                phase: "integration",
                policy: resolveNativeGitCloseoutPolicy(AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY, { env: process.env }),
            });
            if (publish.status === "blocked") {
                abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
                return nativeGitIntegrationFailure(request, `submodule publish blocked: ${publish.summary}`, { sourceBranch, sourceRef, sourceHead }, `[SYSTEM FOLLOW-UP: SUBMODULE_PUBLISH_BLOCKED]\n${publish.summary}\n\nPush the referenced submodule SHAs to durable remote refs, or set ${TRUSTED_SUBMODULE_URL_PATTERNS_ENV} before starting a fresh controller process to allow retained-ref publish for trusted submodule URLs. Then retry integration.`, publish.blockers.map((b) => `${b.path}: ${b.reason}`));
            }
            const postMergeCheckoutSync = this.syncSubmoduleWorktreesToHeadPins({
                targetWorkspacePath: controllerWorkspacePath,
                recursive: true,
                allowRootWorktreeChanges: true,
            });
            if (postMergeCheckoutSync.status === "blocked") {
                abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
                return nativeGitIntegrationFailure(request, `submodule checkout sync failed after merge: ${postMergeCheckoutSync.summary}`, { sourceBranch, sourceRef, sourceHead }, undefined, submoduleCheckoutSyncValidationSignals(postMergeCheckoutSync));
            }
            const postMergeCheckoutSyncSummary = successfulSubmoduleCheckoutSyncSummary(postMergeCheckoutSync);
            const postMergeCheckoutSyncSignals = submoduleCheckoutSyncValidationSignals(postMergeCheckoutSync);
            const postMergeValidation = runPostMergeValidationIfNeeded(request, controllerWorkspacePath);
            if (!postMergeValidation.ok) {
                abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
                return nativeGitIntegrationFailure(request, postMergeValidation.summary, { sourceBranch, sourceRef, sourceHead }, buildPostMergeValidationFollowupPrompt(request, postMergeValidation.summary), [...preIntegrationCheckoutSyncSignals, ...postMergeCheckoutSyncSignals, ...postMergeValidation.validationSignals]);
            }
            git(controllerWorkspacePath, ["commit", "--no-edit"]);
            const integrationCommitSha = git(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
            return {
                status: "complete",
                summary: appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(`merged subagent ${request.subagent.subagentId} ${shortSha(sourceHead)} into controller ${shortSha(integrationCommitSha)}`, preIntegrationCheckoutSyncSummary), submoduleMergeSummary), postMergeCheckoutSyncSummary), postMergeValidation.summary),
                sourceBranch,
                sourceRef,
                sourceHead,
                integrationCommitSha,
                validationSignals: [...preIntegrationCheckoutSyncSignals, ...postMergeCheckoutSyncSignals, ...postMergeValidation.validationSignals],
                completedAt: new Date().toISOString(),
            };
        }
        catch (error) {
            abortMergeAndCleanPostMergeValidationArtifacts(controllerWorkspacePath);
            const message = `git integration failed while integrating subagent ${request.subagent.subagentId}: ${gitErrorMessage(error)}`;
            return nativeGitIntegrationFailure(request, message, { sourceBranch, sourceRef, sourceHead }, buildMergeConflictFollowupPrompt(request, message));
        }
    }
    promoteControllerBranch(request) {
        const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
        const controllerRepo = findGitRepositoryRoot(controllerWorkspacePath);
        if (!controllerRepo) {
            return nativeGitPromotionBlocked(request, `controller workspace is not inside a Git repository: ${controllerWorkspacePath}`);
        }
        const controllerBranch = request.controllerBranch ?? (safeGit(controllerWorkspacePath, ["branch", "--show-current"]) || undefined);
        const controllerHead = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
        if (!controllerHead)
            return nativeGitPromotionBlocked(request, "controller workspace has no HEAD", { controllerBranch });
        const controllerDirty = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
        if (controllerDirty) {
            return nativeGitPromotionBlocked(request, `controller workspace has uncommitted changes; cannot promote safely:\n${controllerDirty}`, {
                controllerBranch,
                controllerHead,
            });
        }
        const target = resolveControllerPromotionTarget(controllerWorkspacePath, request.targetRef, controllerBranch, this.options.branchPrefix);
        if (!target.ok)
            return nativeGitPromotionBlocked(request, target.error, { controllerBranch, controllerHead, targetRef: target.targetRef, targetBranch: target.targetBranch });
        const prePromotionCheckoutSync = this.syncSubmoduleWorktreesToHeadPins({ targetWorkspacePath: target.workspacePath, recursive: true });
        if (prePromotionCheckoutSync.status === "blocked") {
            return nativeGitPromotionBlocked(request, `target submodule checkout sync failed before promotion: ${prePromotionCheckoutSync.summary}`, {
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: target.head,
            });
        }
        const prePromotionCheckoutSyncSummary = successfulSubmoduleCheckoutSyncSummary(prePromotionCheckoutSync);
        const targetDirty = gitStatusPorcelain(target.workspacePath, { ignoreWorktreeRoot: true });
        if (targetDirty) {
            return nativeGitPromotionBlocked(request, `target workspace has uncommitted changes; cannot promote safely:\n${targetDirty}`, {
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: target.head,
            });
        }
        const sync = this.syncTargetBranchBeforePromotion({
            remoteName: this.options.remote,
            remoteBranch: target.targetBranch,
            localTargetBranch: target.targetBranch,
            targetWorkspacePath: target.workspacePath,
            targetHead: target.head,
        });
        const idempotentPromotedTarget = sync.status === "blocked"
            && sync.targetHead
            && sync.remoteHead
            && isDirectPromotionMergeCommit(target.workspacePath, sync.targetHead, sync.remoteHead, controllerHead);
        if (sync.status === "blocked" && !idempotentPromotedTarget) {
            return nativeGitPromotionBlocked(request, `target branch sync blocked: ${sync.summary}`, {
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: sync.targetHead ?? target.head,
                targetRemoteHead: sync.remoteHead,
                targetSyncSummary: sync.summary,
            });
        }
        const syncSummary = idempotentPromotedTarget
            ? `target ${target.targetBranch} already contains an unpushed direct promotion merge; parent push will publish it`
            : sync.summary;
        const syncedTargetHead = sync.targetHead ?? (safeGit(target.workspacePath, ["rev-parse", "--verify", "HEAD"]) || target.head);
        const syncedCheckout = this.syncSubmoduleWorktreesToHeadPins({ targetWorkspacePath: target.workspacePath, recursive: true });
        if (syncedCheckout.status === "blocked") {
            return nativeGitPromotionBlocked(request, `target submodule checkout sync failed after target sync: ${syncedCheckout.summary}`, {
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: syncedTargetHead,
                targetRemoteHead: sync.remoteHead,
                targetSyncSummary: syncSummary,
            });
        }
        const targetSyncCheckoutSummary = successfulSubmoduleCheckoutSyncSummary(syncedCheckout);
        if (controllerHead === syncedTargetHead || gitIsAncestor(target.workspacePath, controllerHead, syncedTargetHead)) {
            return {
                status: "notRequired",
                summary: appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(`controller ${shortSha(controllerHead)} is already contained in target ${target.targetBranch}`, prePromotionCheckoutSyncSummary), syncSummary), targetSyncCheckoutSummary),
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: syncedTargetHead,
                targetRemoteHead: sync.remoteHead,
                targetSyncSummary: syncSummary,
                promotionCommitSha: syncedTargetHead,
            };
        }
        let submodulePromotionSummary;
        try {
            try {
                git(target.workspacePath, ["merge", "--no-ff", "--no-commit", controllerHead]);
            }
            catch (error) {
                const resolution = resolveSubmoduleIntegrationMergeConflicts({
                    controllerWorkspacePath: target.workspacePath,
                    sourceWorkspacePath: controllerWorkspacePath,
                    sourceHead: controllerHead,
                    goalId: request.goalId ?? controllerBranch ?? "promotion",
                });
                if (!resolution.ok) {
                    safeGit(target.workspacePath, ["merge", "--abort"]);
                    return nativeGitPromotionBlocked(request, `git merge failed while promoting controller branch: ${gitErrorMessage(error)}${resolution.error ? `; submodule-aware resolution failed: ${resolution.error}` : ""}`, {
                        controllerBranch,
                        controllerHead,
                        targetRef: target.targetRef,
                        targetBranch: target.targetBranch,
                        targetWorkspacePath: target.workspacePath,
                        targetHead: syncedTargetHead,
                        targetRemoteHead: sync.remoteHead,
                        targetSyncSummary: syncSummary,
                    });
                }
                submodulePromotionSummary = resolution.summary;
            }
            const promotionGoalId = sanitizeSlug(request.goalId ?? controllerBranch ?? "promotion") || "promotion";
            const publish = this.ensureSubmoduleGitlinksDurablyPublished({
                goalId: promotionGoalId,
                parentWorkspacePath: target.workspacePath,
                sourceWorkspacePaths: [controllerWorkspacePath, target.workspacePath],
                baseTreeish: syncedTargetHead,
                targetTreeish: "INDEX",
                phase: "closeout",
                policy: resolveNativeGitCloseoutPolicy(AUTO_ALLOCATED_DEFAULT_CLOSEOUT_POLICY, { env: process.env }),
            });
            if (publish.status === "blocked") {
                abortMergeAndCleanPostMergeValidationArtifacts(target.workspacePath);
                return nativeGitPromotionBlocked(request, `promotion submodule publish blocked: ${publish.summary}`, {
                    controllerBranch,
                    controllerHead,
                    targetRef: target.targetRef,
                    targetBranch: target.targetBranch,
                    targetWorkspacePath: target.workspacePath,
                    targetHead: syncedTargetHead,
                    targetRemoteHead: sync.remoteHead,
                    targetSyncSummary: syncSummary,
                });
            }
            const publishSummary = publish.status === "passed" ? publish.summary : undefined;
            const postMergeCheckoutSync = this.syncSubmoduleWorktreesToHeadPins({
                targetWorkspacePath: target.workspacePath,
                recursive: true,
                allowRootWorktreeChanges: true,
            });
            if (postMergeCheckoutSync.status === "blocked") {
                abortMergeAndCleanPostMergeValidationArtifacts(target.workspacePath);
                return nativeGitPromotionBlocked(request, `target submodule checkout sync failed after promotion merge: ${postMergeCheckoutSync.summary}`, {
                    controllerBranch,
                    controllerHead,
                    targetRef: target.targetRef,
                    targetBranch: target.targetBranch,
                    targetWorkspacePath: target.workspacePath,
                    targetHead: syncedTargetHead,
                    targetRemoteHead: sync.remoteHead,
                    targetSyncSummary: syncSummary,
                });
            }
            const postMergeCheckoutSyncSummary = successfulSubmoduleCheckoutSyncSummary(postMergeCheckoutSync);
            git(target.workspacePath, ["commit", "--no-edit"]);
            const promotionCommitSha = git(target.workspacePath, ["rev-parse", "--verify", "HEAD"]);
            return {
                status: "complete",
                summary: appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(appendIntegrationSummary(`merged controller ${controllerBranch ?? shortSha(controllerHead)} ${shortSha(controllerHead)} into target ${target.targetBranch} ${shortSha(promotionCommitSha)}`, prePromotionCheckoutSyncSummary), targetSyncCheckoutSummary), submodulePromotionSummary), publishSummary), postMergeCheckoutSyncSummary),
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: syncedTargetHead,
                targetRemoteHead: sync.remoteHead,
                targetSyncSummary: syncSummary,
                promotionCommitSha,
            };
        }
        catch (error) {
            abortMergeAndCleanPostMergeValidationArtifacts(target.workspacePath);
            return nativeGitPromotionBlocked(request, `git merge failed while promoting controller branch: ${gitErrorMessage(error)}`, {
                controllerBranch,
                controllerHead,
                targetRef: target.targetRef,
                targetBranch: target.targetBranch,
                targetWorkspacePath: target.workspacePath,
                targetHead: syncedTargetHead,
                targetRemoteHead: sync.remoteHead,
                targetSyncSummary: syncSummary,
            });
        }
    }
    // ── Submodule publish and closeout gate methods ──
    ensureSubmoduleGitlinksDurablyPublished(request) {
        const gitlinks = scanChangedSubmoduleGitlinks(request.parentWorkspacePath, request.baseTreeish, request.targetTreeish);
        if (gitlinks.length === 0) {
            return {
                status: "skipped",
                summary: "no changed submodule gitlinks detected",
                phase: request.phase,
                changedGitlinks: [],
                published: [],
                verified: [],
                blockers: [],
            };
        }
        const allGitlinks = [...gitlinks];
        const published = [];
        const verified = [];
        const blockers = [];
        const appendNestedResult = (nested) => {
            allGitlinks.push(...nested.changedGitlinks);
            published.push(...nested.published);
            verified.push(...nested.verified);
            blockers.push(...nested.blockers);
        };
        for (const gitlink of gitlinks) {
            if (gitlink.status === "deleted") {
                continue;
            }
            const newSha = gitlink.newSha;
            if (!newSha) {
                blockers.push({ path: gitlink.path, reason: "changed submodule gitlink has no new SHA" });
                continue;
            }
            // Resolve canonical URL from parent tree .gitmodules
            const url = resolveSubmoduleCanonicalUrl(request.parentWorkspacePath, gitlink.path, request.targetTreeish);
            if (!url) {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `cannot resolve canonical URL for submodule path ${gitlink.path} from .gitmodules` });
                continue;
            }
            gitlink.canonicalUrl = url;
            // Check if SHA is already on a durable remote ref (no trust required for verify)
            const existingRef = findDurableRefContainingSha(url, newSha, request.policy.durableRefPatterns);
            if (existingRef) {
                const fetchOk = verifySubmoduleShaFromIsolatedFetch(url, existingRef, newSha);
                if (fetchOk) {
                    verified.push({ path: gitlink.path, sha: newSha, canonicalUrl: url, durableRef: existingRef, isolatedFetchVerified: true });
                    if (request.policy.verifyNestedSubmodules) {
                        appendNestedResult(verifyNestedSubmoduleGitlinks({
                            goalId: request.goalId,
                            parentPath: gitlink.path,
                            canonicalUrl: url,
                            durableRef: existingRef,
                            sha: newSha,
                            sourceWorkspacePaths: request.sourceWorkspacePaths,
                            policy: request.policy,
                        }));
                    }
                    continue;
                }
            }
            // Locate the commit object (needed for push)
            const objectSource = locateSubmoduleCommitObject(newSha, request.sourceWorkspacePaths, gitlink.path);
            if (!objectSource) {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `cannot locate submodule commit ${shortSha(newSha)} in any source workspace` });
                continue;
            }
            // Policy-mode check: non-publish modes block here without passing trust check
            if (request.policy.submodulePublishMode === "verify-only" || request.policy.submodulePublishMode === "block-if-unpublished") {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `submodule SHA ${shortSha(newSha)} is not on any durable remote ref and publish mode is ${request.policy.submodulePublishMode}` });
                continue;
            }
            // URL trust check (only gates publish-retained-ref path)
            if (!isSubmoduleUrlTrusted(url, gitlink, request.policy, {
                parentWorkspacePath: request.parentWorkspacePath,
                baseTreeish: request.baseTreeish,
            })) {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `submodule URL ${url} is not in trustedSubmoduleUrlPatterns; cannot publish retained ref. Configure ${TRUSTED_SUBMODULE_URL_PATTERNS_ENV} before starting a fresh controller process to trust retained-ref publishing for this URL.` });
                continue;
            }
            // Publish retained ref
            const pathSlug = sanitizeSlug(gitlink.path).slice(0, 32) || "submodule";
            const sha12 = shortSha(newSha);
            const durableRef = `refs/heads/goal-runner/retained/${request.goalId}/${pathSlug}-${sha12}`;
            const pushOk = publishShaToRetainedRef(objectSource, gitlink.path, url, newSha, durableRef);
            if (!pushOk) {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `failed to push retained ref ${durableRef} for ${url}` });
                continue;
            }
            // Prove remote availability via isolated fresh fetch after push
            const fetchOk = verifySubmoduleShaFromIsolatedFetch(url, durableRef, newSha);
            if (!fetchOk) {
                blockers.push({ path: gitlink.path, sha: newSha, reason: `pushed retained ref ${durableRef} but cannot fetch/verify SHA ${shortSha(newSha)} from ${url} via isolated fetch` });
                continue;
            }
            verified.push({ path: gitlink.path, sha: newSha, canonicalUrl: url, durableRef, isolatedFetchVerified: true });
            published.push({
                path: gitlink.path,
                sha: newSha,
                canonicalUrl: url,
                durableRef,
                alreadyContained: false,
                sourceWorkspacePath: objectSource,
            });
            if (request.policy.verifyNestedSubmodules) {
                appendNestedResult(verifyNestedSubmoduleGitlinks({
                    goalId: request.goalId,
                    parentPath: gitlink.path,
                    canonicalUrl: url,
                    durableRef,
                    sha: newSha,
                    sourceWorkspacePaths: request.sourceWorkspacePaths,
                    policy: request.policy,
                }));
            }
        }
        const hasBlockers = blockers.length > 0;
        return {
            status: hasBlockers ? "blocked" : "passed",
            summary: hasBlockers
                ? `submodule publish blocked: ${blockers.map((b) => `${b.path}: ${b.reason}`).join("; ")}`
                : `submodule publish passed: ${allGitlinks.length} gitlink(s) scanned, ${verified.length} verified, ${published.length} published`,
            phase: request.phase,
            changedGitlinks: allGitlinks,
            published,
            verified,
            blockers,
        };
    }
    preflightPromotionTargetBeforeControllerStart(request) {
        const repoRoot = findGitRepositoryRoot(resolve(request.invocationCwd));
        if (!repoRoot) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: invocation workspace is not inside a Git repository: ${resolve(request.invocationCwd)}`,
                error: "not a Git repository",
            };
        }
        let targetRef;
        try {
            targetRef = request.targetRef?.trim() || this.resolveBaseRef(repoRoot, request.baseRef);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: ${message}`,
                error: message,
            };
        }
        const targetBranch = normalizeLocalBranchRef(repoRoot, targetRef);
        if (!targetBranch) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: cannot normalize promotion target ref: ${targetRef}`,
                targetRef,
            };
        }
        const targetWorktree = listGitWorktrees(repoRoot).find((item) => item.branch === targetBranch);
        if (!targetWorktree) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: promotion target branch ${targetBranch} does not have a checked-out worktree; cannot safely promote after controller work`,
                targetRef,
                targetBranch,
            };
        }
        const targetHead = targetWorktree.head ?? safeGit(targetWorktree.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        if (!targetHead) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: target branch ${targetBranch} worktree has no HEAD`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
            };
        }
        const remoteName = this.options.remote;
        const remoteUrl = safeGit(repoRoot, ["remote", "get-url", remoteName]);
        if (!remoteUrl) {
            return {
                status: "skipped",
                summary: `promotion target preflight skipped: remote ${remoteName} is not configured`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                remoteName,
                remoteBranch: targetBranch,
            };
        }
        const fetchRefspec = `refs/heads/${targetBranch}:refs/remotes/${remoteName}/${targetBranch}`;
        try {
            git(repoRoot, ["fetch", remoteName, fetchRefspec]);
        }
        catch (error) {
            const message = gitErrorMessage(error);
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: failed to fetch remote target branch ${remoteName}/${targetBranch}: ${message}`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                remoteName,
                remoteBranch: targetBranch,
                error: message,
            };
        }
        const remoteHead = safeGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/${remoteName}/${targetBranch}`]);
        if (!remoteHead) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: cannot resolve remote target branch ${remoteName}/${targetBranch}`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                remoteName,
                remoteBranch: targetBranch,
            };
        }
        if (targetHead === remoteHead) {
            return {
                status: "passed",
                summary: `promotion target preflight passed: target ${targetBranch} is already at remote ${remoteName}/${targetBranch}`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                targetRemoteHead: remoteHead,
                remoteName,
                remoteBranch: targetBranch,
            };
        }
        if (gitIsAncestor(repoRoot, targetHead, remoteHead)) {
            return {
                status: "passed",
                summary: `promotion target preflight passed: target ${targetBranch} is behind ${remoteName}/${targetBranch}; final promotion will fast-forward before merging`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                targetRemoteHead: remoteHead,
                remoteName,
                remoteBranch: targetBranch,
            };
        }
        if (gitIsAncestor(repoRoot, remoteHead, targetHead)) {
            return {
                status: "blocked",
                summary: `promotion target preflight blocked: local target ${targetBranch} has unpushed commits; push, reset, or choose a synced target before starting a goal`,
                targetRef,
                targetBranch,
                targetWorkspacePath: targetWorktree.worktreePath,
                targetHead,
                targetRemoteHead: remoteHead,
                remoteName,
                remoteBranch: targetBranch,
            };
        }
        return {
            status: "blocked",
            summary: `promotion target preflight blocked: target ${targetBranch} and ${remoteName}/${targetBranch} have diverged; reconcile before starting a goal`,
            targetRef,
            targetBranch,
            targetWorkspacePath: targetWorktree.worktreePath,
            targetHead,
            targetRemoteHead: remoteHead,
            remoteName,
            remoteBranch: targetBranch,
        };
    }
    normalizePromotionTarget(request, policy) {
        const controllerWorkspacePath = resolve(request.controllerWorkspacePath);
        const repoRoot = findGitRepositoryRoot(controllerWorkspacePath);
        if (!repoRoot)
            return { ok: false, reason: `controller workspace is not inside a Git repository: ${controllerWorkspacePath}` };
        const targetRef = request.targetRef ?? policy.targetBranch;
        if (!targetRef)
            return { ok: false, reason: "no promotion target ref configured" };
        const remoteName = policy.parentRemote ?? "origin";
        const remoteUrl = safeGit(repoRoot, ["remote", "get-url", remoteName]);
        if (!remoteUrl)
            return { ok: false, reason: `cannot resolve remote URL for ${remoteName}` };
        const normalized = normalizePromotionTargetRef(controllerWorkspacePath, repoRoot, targetRef, remoteName);
        if (!normalized)
            return { ok: false, reason: `cannot normalize promotion target ref: ${targetRef}` };
        return { ok: true, value: normalized };
    }
    syncTargetBranchBeforePromotion(target) {
        const repoRoot = findGitRepositoryRoot(target.targetWorkspacePath);
        if (!repoRoot) {
            return { status: "blocked", summary: "target workspace is not inside a Git repository", targetHead: target.targetHead };
        }
        const currentTargetHead = safeGit(target.targetWorkspacePath, ["rev-parse", "--verify", "HEAD"]) || target.targetHead;
        const remoteUrl = safeGit(repoRoot, ["remote", "get-url", target.remoteName]);
        if (!remoteUrl) {
            return {
                status: "skipped",
                summary: `remote ${target.remoteName} is not configured; skipped target sync`,
                targetHead: currentTargetHead,
            };
        }
        // Fetch latest remote target branch. This must fail closed: stale remote-tracking
        // refs are not sufficient evidence that the local target is safe to promote.
        const fetchRefspec = `refs/heads/${target.remoteBranch}:refs/remotes/${target.remoteName}/${target.remoteBranch}`;
        try {
            git(repoRoot, ["fetch", target.remoteName, fetchRefspec]);
        }
        catch (error) {
            const message = gitErrorMessage(error);
            return {
                status: "blocked",
                summary: `failed to fetch remote target branch ${target.remoteName}/${target.remoteBranch}: ${message}`,
                targetHead: currentTargetHead,
                error: message,
            };
        }
        const remoteHead = safeGit(repoRoot, ["rev-parse", "--verify", `refs/remotes/${target.remoteName}/${target.remoteBranch}`]);
        if (!remoteHead) {
            return {
                status: "blocked",
                summary: `cannot resolve remote target branch ${target.remoteName}/${target.remoteBranch}`,
                targetHead: currentTargetHead,
            };
        }
        if (currentTargetHead === remoteHead) {
            return {
                status: "synced",
                summary: `target ${target.localTargetBranch} is already at remote ${target.remoteName}/${target.remoteBranch}`,
                targetHead: currentTargetHead,
                remoteHead,
            };
        }
        if (gitIsAncestor(repoRoot, currentTargetHead, remoteHead)) {
            // Local is behind remote; fast-forward before any controller merge is attempted.
            try {
                git(target.targetWorkspacePath, ["merge", "--ff-only", remoteHead]);
                const updatedTargetHead = safeGit(target.targetWorkspacePath, ["rev-parse", "--verify", "HEAD"]) || remoteHead;
                return {
                    status: "synced",
                    summary: `fast-forwarded target ${target.localTargetBranch} to ${target.remoteName}/${target.remoteBranch}`,
                    targetHead: updatedTargetHead,
                    remoteHead,
                };
            }
            catch (error) {
                const message = gitErrorMessage(error);
                return {
                    status: "blocked",
                    summary: `failed to fast-forward local target to remote: ${message}`,
                    targetHead: currentTargetHead,
                    remoteHead,
                    error: message,
                };
            }
        }
        if (gitIsAncestor(repoRoot, remoteHead, currentTargetHead)) {
            return {
                status: "blocked",
                summary: `local target ${target.localTargetBranch} has unpushed commits; cannot promote`,
                targetHead: currentTargetHead,
                remoteHead,
            };
        }
        return {
            status: "blocked",
            summary: `target ${target.localTargetBranch} and ${target.remoteName}/${target.remoteBranch} have diverged`,
            targetHead: currentTargetHead,
            remoteHead,
        };
    }
    pushParentTargetBranch(request) {
        try {
            const head = safeGit(request.targetWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
            if (!head)
                return { status: "blocked", summary: "target workspace has no HEAD", error: "no HEAD" };
            refreshRetainedSubmoduleRefsForPushCheck(request.targetWorkspacePath);
            const refspec = `HEAD:refs/heads/${request.remoteBranch}`;
            git(request.targetWorkspacePath, ["push", "--recurse-submodules=check", request.remoteName, refspec]);
            return {
                status: "passed",
                summary: `pushed ${shortSha(head)} to ${request.remoteName}/${request.remoteBranch}`,
                remoteName: request.remoteName,
                remoteBranch: request.remoteBranch,
                pushedHead: head,
            };
        }
        catch (error) {
            const message = gitErrorMessage(error);
            return {
                status: "blocked",
                summary: `parent push blocked: ${message}`,
                remoteName: request.remoteName,
                remoteBranch: request.remoteBranch,
                error: message,
            };
        }
    }
    verifyRecursiveCheckout(request) {
        const tmpDir = resolve("/tmp", `goal-submodule-checkout-${Date.now()}`);
        const uniqueDir = resolve(tmpDir, String(Date.now()));
        try {
            mkdirSync(uniqueDir, { recursive: true });
            if (request.mode === "pre-push-local-commit") {
                if (!request.targetWorkspacePath || !request.targetCommitSha) {
                    return { status: "blocked", summary: "pre-push mode requires targetWorkspacePath and targetCommitSha", mode: request.mode };
                }
                // Clone parent remote, then fetch local commit
                git(uniqueDir, ["init", "-b", "main"]);
                safeGit(uniqueDir, ["remote", "add", "origin", request.parentRemoteUrl]);
                git(uniqueDir, ["fetch", request.targetWorkspacePath, request.targetCommitSha]);
                git(uniqueDir, ["checkout", "--detach", "FETCH_HEAD"]);
            }
            else {
                // Post-push: clone remote branch (clone into a subdir, not the dir itself)
                if (!request.remoteBranch) {
                    return { status: "blocked", summary: "post-push mode requires remoteBranch", mode: request.mode };
                }
                git(tmpDir, ["clone", "--branch", request.remoteBranch, "--recurse-submodules", request.parentRemoteUrl, uniqueDir]);
            }
            // Try recursive submodule checkout
            git(uniqueDir, ["submodule", "sync", "--recursive"]);
            git(uniqueDir, ["submodule", "update", "--init", "--recursive"]);
            return { status: "passed", summary: `recursive checkout verification passed (${request.mode})`, mode: request.mode };
        }
        catch (error) {
            const message = gitErrorMessage(error);
            return {
                status: "blocked",
                summary: `recursive checkout verification failed (${request.mode}): ${message}`,
                mode: request.mode,
                error: message,
            };
        }
        finally {
            rmRecursiveSafe(uniqueDir);
            rmRecursiveSafe(tmpDir);
        }
    }
    resolveBaseRef(repoRoot, overrideBaseRef) {
        if (overrideBaseRef?.trim())
            return resolveExplicitBaseRef(repoRoot, overrideBaseRef.trim());
        if (this.options.defaultBaseRef?.trim())
            return resolveExplicitBaseRef(repoRoot, this.options.defaultBaseRef.trim());
        const remoteHead = safeGit(repoRoot, ["symbolic-ref", "--quiet", "--short", `refs/remotes/${this.options.remote}/HEAD`]);
        if (remoteHead)
            return remoteHead;
        const currentBranch = safeGit(repoRoot, ["branch", "--show-current"]);
        if (currentBranch)
            return currentBranch;
        const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
        if (head)
            return head;
        throw new Error("cannot resolve goal workspace base ref: repository has no HEAD");
    }
    resolveSubagentBaseRef(repoRoot, request) {
        if (request.baseRef?.trim())
            return resolveExplicitBaseRef(repoRoot, request.baseRef.trim());
        if (request.controllerWorkspacePath?.trim()) {
            const controllerBranch = safeGit(request.controllerWorkspacePath, ["branch", "--show-current"]);
            if (controllerBranch)
                return controllerBranch;
            const controllerHead = safeGit(request.controllerWorkspacePath, ["rev-parse", "--verify", "HEAD"]);
            if (controllerHead)
                return controllerHead;
        }
        return this.resolveBaseRef(repoRoot);
    }
    resolveWorktreeRoot(repoRoot) {
        return resolve(this.options.worktreeRoot ?? resolve(repoRoot, ".worktrees"));
    }
}
function isDirectPromotionMergeCommit(cwd, commit, targetParent, controllerParent) {
    const line = safeGit(cwd, ["rev-list", "--parents", "-n", "1", commit]);
    const [, ...parents] = line.split(/\s+/).filter(Boolean);
    return parents.length === 2 && parents.includes(targetParent) && parents.includes(controllerParent);
}
function refreshRetainedSubmoduleRefsForPushCheck(targetWorkspacePath) {
    const gitlinks = scanChangedSubmoduleGitlinks(targetWorkspacePath, "ALL", "HEAD")
        .filter((gitlink) => gitlink.status !== "deleted" && gitlink.newSha);
    for (const gitlink of gitlinks) {
        const submodulePath = resolve(targetWorkspacePath, gitlink.path);
        if (!existsSync(submodulePath) || !findGitRepositoryRoot(submodulePath))
            continue;
        const canonicalUrl = resolveSubmoduleCanonicalUrl(targetWorkspacePath, gitlink.path, "HEAD")
            ?? resolveSubmoduleCanonicalUrl(targetWorkspacePath, gitlink.path, "WORKTREE");
        if (!canonicalUrl)
            continue;
        safeGit(submodulePath, [
            "fetch",
            "--no-tags",
            canonicalUrl,
            "+refs/heads/goal-runner/retained/*:refs/remotes/goal-runner-retained/*",
        ]);
    }
}
export function createNativeGitSubagentWorkspaceAllocator(manager, options = {}) {
    return (request) => {
        const allocation = manager.allocateSubagentWorkspace({
            invocationCwd: options.invocationCwd,
            repoRoot: options.repoRoot,
            controllerWorkspacePath: options.controllerWorkspacePath,
            baseRef: request.node.workspace?.baseRef ?? options.baseRef,
            worktreeSlug: request.node.workspace?.worktreeSlug,
            branch: request.node.workspace?.branch,
            goalId: request.goalId,
            nodeId: request.node.nodeId,
            nodeSlug: request.node.slug,
            nodeObjective: request.node.objective,
        });
        return {
            subagentId: allocation.subagentId,
            cwd: allocation.worktreePath,
            branch: allocation.branch,
            systemPrompt: options.systemPrompt,
            initialPrompt: options.initialPrompt?.(request, allocation),
            metadata: {
                ...(options.metadata ?? {}),
                nativeGitWorkspace: allocation,
            },
        };
    };
}
export function createNativeGitSubagentBranchIntegrator(manager, options) {
    return (request) => {
        const result = manager.integrateSubagentBranch({
            controllerWorkspacePath: options.controllerWorkspacePath,
            node: request.node,
            subagent: request.subagent,
            strategy: options.strategy,
            postMergeValidation: options.postMergeValidation,
        });
        return {
            status: result.status === "notRequired" ? "notRequired" : result.status,
            summary: result.summary,
            followupPrompt: result.followupPrompt,
            sourceBranch: result.sourceBranch,
            sourceRef: result.sourceRef,
            sourceHead: result.sourceHead,
            integrationCommitSha: result.integrationCommitSha,
            error: result.error,
            validationSignals: result.validationSignals,
            completedAt: result.completedAt,
        };
    };
}
export function cleanupTerminalSubagentWorkspaces(manager, state, policy = {}) {
    return terminalCleanupTargets(state).map((subagent) => cleanupSubagentWorkspace(manager, subagent, policy));
}
function terminalCleanupTargets(state) {
    const nodesById = new Map(state.nodes.map((node) => [node.nodeId, node]));
    const targets = state.subagents.map((subagent) => {
        const resources = nodesById.get(subagent.nodeId)?.preparedResources;
        if (!resources)
            return subagent;
        return {
            ...subagent,
            workspacePath: subagent.workspacePath ?? resources.workspacePath,
            branch: subagent.branch ?? resources.branch,
            ref: subagent.ref ?? resources.ref,
            sessionId: subagent.sessionId ?? resources.sessionId,
            sessionFile: subagent.sessionFile ?? resources.sessionFile,
        };
    });
    const byResource = new Map();
    for (const target of targets) {
        const key = target.workspacePath ? `workspace:${target.workspacePath}:${target.branch ?? ""}` : `subagent:${target.goalId}:${target.subagentId}`;
        const group = byResource.get(key) ?? [];
        group.push(target);
        byResource.set(key, group);
    }
    return [...byResource.values()].map(selectCleanupRepresentative);
}
function selectCleanupRepresentative(group) {
    const completed = group.filter((subagent) => subagent.status === "complete").sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt))[0];
    if (completed)
        return completed;
    return [...group].sort((a, b) => compareIsoDesc(a.updatedAt, b.updatedAt))[0];
}
function compareIsoDesc(left, right) {
    return right.localeCompare(left);
}
export function cleanupSubagentWorkspace(manager, subagent, policy = {}) {
    if (!["complete", "blocked", "failed"].includes(subagent.status)) {
        return cleanupResult(subagent, "skipped", "subagent is not terminal");
    }
    if (!subagent.workspacePath) {
        return cleanupResult(subagent, "skipped", "subagent has no workspacePath");
    }
    const decision = cleanupDecision(subagent, policy);
    if (decision.action === "preserve") {
        return cleanupResult(subagent, "preserved", `policy preserves ${subagent.status} workspaces`, undefined, decision.forceAuthorized, decision.forceReason);
    }
    try {
        const result = manager.cleanupWorkspace({
            worktreePath: subagent.workspacePath,
            branch: subagent.branch,
            force: decision.forceAuthorized,
            integrationSourceHead: subagent.integrationSourceHead,
            verifyReachable: decision.forceAuthorized && policy.verifySourceReachable,
        });
        return cleanupResult(subagent, "removed", undefined, undefined, decision.forceAuthorized, decision.forceReason, result.reachabilityVerified);
    }
    catch (error) {
        return cleanupResult(subagent, "error", undefined, error instanceof Error ? error.message : String(error), decision.forceAuthorized, decision.forceReason);
    }
}
function isExplicitSubagentWorkspace(subagent) {
    // Auto-allocated subagent workspaces have goal/<goal-prefix>/ goal-scoped
    // branches and live under a .worktrees/ directory. Their directory basename is
    // derived from the node slug and does not necessarily start with "goal-".
    const branch = subagent.branch ?? "";
    const ws = subagent.workspacePath ?? "";
    if (!ws || !branch)
        return true; // No workspace = nothing to cleanup
    const goalPrefix = sanitizeSlug(subagent.goalId).slice(0, 12);
    const isAutoBranch = Boolean(goalPrefix) && branch.startsWith(`goal/${goalPrefix}/`);
    const isAutoPath = ws.includes(`${sep}.worktrees${sep}`);
    return !(isAutoBranch && isAutoPath);
}
function cleanupDecision(subagent, policy) {
    // Explicitly-bound workspaces are never auto-cleaned unless policy explicitly allows
    if (!policy.allowExplicitWorkspaceCleanup && isExplicitSubagentWorkspace(subagent)) {
        return {
            action: "preserve",
            forceAuthorized: false,
            forceReason: "explicit workspace cleanup disabled by policy",
        };
    }
    let action;
    if (subagent.status === "complete")
        action = policy.completed ?? "remove";
    else if (subagent.status === "blocked")
        action = policy.blocked ?? "preserve";
    else if (subagent.status === "failed")
        action = policy.failed ?? "preserve";
    else
        action = "preserve";
    if (action !== "remove") {
        return {
            action,
            forceAuthorized: false,
            forceReason: "force deletion disabled because cleanup action is preserved",
        };
    }
    if (!policy.force) {
        return {
            action,
            forceAuthorized: false,
            forceReason: "force deletion disabled by policy",
        };
    }
    if (!requiredSubagentIntegrationTerminalSuccess(subagent)) {
        return {
            action,
            forceAuthorized: false,
            forceReason: `cannot force-delete without terminal integration state (got ${subagent.integrationState ?? "undefined"})`,
        };
    }
    if (policy.promotionStatus !== undefined && policy.promotionStatus !== "complete" && policy.promotionStatus !== "notRequired") {
        return {
            action,
            forceAuthorized: false,
            forceReason: `cannot force-delete unless promotion passed (got ${policy.promotionStatus})`,
        };
    }
    return {
        action,
        forceAuthorized: true,
        forceReason: "force-delete authorized",
    };
}
function cleanupResult(subagent, action, reason, error, forceAuthorized, forceReason, reachabilityVerified) {
    return {
        subagentId: subagent.subagentId,
        nodeId: subagent.nodeId,
        status: subagent.status,
        action,
        reason,
        workspacePath: subagent.workspacePath,
        branch: subagent.branch,
        error,
        forceAuthorized,
        forceReason,
        reachabilityVerified,
    };
}
function resolveSubagentIntegrationSource(controllerWorkspacePath, subagent) {
    const workspacePath = subagent.workspacePath ? resolve(subagent.workspacePath) : undefined;
    if (workspacePath && findGitRepositoryRoot(workspacePath)) {
        const head = safeGit(workspacePath, ["rev-parse", "--verify", "HEAD"]);
        if (!head)
            return { ok: false, error: `subagent workspace has no HEAD: ${workspacePath}` };
        return {
            ok: true,
            workspacePath,
            branch: safeGit(workspacePath, ["branch", "--show-current"]) || subagent.branch,
            ref: subagent.ref,
            head,
        };
    }
    const sourceRef = subagent.branch ?? subagent.ref ?? subagent.commitSha ?? subagent.integrationSourceHead;
    if (!sourceRef)
        return { ok: false, error: "subagent has no workspace, branch, ref, or commit SHA to integrate" };
    const head = safeGit(controllerWorkspacePath, ["rev-parse", "--verify", `${sourceRef}^{commit}`]);
    if (!head)
        return { ok: false, error: `cannot resolve subagent integration ref ${sourceRef}` };
    return { ok: true, branch: subagent.branch, ref: sourceRef, head };
}
function nativeGitIntegrationFailure(request, error, source = {}, followupPrompt, validationSignals) {
    return {
        status: "failed",
        summary: error,
        error,
        followupPrompt,
        validationSignals,
        sourceBranch: source.sourceBranch,
        sourceRef: source.sourceRef,
        sourceHead: source.sourceHead,
    };
}
function resolveSubmoduleIntegrationMergeConflicts(request) {
    const unmerged = parseUnmergedIndexEntries(request.controllerWorkspacePath);
    if (unmerged.errors.length > 0) {
        return { ok: false, error: `non-submodule merge conflict(s): ${unmerged.errors.join(", ")}`, validationSignals: unmerged.errors };
    }
    if (unmerged.submodules.length === 0) {
        return { ok: false, error: "merge did not leave resolvable submodule gitlink conflicts" };
    }
    const resolved = [];
    const signals = [];
    for (const entry of unmerged.submodules) {
        const result = resolveSingleSubmoduleGitlinkConflict({
            controllerWorkspacePath: request.controllerWorkspacePath,
            sourceWorkspacePath: request.sourceWorkspacePath,
            goalId: request.goalId,
            entry,
        });
        if (!result.ok) {
            return { ok: false, error: result.error, validationSignals: [...signals, ...(result.validationSignals ?? [])] };
        }
        resolved.push(result.summary ?? `${entry.path}: resolved`);
        signals.push(result.summary ?? `${entry.path}: resolved`);
    }
    const remaining = parseUnmergedIndexEntries(request.controllerWorkspacePath);
    if (remaining.errors.length > 0 || remaining.submodules.length > 0) {
        const remainingItems = [...remaining.errors, ...remaining.submodules.map((item) => item.path)];
        return { ok: false, error: `unmerged entries remain after submodule resolution: ${remainingItems.join(", ")}`, validationSignals: remainingItems };
    }
    return {
        ok: true,
        summary: `resolved submodule gitlink conflict(s): ${resolved.join("; ")}`,
        validationSignals: signals,
    };
}
function parseUnmergedIndexEntries(cwd) {
    const output = safeGit(cwd, ["ls-files", "-u", "-z"]);
    if (!output)
        return { submodules: [], errors: [] };
    const byPath = new Map();
    const errors = [];
    for (const record of output.split("\0").filter(Boolean)) {
        const match = record.match(/^(\d+)\s+([0-9a-f]{40})\s+(\d)\t(.+)$/i);
        if (!match) {
            errors.push(`unparseable unmerged index entry: ${record}`);
            continue;
        }
        const [, mode, sha, stageText, path] = match;
        const stage = Number(stageText);
        const bucket = byPath.get(path) ?? { modes: new Map(), shas: new Map() };
        bucket.modes.set(stage, mode);
        bucket.shas.set(stage, sha);
        byPath.set(path, bucket);
    }
    const submodules = [];
    for (const [path, item] of byPath.entries()) {
        const modes = [...item.modes.values()];
        if (modes.every((mode) => mode === "160000")) {
            submodules.push({
                path,
                baseSha: item.shas.get(1),
                oursSha: item.shas.get(2),
                theirsSha: item.shas.get(3),
            });
        }
        else {
            errors.push(path);
        }
    }
    return { submodules, errors };
}
function resolveSingleSubmoduleGitlinkConflict(request) {
    const { entry } = request;
    const oursSha = entry.oursSha;
    const theirsSha = entry.theirsSha;
    if (!oursSha || !theirsSha)
        return { ok: false, error: `${entry.path}: missing ours/theirs submodule SHA` };
    if (isZeroSha(oursSha) || isZeroSha(theirsSha))
        return { ok: false, error: `${entry.path}: cannot resolve all-zero submodule SHA conflict` };
    const submoduleCwd = resolve(request.controllerWorkspacePath, entry.path);
    const init = safeGit(request.controllerWorkspacePath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive", "--", entry.path]);
    void init;
    if (!existsSync(submoduleCwd))
        return { ok: false, error: `${entry.path}: submodule worktree is not checked out` };
    const canonicalUrl = resolveSubmoduleCanonicalUrl(request.controllerWorkspacePath, entry.path, "WORKTREE")
        ?? resolveSubmoduleCanonicalUrl(request.controllerWorkspacePath, entry.path, "HEAD");
    const sourceWorkspacePaths = [request.sourceWorkspacePath, request.controllerWorkspacePath].filter((item) => Boolean(item));
    for (const sha of [oursSha, theirsSha]) {
        const available = ensureSubmoduleCommitAvailable(submoduleCwd, entry.path, sha, sourceWorkspacePaths, canonicalUrl);
        if (!available)
            return { ok: false, error: `${entry.path}: submodule commit ${shortSha(sha)} is unavailable locally or from source/remote` };
    }
    let resolvedSha = theirsSha;
    let strategy = "theirs";
    if (oursSha === theirsSha) {
        resolvedSha = oursSha;
        strategy = "same-sha";
    }
    else if (gitIsAncestor(submoduleCwd, oursSha, theirsSha)) {
        resolvedSha = theirsSha;
        strategy = "fast-forward-to-theirs";
    }
    else if (gitIsAncestor(submoduleCwd, theirsSha, oursSha)) {
        resolvedSha = oursSha;
        strategy = "keep-ours-already-contains-theirs";
    }
    else {
        try {
            git(submoduleCwd, ["checkout", "--detach", oursSha]);
            git(submoduleCwd, ["merge", "--no-ff", "--no-commit", theirsSha]);
            git(submoduleCwd, ["commit", "-m", `Merge ${entry.path} submodule changes for goal ${request.goalId.slice(0, 8)}`]);
            resolvedSha = git(submoduleCwd, ["rev-parse", "--verify", "HEAD"]);
            strategy = "submodule-merge-commit";
        }
        catch (error) {
            safeGit(submoduleCwd, ["merge", "--abort"]);
            safeGit(submoduleCwd, ["checkout", "--detach", oursSha]);
            return { ok: false, error: `${entry.path}: submodule merge failed: ${gitErrorMessage(error)}` };
        }
    }
    git(request.controllerWorkspacePath, ["update-index", "--cacheinfo", `160000,${resolvedSha},${entry.path}`]);
    return { ok: true, summary: `${entry.path}: ${strategy} ${shortSha(oursSha)} + ${shortSha(theirsSha)} -> ${shortSha(resolvedSha)}` };
}
function ensureSubmoduleCommitAvailable(submoduleCwd, submodulePath, sha, sourceWorkspacePaths, canonicalUrl) {
    if (gitCommitObjectExists(submoduleCwd, sha))
        return true;
    for (const sourceWorkspacePath of sourceWorkspacePaths) {
        const objectSource = locateSubmoduleCommitObject(sha, [sourceWorkspacePath], submodulePath);
        if (!objectSource)
            continue;
        const sourceRepo = objectSource.includes(`${sep}.git${sep}modules${sep}`) ? objectSource : resolve(objectSource, submodulePath);
        if (!existsSync(sourceRepo))
            continue;
        try {
            git(submoduleCwd, ["fetch", "--no-tags", sourceRepo, sha]);
        }
        catch {
            // try next source
        }
        if (gitCommitObjectExists(submoduleCwd, sha))
            return true;
    }
    if (canonicalUrl) {
        for (const args of [
            ["fetch", "--no-tags", canonicalUrl, sha],
            ["fetch", "--no-tags", canonicalUrl],
        ]) {
            try {
                git(submoduleCwd, args);
            }
            catch {
                // try next fetch shape
            }
            if (gitCommitObjectExists(submoduleCwd, sha))
                return true;
        }
    }
    return false;
}
function gitCommitObjectExists(cwd, sha) {
    try {
        execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function isZeroSha(value) {
    return /^0{40}$/.test(value);
}
function runPostMergeValidationIfNeeded(request, controllerWorkspacePath) {
    const required = nodeRequiresPostMergeValidation(request.node);
    if (!required)
        return { ok: true, summary: "", validationSignals: [] };
    if (request.postMergeValidation === false) {
        return {
            ok: false,
            summary: "post-merge validation required but disabled by host policy",
            validationSignals: ["post-merge validation required but disabled by host policy"],
        };
    }
    const validators = request.node?.validators ?? [];
    if (validators.length === 0) {
        return {
            ok: false,
            summary: "post-merge validation required but no node validators are configured",
            validationSignals: ["post-merge validation required but no node validators are configured"],
        };
    }
    const submodulePreparation = preparePostMergeValidationSubmodules(controllerWorkspacePath);
    if (!submodulePreparation.ok)
        return submodulePreparation;
    const beforeStatus = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
    const beforeIndexTree = safeGit(controllerWorkspacePath, ["write-tree"]);
    const results = validators.map((command) => runPostMergeValidatorCommand(command, controllerWorkspacePath));
    const afterStatus = gitStatusPorcelain(controllerWorkspacePath, { ignoreWorktreeRoot: true });
    const afterIndexTree = safeGit(controllerWorkspacePath, ["write-tree"]);
    const statusChanged = afterStatus !== beforeStatus;
    const indexChanged = Boolean(beforeIndexTree && afterIndexTree && beforeIndexTree !== afterIndexTree);
    const workspaceMutated = statusChanged || indexChanged;
    const validationSignals = [
        ...submodulePreparation.validationSignals,
        ...results.map((result) => result.ok
            ? `post-merge validator passed: ${result.command}`
            : `post-merge validator failed: ${result.command}${result.output ? `\n${result.output}` : ""}`),
    ];
    const failed = results.filter((result) => !result.ok);
    const summaryPrefix = submodulePreparation.summary ? `${submodulePreparation.summary}; ` : "";
    if (workspaceMutated) {
        validationSignals.push(`post-merge validator mutated controller workspace: ${statusDeltaSummary(beforeStatus, afterStatus, indexChanged)}`);
        return {
            ok: false,
            summary: `${summaryPrefix}post-merge validation mutated controller workspace${failed.length ? ` and failed ${failed.length}/${results.length} validator(s)` : ""}: ${statusDeltaSummary(beforeStatus, afterStatus, indexChanged)}`,
            validationSignals,
            workspaceMutated: true,
        };
    }
    if (failed.length === 0) {
        return { ok: true, summary: `${summaryPrefix}post-merge validation passed (${results.length} validator(s))`, validationSignals };
    }
    return {
        ok: false,
        summary: `${summaryPrefix}post-merge validation failed (${failed.length}/${results.length} validator(s)): ${failed.map((result) => result.command).join(", ")}`,
        validationSignals,
    };
}
function preparePostMergeValidationSubmodules(cwd) {
    const beforeSubmoduleStatus = safeGit(cwd, ["submodule", "status", "--recursive"]);
    const beforeStatus = gitStatusPorcelain(cwd, { ignoreWorktreeRoot: true });
    const beforeIndexTree = safeGit(cwd, ["write-tree"]);
    try {
        git(cwd, ["submodule", "sync", "--recursive"]);
        git(cwd, ["submodule", "update", "--init", "--recursive"]);
    }
    catch (error) {
        const afterStatus = gitStatusPorcelain(cwd, { ignoreWorktreeRoot: true });
        const afterIndexTree = safeGit(cwd, ["write-tree"]);
        const indexChanged = Boolean(beforeIndexTree && afterIndexTree && beforeIndexTree !== afterIndexTree);
        const workspaceMutated = afterStatus !== beforeStatus || indexChanged;
        const summary = `post-merge submodule initialization failed: ${gitErrorMessage(error)}`;
        return {
            ok: false,
            summary,
            validationSignals: [summary],
            ...(workspaceMutated ? { workspaceMutated: true } : {}),
        };
    }
    const afterSubmoduleStatus = safeGit(cwd, ["submodule", "status", "--recursive"]);
    if (!beforeSubmoduleStatus.trim() && !afterSubmoduleStatus.trim()) {
        return { ok: true, summary: "", validationSignals: [] };
    }
    const remaining = listChangedSubmoduleCheckoutPaths(cwd, { recursive: true });
    if (remaining.length > 0) {
        const summary = `post-merge submodule initialization incomplete: ${remaining.join(", ")} still differs from recorded gitlinks`;
        return { ok: false, summary, validationSignals: [summary] };
    }
    const initialized = submodulePathsWithPrefix(beforeSubmoduleStatus, "-");
    const mismatched = submodulePathsWithPrefix(beforeSubmoduleStatus, "+");
    const details = [
        initialized.length ? `initialized ${initialized.join(", ")}` : undefined,
        mismatched.length ? `updated ${mismatched.join(", ")}` : undefined,
    ].filter((part) => Boolean(part)).join("; ");
    const summary = details
        ? `post-merge submodule initialization passed: ${details}`
        : "post-merge submodule initialization passed";
    return { ok: true, summary, validationSignals: [summary] };
}
function submodulePathsWithPrefix(statusOutput, prefix) {
    const paths = [];
    for (const line of statusOutput.split(/\r?\n/)) {
        if (!line.trim() || line[0] !== prefix)
            continue;
        const match = line.slice(1).trim().match(/^[0-9a-fA-F]+\s+(\S+)/);
        const submodulePath = match?.[1];
        if (submodulePath && !paths.includes(submodulePath))
            paths.push(submodulePath);
    }
    return paths.sort();
}
function nodeRequiresPostMergeValidation(node) {
    if (!node)
        return false;
    const gates = node.completionGates.map(normalizeCompletionGateName);
    return gates.includes("post-merge-validation") ||
        gates.includes("post-merge-validation-ran") ||
        Boolean(node.validation?.requiredEvidence?.includes("post-merge-validation-ran"));
}
function normalizeCompletionGateName(value) {
    return value.trim().toLowerCase().replace(/_/g, "-");
}
function runPostMergeValidatorCommand(command, cwd) {
    try {
        const output = execFileSync("sh", ["-lc", command], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return { command, ok: true, output: truncateForIntegration(output) };
    }
    catch (error) {
        const record = error;
        const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
        return { command, ok: false, output: truncateForIntegration(output), error: record.message ?? String(error) };
    }
}
function statusDeltaSummary(beforeStatus, afterStatus, indexChanged) {
    const parts = [
        indexChanged ? "index tree changed" : undefined,
        beforeStatus ? `before validators:\n${truncateForIntegration(beforeStatus, 1000)}` : "before validators: <clean>",
        afterStatus ? `after validators:\n${truncateForIntegration(afterStatus, 1000)}` : "after validators: <clean>",
    ];
    return parts.filter((part) => Boolean(part)).join("; ");
}
function abortMergeAndCleanPostMergeValidationArtifacts(cwd) {
    safeGit(cwd, ["merge", "--abort"]);
    cleanPostMergeValidationArtifacts(cwd);
}
function cleanPostMergeValidationArtifacts(cwd) {
    safeGit(cwd, ["reset", "--hard", "HEAD"]);
    safeGit(cwd, ["clean", "-fd", "-e", ".worktrees/"]);
}
function buildPostMergeValidationFollowupPrompt(request, failureSummary) {
    return [
        `[SYSTEM FOLLOW-UP: POST_MERGE_VALIDATION]`,
        `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}" and the subagent branch merged cleanly in a temporary controller workspace state, but post-merge validation failed before the controller committed the merge.`,
        failureSummary,
        `Fix the issue on your assigned branch (${request.subagent.branch ?? "current branch"}), rerun the relevant validators, commit the result, and report again with SUBAGENT_RESULT: <summary including verification>.`,
    ].join("\n");
}
function appendIntegrationSummary(left, right) {
    return right ? `${left}; ${right}` : left;
}
function truncateForIntegration(value, maxChars = 4000) {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}
function resolveControllerPromotionTarget(controllerWorkspacePath, requestedTargetRef, controllerBranch, branchPrefix) {
    const worktrees = listGitWorktrees(controllerWorkspacePath);
    const controllerResolvedPath = resolve(controllerWorkspacePath);
    const targetCandidates = promotionTargetBranchCandidates(controllerWorkspacePath, requestedTargetRef, worktrees, controllerBranch, branchPrefix);
    if (targetCandidates.length === 0) {
        return { ok: false, error: "cannot resolve promotion target branch for controller workspace" };
    }
    for (const targetBranch of targetCandidates) {
        if (targetBranch === controllerBranch)
            continue;
        const target = worktrees.find((item) => item.branch === targetBranch && resolve(item.worktreePath) !== controllerResolvedPath);
        if (!target)
            continue;
        const head = target.head ?? safeGit(target.worktreePath, ["rev-parse", "--verify", "HEAD"]);
        if (!head)
            return { ok: false, error: `target branch ${targetBranch} worktree has no HEAD`, targetRef: requestedTargetRef, targetBranch };
        return { ok: true, targetRef: requestedTargetRef ?? targetBranch, targetBranch, workspacePath: target.worktreePath, head };
    }
    const firstCandidate = targetCandidates[0];
    return {
        ok: false,
        error: `promotion target branch ${firstCandidate} does not have a checked-out worktree; cannot merge fail-closed`,
        targetRef: requestedTargetRef,
        targetBranch: firstCandidate,
    };
}
function promotionTargetBranchCandidates(cwd, requestedTargetRef, worktrees, controllerBranch, branchPrefix) {
    const candidates = [];
    const add = (value) => {
        const branch = normalizeLocalBranchRef(cwd, value);
        if (branch && branch !== controllerBranch && !candidates.includes(branch))
            candidates.push(branch);
    };
    add(requestedTargetRef);
    if (!requestedTargetRef) {
        for (const worktree of worktrees) {
            if (!worktree.branch || worktree.branch === controllerBranch)
                continue;
            if (worktree.branch.startsWith(`${branchPrefix}/`))
                continue;
            add(worktree.branch);
        }
    }
    return candidates;
}
function normalizeLocalBranchRef(cwd, value) {
    const ref = value?.trim();
    if (!ref)
        return undefined;
    if (ref.startsWith("refs/heads/"))
        return ref.slice("refs/heads/".length);
    if (gitRefExists(cwd, ref))
        return ref;
    if (ref.startsWith("refs/remotes/")) {
        const parts = ref.split("/");
        const local = parts.slice(3).join("/");
        return local && gitRefExists(cwd, local) ? local : undefined;
    }
    const slash = ref.indexOf("/");
    if (slash > 0) {
        const local = ref.slice(slash + 1);
        return local && gitRefExists(cwd, local) ? local : undefined;
    }
    return undefined;
}
function listGitWorktrees(cwd) {
    const output = safeGit(cwd, ["worktree", "list", "--porcelain"]);
    const worktrees = [];
    let current;
    const push = () => {
        if (current?.worktreePath)
            worktrees.push(current);
        current = undefined;
    };
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim()) {
            push();
            continue;
        }
        if (line.startsWith("worktree ")) {
            push();
            current = { worktreePath: line.slice("worktree ".length) };
            continue;
        }
        if (!current)
            continue;
        if (line.startsWith("HEAD "))
            current.head = line.slice("HEAD ".length);
        if (line.startsWith("branch ")) {
            const ref = line.slice("branch ".length);
            current.branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
        }
    }
    push();
    return worktrees;
}
function nativeGitPromotionBlocked(request, error, context = {}) {
    return {
        status: "blocked",
        summary: error,
        error,
        controllerBranch: context.controllerBranch ?? request.controllerBranch,
        controllerHead: context.controllerHead,
        targetRef: context.targetRef ?? request.targetRef,
        targetBranch: context.targetBranch,
        targetWorkspacePath: context.targetWorkspacePath,
        targetHead: context.targetHead,
        targetRemoteHead: context.targetRemoteHead,
        targetSyncSummary: context.targetSyncSummary,
        promotionCommitSha: context.promotionCommitSha,
    };
}
function nativeGitSubmoduleCheckoutSyncBlocked(request, reason) {
    return {
        status: "blocked",
        summary: `submodule checkout sync blocked: ${reason}`,
        targetWorkspacePath: resolve(request.targetWorkspacePath),
        changedPaths: [],
        updatedPaths: [],
        blockers: [{ path: request.targetWorkspacePath, reason }],
        error: reason,
    };
}
function successfulSubmoduleCheckoutSyncSummary(result) {
    return result.status === "passed" ? result.summary : undefined;
}
function submoduleCheckoutSyncValidationSignals(result) {
    if (result.status === "skipped")
        return [];
    return [
        result.summary,
        ...result.blockers.map((blocker) => `${blocker.path}: ${blocker.reason}`),
    ];
}
function initializeNewNativeGitWorktreeSubmodules(repoRoot, worktreePath, branch, preserveBranch) {
    try {
        initializeNativeGitWorktreeSubmodules(worktreePath);
    }
    catch (error) {
        safeGit(repoRoot, ["worktree", "remove", "--force", worktreePath]);
        if (!preserveBranch)
            safeGit(repoRoot, ["branch", "-D", branch]);
        rmRecursiveSafe(worktreePath);
        throw new Error(`cannot initialize submodules for native Git worktree ${worktreePath}: ${gitErrorMessage(error)}`);
    }
}
function initializeNativeGitWorktreeSubmodules(worktreePath) {
    if (!existsSync(resolve(worktreePath, ".gitmodules")))
        return;
    git(worktreePath, ["submodule", "sync", "--recursive"]);
    git(worktreePath, ["submodule", "update", "--init", "--recursive"]);
}
function gitStatusPorcelain(cwd, options = {}) {
    const output = safeGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
    if (!options.ignoreWorktreeRoot)
        return output;
    return output
        .split(/\r?\n/)
        .filter((line) => line.trim() && !statusPath(line).startsWith(".worktrees/"))
        .join("\n");
}
function statusPath(line) {
    const rawLine = line.trimEnd();
    const raw = rawLine.length > 3 && rawLine[2] === " "
        ? rawLine.slice(3).trim()
        : rawLine.length > 2 && rawLine[1] === " "
            ? rawLine.slice(2).trim()
            : rawLine.trim();
    const renamed = raw.includes(" -> ") ? raw.split(" -> ").at(-1) ?? raw : raw;
    return renamed.replace(/^"|"$/g, "");
}
function listChangedSubmoduleCheckoutPaths(cwd, options) {
    const args = ["submodule", "status", ...(options.recursive ? ["--recursive"] : [])];
    const output = safeGit(cwd, args);
    if (!output.trim())
        return [];
    const paths = [];
    for (const line of output.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        const prefix = line[0];
        if (prefix !== "+" && prefix !== "-")
            continue;
        const match = line.slice(1).trim().match(/^[0-9a-fA-F]+\s+(\S+)/);
        const submodulePath = match?.[1];
        if (submodulePath && !paths.includes(submodulePath))
            paths.push(submodulePath);
    }
    return paths.sort();
}
function pathTouchesAny(candidate, paths) {
    return paths.some((item) => pathsTouch(candidate, item));
}
function pathsTouch(left, right) {
    const normalizedLeft = normalizeGitPath(left);
    const normalizedRight = normalizeGitPath(right);
    return normalizedLeft === normalizedRight
        || normalizedLeft.startsWith(`${normalizedRight}/`)
        || normalizedRight.startsWith(`${normalizedLeft}/`);
}
function topmostPaths(paths) {
    const sorted = [...paths].sort((left, right) => normalizeGitPath(left).localeCompare(normalizeGitPath(right)));
    const topmost = [];
    for (const item of sorted) {
        if (topmost.some((parent) => pathsTouch(parent, item) && normalizeGitPath(item).startsWith(`${normalizeGitPath(parent)}/`)))
            continue;
        topmost.push(item);
    }
    return topmost;
}
function normalizeGitPath(value) {
    return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/g, "");
}
function gitIsAncestor(cwd, ancestor, descendant) {
    try {
        execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, stdio: "ignore" });
        return true;
    }
    catch {
        return false;
    }
}
function branchContainsCommit(cwd, commit) {
    try {
        return git(cwd, ["branch", "--contains", commit]).trim().length > 0;
    }
    catch {
        return false;
    }
}
function buildCommitBeforeIntegrationPrompt(request, dirtyStatus) {
    return [
        `[SYSTEM FOLLOW-UP: SUBAGENT_BRANCH_INTEGRATION]`,
        `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}", but your subagent worktree cannot be integrated yet because it has uncommitted changes.`,
        `Commit or otherwise persist all intended repository changes on your assigned branch (${request.subagent.branch ?? "current branch"}).`,
        `Current dirty git status:\n${dirtyStatus}`,
        `After committing, report again with SUBAGENT_RESULT: <summary including commit SHA and verification>.`,
    ].join("\n");
}
function buildMergeConflictFollowupPrompt(request, mergeError) {
    return [
        `[SYSTEM FOLLOW-UP: SUBAGENT_BRANCH_INTEGRATION]`,
        `Controller validation passed for node "${request.node?.nodeId ?? request.subagent.nodeId}", but merging your branch into the controller workspace failed.`,
        mergeError,
        `Rebase or merge the latest controller branch into your assigned branch (${request.subagent.branch ?? "current branch"}), resolve conflicts there, rerun relevant validation, commit the result, and report again with SUBAGENT_RESULT: <summary>.`,
    ].join("\n");
}
function gitErrorMessage(error) {
    const record = error;
    const output = `${toText(record.stdout)}${toText(record.stderr)}`.trim();
    return output || record.message || String(error);
}
function toText(value) {
    if (value === undefined)
        return "";
    return typeof value === "string" ? value : value.toString("utf8");
}
function shortSha(value) {
    return value.slice(0, 12);
}
export function findGitRepositoryRoot(startPath) {
    const output = safeGit(resolve(startPath), ["rev-parse", "--show-toplevel"]);
    return output || undefined;
}
function findGitCommonRepositoryRoot(startPath) {
    const resolvedStart = resolve(startPath);
    const commonDir = safeGit(resolvedStart, ["rev-parse", "--git-common-dir"]);
    if (!commonDir)
        return undefined;
    const absoluteCommonDir = isAbsolute(commonDir) ? commonDir : resolve(resolvedStart, commonDir);
    return basename(absoluteCommonDir) === ".git" ? dirname(absoluteCommonDir) : dirname(absoluteCommonDir);
}
function assertSafeWorktreeSlug(value) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value)) {
        throw new Error(`bound subagent worktreeSlug must be a safe single path segment: ${value}`);
    }
    return value;
}
function assertSafeBranchName(repoRoot, branch) {
    if (!branch || branch.startsWith("-"))
        throw new Error(`bound subagent branch is not safe: ${branch}`);
    git(repoRoot, ["check-ref-format", "--branch", branch]);
}
export function slugForGoal(goalId, objective) {
    const shortId = sanitizeSlug(goalId).slice(0, 8) || "goal";
    const objectiveSlug = sanitizeSlug(objective).slice(0, 48);
    return objectiveSlug ? `${shortId}-${objectiveSlug}` : shortId;
}
export function slugForGoalSubagent(goalId, nodeSlugOrId, nodeObjective) {
    const shortId = sanitizeSlug(goalId).slice(0, 8) || "goal";
    const nodeSlug = sanitizeSlug(nodeSlugOrId).slice(0, 48);
    if (nodeSlug)
        return `${shortId}-${nodeSlug}`;
    const objectiveSlug = nodeObjective ? sanitizeSlug(nodeObjective).slice(0, 48) : "";
    return objectiveSlug ? `${shortId}-${objectiveSlug}` : shortId;
}
function sanitizeSlug(value) {
    const normalized = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .replace(/-{2,}/g, "-");
    return normalized || sanitizeFallback(value);
}
function sanitizeFallback(value) {
    const fallback = Buffer.from(value).toString("hex").slice(0, 16);
    return fallback || basename(process.cwd()) || "goal";
}
function gitRefExists(repoRoot, ref) {
    return safeGit(repoRoot, ["show-ref", "--verify", `refs/heads/${ref}`]).length > 0;
}
function resolveExplicitBaseRef(repoRoot, ref) {
    if (safeGit(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]))
        return ref;
    throw new Error(`cannot resolve goal workspace base ref: ${ref} is not a commit-ish ref in ${repoRoot}. Fetch or create the branch/ref, or choose an existing base ref.`);
}
function git(cwd, args) {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function safeGit(cwd, args) {
    try {
        return git(cwd, args);
    }
    catch {
        return "";
    }
}
// ── Submodule publish and closeout helper functions ──
function scanChangedSubmoduleGitlinks(parentWorkspacePath, baseTreeish = "HEAD", targetTreeish) {
    // When targetTreeish is "INDEX" (integration phase: scan staged vs HEAD):
    //   git diff --raw --abbrev=40 --cached -z HEAD
    // When baseTreeish is "ALL" (scan all gitlinks in target tree):
    //   git ls-tree -r -z targetTreeish (for closeout full-tree verification)
    // When both are commits (closeout phase: scan between two commits):
    //   git diff --raw --abbrev=40 -z baseTreeish targetTreeish
    // -z output produces NUL-terminated records:
    //   :<meta>\0<path>\0         (regular diff)
    //   :<meta>\0<oldPath>\0<newPath>\0  (rename diff)
    const useCached = !targetTreeish || targetTreeish === "INDEX";
    const scanAll = baseTreeish === "ALL";
    const args = scanAll
        ? ["ls-tree", "-r", "-z", targetTreeish]
        : useCached
            ? ["diff", "--raw", "--abbrev=40", "--cached", "-z", baseTreeish]
            : ["diff", "--raw", "--abbrev=40", "-z", baseTreeish, targetTreeish];
    let output;
    try {
        output = git(parentWorkspacePath, args);
    }
    catch {
        return [];
    }
    if (!output)
        return [];
    const gitlinks = [];
    if (scanAll) {
        // Parse ls-tree -r -z output: <mode> <type> <sha>\t<path>\0
        const entries = output.split("\0").filter((e) => e.trim());
        for (const entry of entries) {
            const tabIdx = entry.indexOf("\t");
            if (tabIdx === -1)
                continue;
            const meta = entry.slice(0, tabIdx);
            const p = entry.slice(tabIdx + 1);
            const metaParts = meta.split(/\s+/);
            const mode = metaParts[0];
            if (mode !== "160000")
                continue;
            const newSha = metaParts[2];
            if (newSha) {
                gitlinks.push({ path: p, status: "added", newSha });
            }
        }
        return gitlinks;
    }
    // Parse diff --raw -z output
    const tokens = output.split("\0");
    let i = 0;
    while (i < tokens.length) {
        const meta = tokens[i];
        if (!meta || !meta.startsWith(":")) {
            i++;
            continue;
        }
        const parts = meta.slice(1).split(/\s+/);
        // parts: [oldMode, newMode, oldSha, newSha, status]
        const oldMode = parts[0];
        const newMode = parts[1];
        const oldShaRaw = parts[2];
        const newShaRaw = parts[3];
        const status = parts[4];
        if (!status) {
            i++;
            continue;
        }
        // Only mode 160000 entries are submodule gitlinks
        if (oldMode !== "160000" && newMode !== "160000") {
            i += status.length > 1 ? 3 : 2; // skip rename (3 tokens) or regular (2)
            continue;
        }
        const oldSha = oldShaRaw !== "0000000000000000000000000000000000000000" ? oldShaRaw : undefined;
        const newSha = newShaRaw !== "0000000000000000000000000000000000000000" ? newShaRaw : undefined;
        let mappedStatus;
        let path;
        let oldPath;
        if (status.length > 1) {
            // Rename: R<score>, followed by oldPath then newPath
            mappedStatus = "renamed";
            oldPath = tokens[i + 1] || undefined;
            path = tokens[i + 2] || (tokens[i + 1] ?? "");
            i += 3;
        }
        else {
            const statusCode = status;
            const p = tokens[i + 1] || "";
            if (statusCode === "A") {
                mappedStatus = "added";
                path = p;
            }
            else if (statusCode === "D") {
                mappedStatus = "deleted";
                path = p;
            }
            else {
                mappedStatus = "modified";
                path = p;
            }
            i += 2;
        }
        if (path) {
            gitlinks.push({ path, status: mappedStatus, oldPath, oldSha, newSha });
        }
    }
    return gitlinks;
}
function resolveSubmoduleCanonicalUrl(parentWorkspacePath, submodulePath, treeish = "HEAD") {
    const config = readGitmodulesAtTreeish(parentWorkspacePath, treeish);
    if (!config)
        return undefined;
    const parentRemoteUrl = safeGit(parentWorkspacePath, ["remote", "get-url", "origin"]) || undefined;
    return resolveSubmoduleUrlFromGitmodulesContent(config, submodulePath, parentRemoteUrl);
}
function readGitmodulesAtTreeish(parentWorkspacePath, treeish) {
    if (!treeish || treeish === "WORKTREE") {
        try {
            return readFileSync(join(parentWorkspacePath, ".gitmodules"), "utf8");
        }
        catch {
            return undefined;
        }
    }
    if (treeish === "INDEX") {
        return safeGit(parentWorkspacePath, ["show", ":.gitmodules"]) || undefined;
    }
    return safeGit(parentWorkspacePath, ["show", `${treeish}:.gitmodules`]) || undefined;
}
function resolveSubmoduleUrlFromGitmodulesContent(config, submodulePath, parentBaseUrl) {
    // Parse .gitmodules INI to find the section whose `path` matches submodulePath,
    // then return that section's `url`. Section names may differ from paths.
    let currentPath;
    let currentUrl;
    let inSubmoduleSection = false;
    const flush = () => {
        if (inSubmoduleSection && currentPath === submodulePath && currentUrl) {
            return normalizeSubmoduleUrlAgainstBase(currentUrl, parentBaseUrl);
        }
        return undefined;
    };
    for (const raw of config.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith(";") || line.startsWith("#"))
            continue;
        const sectionMatch = line.match(/^\[submodule\s+"([^"]+)"\]$/);
        if (sectionMatch) {
            const resolved = flush();
            if (resolved)
                return resolved;
            inSubmoduleSection = true;
            currentPath = undefined;
            currentUrl = undefined;
            continue;
        }
        if (!inSubmoduleSection)
            continue;
        const eq = line.indexOf("=");
        if (eq === -1)
            continue;
        const key = line.slice(0, eq).trim();
        const value = line.slice(eq + 1).trim();
        if (key === "path")
            currentPath = value;
        if (key === "url")
            currentUrl = value;
    }
    return flush();
}
function normalizeSubmoduleUrl(url, parentWorkspacePath) {
    const parentRemoteUrl = safeGit(parentWorkspacePath, ["remote", "get-url", "origin"]) || undefined;
    return normalizeSubmoduleUrlAgainstBase(url, parentRemoteUrl);
}
function normalizeSubmoduleUrlAgainstBase(url, parentBaseUrl) {
    const trimmed = url.trim();
    if (trimmed.startsWith("./") || trimmed.startsWith("../")) {
        if (!parentBaseUrl)
            return undefined;
        // Pass the full parent URL (not stripped) to resolveRelativeUrl.
        // For "../sub.git", the first ".." removes the repo name component,
        // giving the correct sibling-repo-in-same-directory result.
        return resolveRelativeUrl(parentBaseUrl, trimmed);
    }
    return trimmed;
}
function resolveRelativeUrl(base, relative) {
    if (relative.startsWith("../")) {
        const baseParts = base.replace(/\/$/, "").split("/");
        const relParts = relative.split("/");
        for (const part of relParts) {
            if (part === "..")
                baseParts.pop();
            else if (part !== ".")
                baseParts.push(part);
        }
        return baseParts.join("/");
    }
    if (relative.startsWith("./")) {
        // Remove last path component (the repo filename) for ./ resolution
        const cleanBase = base.replace(/\/[^/]+$/, "");
        const suffix = relative.slice(2);
        return `${cleanBase}/${suffix}`;
    }
    return relative;
}
function isSubmoduleUrlTrusted(url, gitlink, policy, context) {
    // Explicit allowlist patterns always allow retained-ref publishing for matching URLs.
    if (policy.trustedSubmoduleUrlPatterns.some((pattern) => submoduleUrlMatchesPattern(url, pattern))) {
        return true;
    }
    // Safe convenience path: for an existing submodule gitlink update, trust the URL
    // already recorded in the versioned parent tree. This unblocks normal meta-repo
    // submodule pointer updates without requiring operators to configure every
    // existing submodule URL, while still failing closed for newly added submodules
    // or .gitmodules URL changes.
    if (context && gitlink.status === "modified" && context.baseTreeish && context.baseTreeish !== "ALL") {
        const versionedUrl = resolveSubmoduleCanonicalUrl(context.parentWorkspacePath, gitlink.oldPath ?? gitlink.path, context.baseTreeish);
        if (versionedUrl && versionedUrl === url)
            return true;
    }
    return false;
}
function submoduleUrlMatchesPattern(url, pattern) {
    if (pattern.endsWith("*")) {
        return url.startsWith(pattern.slice(0, -1));
    }
    return url === pattern;
}
function locateSubmoduleCommitObject(sha, sourceWorkspacePaths, submodulePath) {
    for (const workspacePath of sourceWorkspacePaths) {
        if (!workspacePath)
            continue;
        const submoduleWorktree = resolve(workspacePath, submodulePath);
        const exists = safeGit(submoduleWorktree, ["rev-parse", "--verify", `${sha}^{commit}`]);
        if (exists)
            return workspacePath;
        for (const modulesPath of submoduleGitDirCandidates(findGitRepositoryRoot(workspacePath) ?? workspacePath, submodulePath)) {
            const modulesExists = safeGit(modulesPath, ["rev-parse", "--verify", `${sha}^{commit}`]);
            if (modulesExists)
                return modulesPath;
        }
    }
    return undefined;
}
function submoduleGitDirCandidates(repoRoot, submodulePath) {
    const candidates = [];
    const add = (candidate) => {
        if (!candidates.includes(candidate))
            candidates.push(candidate);
    };
    add(resolve(repoRoot, ".git", "modules", submodulePath));
    const parts = submodulePath.split(/[\\/]+/).filter(Boolean);
    for (let split = 1; split < parts.length; split += 1) {
        const prefix = parts.slice(0, split).join("/");
        const rest = parts.slice(split).join("/");
        add(resolve(repoRoot, ".git", "modules", prefix, "modules", rest));
    }
    return candidates;
}
function findDurableRefContainingSha(canonicalUrl, sha, durableRefPatterns) {
    // Collect all remote refs matching durable patterns via ls-remote.
    // For each candidate ref, fetch into a temp bare repo and check if
    // the SHA is reachable. Return the first ref that actually contains
    // the SHA (not just the first candidate).
    for (const pattern of durableRefPatterns) {
        let refsOutput;
        try {
            refsOutput = git("/tmp", ["ls-remote", "--refs", canonicalUrl, pattern]);
        }
        catch {
            continue;
        }
        if (!refsOutput)
            continue;
        const candidateRefs = [];
        for (const line of refsOutput.split("\n")) {
            const parts = line.split(/\s+/);
            const ref = parts[1];
            if (ref && !candidateRefs.includes(ref))
                candidateRefs.push(ref);
        }
        for (const candidateRef of candidateRefs) {
            const tmpDir = resolve("/tmp", `goal-durable-check-${uniqueTempSuffix()}`);
            try {
                mkdirSync(tmpDir, { recursive: true });
                git(tmpDir, ["init", "--bare"]);
                git(tmpDir, ["fetch", "--no-tags", canonicalUrl, candidateRef]);
                git(tmpDir, ["cat-file", "-e", `${sha}^{commit}`]);
                return candidateRef; // SHA reachable from this durable ref
            }
            catch {
                // This candidate ref does not contain the SHA — try next
            }
            finally {
                rmRecursiveSafe(tmpDir);
            }
        }
    }
    return undefined;
}
function publishShaToRetainedRef(sourceWorkspacePath, submodulePath, canonicalUrl, sha, durableRef) {
    try {
        // Push the specific SHA to the retained ref via canonicalUrl only.
        // Do NOT mutate the submodule workspace's origin remote.
        //
        // The object source may be a regular submodule worktree
        // (resolve(sourceWorkspace, submodulePath)) or a bare git repo
        // at .git/modules/<submodulePath> (use directly).
        let pushRepo;
        if (sourceWorkspacePath.includes(`${sep}.git${sep}modules${sep}`)) {
            pushRepo = sourceWorkspacePath;
        }
        else {
            pushRepo = resolve(sourceWorkspacePath, submodulePath);
            if (!existsSync(pushRepo))
                return false;
        }
        // Create-only: refuse to update an existing retained ref with a different SHA.
        try {
            const existing = git("/tmp", ["ls-remote", "--refs", canonicalUrl, durableRef]);
            if (existing) {
                const [existingSha] = existing.split(/\s+/);
                if (existingSha && existingSha === sha)
                    return true; // Already published, same SHA
                return false; // Exists with different SHA — create-only
            }
        }
        catch {
            // Create-only requires proving the retained ref does not already exist.
            // If ls-remote is unavailable, fail closed rather than risking an update.
            return false;
        }
        execFileSync("git", ["push", "--no-verify", canonicalUrl, `${sha}:${durableRef}`], {
            cwd: pushRepo,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
        });
        return true;
    }
    catch {
        return false;
    }
}
function verifySubmoduleShaFromIsolatedFetch(canonicalUrl, durableRef, sha) {
    const tmpDir = resolve("/tmp", `goal-submodule-fetch-${uniqueTempSuffix()}`);
    try {
        mkdirSync(tmpDir, { recursive: true });
        git(tmpDir, ["init", "--bare"]);
        git(tmpDir, ["remote", "add", "origin", canonicalUrl]);
        git(tmpDir, ["fetch", "--no-tags", "origin", durableRef]);
        // cat-file -e exits 0 with empty output on success; git() returns "".
        // If the object doesn't exist, cat-file -e throws.
        git(tmpDir, ["cat-file", "-e", `${sha}^{commit}`]);
        return true;
    }
    catch {
        return false;
    }
    finally {
        rmRecursiveSafe(tmpDir);
    }
}
function emptyNestedSubmoduleVerificationResult() {
    return { changedGitlinks: [], published: [], verified: [], blockers: [] };
}
function verifyNestedSubmoduleGitlinks(request) {
    if (!request.policy.verifyNestedSubmodules)
        return emptyNestedSubmoduleVerificationResult();
    const depth = request.depth ?? 0;
    if (depth >= 8) {
        return {
            changedGitlinks: [],
            published: [],
            verified: [],
            blockers: [{ path: request.parentPath, sha: request.sha, reason: "nested submodule verification exceeded maximum depth" }],
        };
    }
    const visited = request.visited ?? new Set();
    const visitKey = `${request.canonicalUrl}#${request.sha}`;
    if (visited.has(visitKey))
        return emptyNestedSubmoduleVerificationResult();
    visited.add(visitKey);
    const tmpDir = resolve("/tmp", `goal-nested-submodule-${uniqueTempSuffix()}`);
    const result = emptyNestedSubmoduleVerificationResult();
    try {
        mkdirSync(tmpDir, { recursive: true });
        git(tmpDir, ["init", "--bare"]);
        git(tmpDir, ["fetch", "--no-tags", request.canonicalUrl, request.durableRef]);
        git(tmpDir, ["cat-file", "-e", `${request.sha}^{commit}`]);
        const nestedGitlinks = scanSubmoduleGitlinksInTree(tmpDir, request.sha);
        if (nestedGitlinks.length === 0)
            return result;
        const gitmodules = safeGit(tmpDir, ["show", `${request.sha}:.gitmodules`]);
        for (const nested of nestedGitlinks) {
            const nestedSha = nested.newSha;
            const fullPath = `${request.parentPath}/${nested.path}`;
            const fullGitlink = { ...nested, path: fullPath };
            result.changedGitlinks.push(fullGitlink);
            if (!nestedSha) {
                result.blockers.push({ path: fullPath, reason: "nested submodule gitlink has no SHA" });
                continue;
            }
            if (!gitmodules) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `cannot resolve canonical URL for nested submodule path ${nested.path} from .gitmodules` });
                continue;
            }
            const nestedUrl = resolveSubmoduleUrlFromGitmodulesContent(gitmodules, nested.path, request.canonicalUrl);
            if (!nestedUrl) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `cannot resolve canonical URL for nested submodule path ${nested.path} from .gitmodules` });
                continue;
            }
            fullGitlink.canonicalUrl = nestedUrl;
            const existingRef = findDurableRefContainingSha(nestedUrl, nestedSha, request.policy.durableRefPatterns);
            if (existingRef && verifySubmoduleShaFromIsolatedFetch(nestedUrl, existingRef, nestedSha)) {
                result.verified.push({ path: fullPath, sha: nestedSha, canonicalUrl: nestedUrl, durableRef: existingRef, isolatedFetchVerified: true });
                appendNestedVerification(result, verifyNestedSubmoduleGitlinks({
                    ...request,
                    parentPath: fullPath,
                    canonicalUrl: nestedUrl,
                    durableRef: existingRef,
                    sha: nestedSha,
                    depth: depth + 1,
                    visited,
                }));
                continue;
            }
            const objectSource = locateSubmoduleCommitObject(nestedSha, request.sourceWorkspacePaths, fullPath);
            if (!objectSource) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `cannot locate nested submodule commit ${shortSha(nestedSha)} in any source workspace` });
                continue;
            }
            if (request.policy.submodulePublishMode === "verify-only" || request.policy.submodulePublishMode === "block-if-unpublished") {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `nested submodule SHA ${shortSha(nestedSha)} is not on any durable remote ref and publish mode is ${request.policy.submodulePublishMode}` });
                continue;
            }
            if (!isSubmoduleUrlTrusted(nestedUrl, fullGitlink, request.policy)) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `nested submodule URL ${nestedUrl} is not in trustedSubmoduleUrlPatterns; cannot publish retained ref. Configure ${TRUSTED_SUBMODULE_URL_PATTERNS_ENV} before starting a fresh controller process to trust retained-ref publishing for this URL.` });
                continue;
            }
            const pathSlug = sanitizeSlug(fullPath).slice(0, 32) || "submodule";
            const durableRef = `refs/heads/goal-runner/retained/${request.goalId}/${pathSlug}-${shortSha(nestedSha)}`;
            const pushOk = publishShaToRetainedRef(objectSource, fullPath, nestedUrl, nestedSha, durableRef);
            if (!pushOk) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `failed to push retained ref ${durableRef} for ${nestedUrl}` });
                continue;
            }
            if (!verifySubmoduleShaFromIsolatedFetch(nestedUrl, durableRef, nestedSha)) {
                result.blockers.push({ path: fullPath, sha: nestedSha, reason: `pushed retained ref ${durableRef} but cannot fetch/verify SHA ${shortSha(nestedSha)} from ${nestedUrl} via isolated fetch` });
                continue;
            }
            result.verified.push({ path: fullPath, sha: nestedSha, canonicalUrl: nestedUrl, durableRef, isolatedFetchVerified: true });
            result.published.push({
                path: fullPath,
                sha: nestedSha,
                canonicalUrl: nestedUrl,
                durableRef,
                alreadyContained: false,
                sourceWorkspacePath: objectSource,
            });
            appendNestedVerification(result, verifyNestedSubmoduleGitlinks({
                ...request,
                parentPath: fullPath,
                canonicalUrl: nestedUrl,
                durableRef,
                sha: nestedSha,
                depth: depth + 1,
                visited,
            }));
        }
    }
    catch (error) {
        result.blockers.push({ path: request.parentPath, sha: request.sha, reason: `failed to inspect nested submodules: ${gitErrorMessage(error)}` });
    }
    finally {
        rmRecursiveSafe(tmpDir);
    }
    return result;
}
function appendNestedVerification(target, nested) {
    target.changedGitlinks.push(...nested.changedGitlinks);
    target.published.push(...nested.published);
    target.verified.push(...nested.verified);
    target.blockers.push(...nested.blockers);
}
function scanSubmoduleGitlinksInTree(repoPath, treeish) {
    const output = safeGit(repoPath, ["ls-tree", "-r", "-z", treeish]);
    if (!output)
        return [];
    const gitlinks = [];
    for (const entry of output.split("\0")) {
        if (!entry.trim())
            continue;
        const tabIdx = entry.indexOf("\t");
        if (tabIdx === -1)
            continue;
        const meta = entry.slice(0, tabIdx);
        const p = entry.slice(tabIdx + 1);
        const parts = meta.split(/\s+/);
        if (parts[0] !== "160000")
            continue;
        const newSha = parts[2];
        if (newSha)
            gitlinks.push({ path: p, status: "added", newSha });
    }
    return gitlinks;
}
function uniqueTempSuffix() {
    return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
function normalizePromotionTargetRef(controllerWorkspacePath, repoRoot, targetRef, remoteName) {
    const ref = targetRef.trim();
    // Normalize canonical remote refs: refs/remotes/<remote>/<branch> → treat as remoteRef
    if (ref.startsWith("refs/remotes/")) {
        const afterRemotes = ref.slice("refs/remotes/".length);
        const remotePrefix = `${remoteName}/`;
        if (afterRemotes.startsWith(remotePrefix)) {
            const remoteBranch = afterRemotes.slice(remotePrefix.length);
            const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
            if (!head)
                return undefined;
            const worktrees = listGitWorktrees(repoRoot);
            const target = worktrees.find((w) => w.branch === remoteBranch);
            return {
                remoteName,
                remoteBranch,
                localTargetBranch: remoteBranch,
                targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
                targetHead: target?.head ?? head,
            };
        }
        return undefined;
    }
    // Normalize canonical local refs: refs/heads/<branch>
    if (ref.startsWith("refs/heads/")) {
        const localBranch = ref.slice("refs/heads/".length);
        const head = safeGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${localBranch}`]);
        if (!head)
            return undefined;
        const worktrees = listGitWorktrees(repoRoot);
        const target = worktrees.find((w) => w.branch === localBranch);
        return {
            remoteName,
            remoteBranch: localBranch,
            localTargetBranch: localBranch,
            targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
            targetHead: target?.head ?? head,
        };
    }
    // Check if this is a known branch or remote ref BEFORE trying commit-ish.
    // (rev-parse <name>^{commit} succeeds for both branch names and commit SHAs,
    // so we must distinguish: use show-ref to check if it's a branch first.)
    const isRemoteRef = ref.startsWith(`${remoteName}/`);
    const isKnownLocalBranch = gitRefExists(repoRoot, ref);
    // Is it a bare commit SHA or tag (not a known branch/remote ref)?
    if (!isRemoteRef && !isKnownLocalBranch) {
        try {
            const type = git(repoRoot, ["cat-file", "-t", ref]);
            if (type === "commit" || type === "tag")
                return undefined; // Detached commit/tag
        }
        catch {
            // Not a valid ref at all
        }
        return undefined;
    }
    if (isRemoteRef) {
        const remoteBranch = ref.slice(remoteName.length + 1);
        const head = safeGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
        if (!head)
            return undefined;
        // Find local worktree for this branch
        const worktrees = listGitWorktrees(repoRoot);
        const target = worktrees.find((w) => w.branch === remoteBranch);
        return {
            remoteName,
            remoteBranch,
            localTargetBranch: remoteBranch,
            targetWorkspacePath: target?.worktreePath ?? controllerWorkspacePath,
            targetHead: target?.head ?? head,
        };
    }
    // Local branch name
    const localBranch = ref.replace(/^refs\/heads\//, "");
    const remoteBranch = localBranch;
    const head = safeGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${localBranch}`]);
    if (!head)
        return undefined;
    const worktrees = listGitWorktrees(repoRoot);
    const target = worktrees.find((w) => w.branch === localBranch);
    const targetWs = target?.worktreePath ?? controllerWorkspacePath;
    const targetHead = target?.head ?? head;
    return {
        remoteName,
        remoteBranch,
        localTargetBranch: localBranch,
        targetWorkspacePath: targetWs,
        targetHead,
    };
}
function rmRecursiveSafe(path) {
    try {
        execFileSync("rm", ["-rf", path], { stdio: "ignore" });
    }
    catch {
        // Best effort
    }
}
//# sourceMappingURL=git-workspace.js.map