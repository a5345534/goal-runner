# /goal config — Runtime Configuration Guide

The `/goal config` command (also available as the `goal_config` Pi tool) reads and
writes runtime configuration for the goal-runner controller and adapters.  Settings
are persisted in a JSON file under `AGENT_GOAL_STATE_HOME` (by default
`~/.local/state/pi/goal/config.json`) and can be overridden by environment variables.

## Usage

```
/goal config                    →  list all config keys with current values
/goal config <key>              →  show one config key
/goal config <key> <value>      →  set a config key
/goal config <key> clear        →  clear a config key (revert to env/default)
```

## Tool form (goal_config)

```json
{
  "action": "show" | "get" | "set" | "clear",
  "key": "<config-key>",
  "value": "<value>"
}
```

- **show** — list all keys
- **get** — inspect one key
- **set** — write a value (validated against the key's kind)
- **clear** — remove the persisted value; env or default applies

## Config keys

| Key | Label | Env | Default | Kind | Description |
|-----|-------|-----|---------|------|-------------|
| `maxSubagents` | `max-subagents` | `AGENT_GOAL_PI_MAX_SUBAGENTS` | `1` | positive-int | Maximum concurrent Pi subagents per controller tick. |
| `maxAutoRetries` | `max-auto-retries` | `AGENT_GOAL_PI_MAX_AUTO_RETRIES` | `2` | nonnegative-int | Maximum auto-retries per runner failure family. |
| `controllerPollMs` | `controller-poll-ms` | `AGENT_GOAL_PI_CONTROLLER_POLL_MS` | `5000` | poll-ms | Controller polling interval. `0` or `off` disables polling. |
| `controllerLeaseMs` | `controller-lease-ms` | `AGENT_GOAL_PI_CONTROLLER_LEASE_MS` | `max(120000, poll*30)` | positive-int | Controller poll lease duration. |
| `debugTrace` | `debug-trace` | `GOAL_RUNNER_DEBUG_TRACE`, `AGENT_GOAL_DEBUG_TRACE` | `off` | boolean | Enable JSONL debug trace. |
| `debugTraceDir` | `debug-trace-dir` | `GOAL_RUNNER_DEBUG_TRACE_DIR`, `AGENT_GOAL_DEBUG_TRACE_DIR` | — | string | Directory for debug trace files. |
| `debugTraceFile` | `debug-trace-file` | `GOAL_RUNNER_DEBUG_TRACE_FILE`, `AGENT_GOAL_DEBUG_TRACE_FILE` | — | string | Exact debug trace file path. |
| `allowedWorkspaceRoots` | `allowed-workspace-roots` | `AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` | — | string | Allowed execution workspace roots (`:` separated on POSIX, `;` on Windows). |
| `completionAudit` | `completion-audit` | `AGENT_GOAL_COMPLETION_AUDIT`, `PI_GOAL_COMPLETION_AUDIT` | `heuristic` | audit-mode | Completion audit mode: `heuristic`, `on`, or `off`. |
| `modelRoutingFile` | `model-routing-file` | `AGENT_GOAL_MODEL_ROUTING_FILE` | — | string | Path to model routing config JSON. |
| `modelRoutingJson` | `model-routing-json` | `AGENT_GOAL_MODEL_ROUTING_JSON` | — | json | Inline model routing JSON. |
| `modelClassCatalogFile` | `model-class-catalog-file` | `AGENT_GOAL_MODEL_CLASS_CATALOG_FILE` | — | string | Path to model-class catalog override. |
| `modelClassCatalogJson` | `model-class-catalog-json` | `AGENT_GOAL_MODEL_CLASS_CATALOG_JSON` | — | json | Inline model-class catalog JSON. |
| `modelBindingFile` | `model-binding-file` | `AGENT_GOAL_MODEL_BINDING_FILE` | — | string | Path to harness binding catalog override. |
| `modelBindingJson` | `model-binding-json` | `AGENT_GOAL_MODEL_BINDING_JSON` | — | json | Inline binding catalog JSON. |
| `trustedSubmoduleUrlPatterns` | `trusted-submodule-url-patterns` | `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS` | — | string | Trusted submodule URL patterns for retained-ref publishing. JSON array or comma/newline-separated patterns. |
| `trustedSubmoduleTargetBranchUrlPatterns` | `trusted-submodule-target-branch-url-patterns` | `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS` | — | string | Trusted submodule URL patterns for target-branch publication (separate from retained-ref trust). JSON array or comma/newline-separated patterns. |
| `submoduleTargetEnforcementScope` | `submodule-target-enforcement-scope` | _(env not supported; configure per policy)_ | `final-tree` | string | Enforcement scope for submodule target-branch closeout: `final-tree` (only submodules in the promoted tree), `all-submodules` (every registered submodule), or `none` (skip target-branch enforcement). |
| `controllerAuditModel` | `controller-audit-model` | `AGENT_GOAL_CONTROLLER_AUDIT_MODEL`, `AGENT_GOAL_PI_CONTROLLER_AUDIT_MODEL`, `PI_GOAL_CONTROLLER_AUDIT_MODEL` | — | string (secret) | Optional controller-audit model id. |

## Precedence

1. Environment variable (highest)
2. Config file value (persisted via `/goal config set`)
3. Built-in default (lowest)

Some keys with `restartRequired: true` require a Pi reload/start or a fresh
controller process to take effect for env-affected code paths.

## Target-branch closeout configuration

The target-branch closeout policy controls whether and how the controller
promotes submodule gitlinks to their project target branches during goal
finalization. This is a **separate concern** from retained-ref publishing
(which preserves SHAs under `refs/heads/goal-runner/retained/*`). Trusting a
URL for retained-ref publishing does **not** authorize target-branch mutation.

### When target-branch enforcement runs

Target-branch enforcement runs during the final closeout phase after all DAG
nodes are terminal, integration passes, and local promotion to the parent target
branch succeeds. The controller scans the promoted tree for submodule gitlinks,
resolves each submodule's target branch, and publishes the gitlink SHA with
fast-forward-only semantics.

### Configuration via environment

| Variable | Purpose |
|----------|---------|
| `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_TARGET_BRANCH_URL_PATTERNS` | URL patterns trusted for target-branch pushes. JSON array or newline/comma-delimited. Requires exact match unless the pattern ends with `*` (prefix match). |

Set this variable before starting the controller process; a running Pi/controller
must be restarted to pick up environment changes.

### Enforcement scopes

| Scope | Description |
|-------|-------------|
| `final-tree` (default) | Only submodules reachable in the final promoted tree are enforced. Deleted submodules are not published. Added/modified gitlinks must publish to target branches. |
| `all-submodules` | Every registered submodule is enforced regardless of whether it changed. Stricter — can expose pre-existing unpushed gitlinks. |
| `none` | No target-branch enforcement. Only retained-ref publication is performed based on the closeout policy's `submodulePublishMode`. |

### Target branch resolution order

1. Explicit `branchMappings` (longest path match wins; supports `*` glob)
2. `.gitmodules` `branch` key (from the versioned treeish)
3. Remote default branch (`git ls-remote --symref HEAD`)
4. Parent target branch fallback

If none resolves, the submodule is blocked with a "cannot resolve target branch"
diagnostic.

### Publication constraints

- **Fast-forward only**: The push is rejected if the SHA is not a descendant of
the current branch tip.
- **Pre-existing branch required**: The target branch must exist on the remote.
- **Post-push verification**: When `verifyRemoteReachability` is true (default),
the controller fetches the pushed branch and confirms the SHA is reachable.
- **Protected branches**: If the remote branch is protected (rejects non-ff
pushes or enforce status checks), the push is blocked with a `protected branch`
diagnostic.

## Candidate-chain example

The following binding catalog entry uses a **candidate chain** (v2 format) to
define a fallback list of models for the `implementation` model class:

```json
{
  "version": 2,
  "harness": "pi",
  "bindings": {
    "implementation": {
      "candidates": [
        {
          "model": "gemini/gemini-2.5-pro",
          "declaredCapabilities": {
            "reasoning": "high",
            "contextWindowTokens": 1000000,
            "toolUse": "required",
            "structuredOutput": "preferred",
            "formatFollowing": "high",
            "sourceCitation": "preferred",
            "privacy": "cloud-ok"
          }
        },
        {
          "model": "deepseek/deepseek-v4-flash",
          "declaredCapabilities": {
            "reasoning": "high",
            "contextWindowTokens": 1000000,
            "toolUse": "required",
            "structuredOutput": "preferred",
            "formatFollowing": "high",
            "sourceCitation": "preferred",
            "privacy": "cloud-ok"
          }
        },
        {
          "model": "openai-codex/gpt-5.3-codex-spark",
          "declaredCapabilities": {
            "reasoning": "medium",
            "contextWindowTokens": 128000,
            "toolUse": "required",
            "structuredOutput": "preferred",
            "formatFollowing": "high",
            "sourceCitation": "preferred",
            "privacy": "cloud-ok"
          }
        }
      ],
      "retryPolicy": { "attemptsPerCandidate": 2 }
    }
  }
}
```

When the active candidate (`gemini/gemini-2.5-pro`) fails with a switchable
runtime error (for example, context-exceeded), the controller retries it up to
`attemptsPerCandidate` and then starts a replacement attempt with the next
eligible candidate. If all candidates are exhausted, the node is blocked with
the `exhaustedChain` flag.

The monitor UI shows this fallback history:

- **Execution Plan model column** — a compact suffix like `[fb:s1]` (1 runtime
  switch), `[fb:!]` (chain exhausted), or `[fb:2,s1]` for legacy/diagnostic
  evidence that includes multiple actual resolution attempts plus one switch.
- **Runner live pane** — detail lines under a `── Resolution ──` header list the
  full candidate plan and any switch events with reasons.

## Related

- [Binding and resolution contracts](../README.md)
- [Pipeline boundaries](./pipeline-boundaries.md)
- [Adapter contract](./adapter-contract.md)
