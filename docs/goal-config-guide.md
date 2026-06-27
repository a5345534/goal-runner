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
| `trustedSubmoduleUrlPatterns` | `trusted-submodule-url-patterns` | `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS` | — | string | Trusted submodule URL patterns for retained-ref publishing. |
| `controllerAuditModel` | `controller-audit-model` | `AGENT_GOAL_CONTROLLER_AUDIT_MODEL`, `AGENT_GOAL_PI_CONTROLLER_AUDIT_MODEL`, `PI_GOAL_CONTROLLER_AUDIT_MODEL` | — | string (secret) | Optional controller-audit model id. |

## Precedence

1. Environment variable (highest)
2. Config file value (persisted via `/goal config set`)
3. Built-in default (lowest)

Some keys with `restartRequired: true` require a Pi reload/start or a fresh
controller process to take effect for env-affected code paths.

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
        { "model": "gemini/gemini-2.5-pro", "retryPolicy": { "maxRetries": 1 } },
        { "model": "deepseek/deepseek-v4-flash", "retryPolicy": { "maxRetries": 2 } },
        { "model": "openai-codex/gpt-5.3-codex-spark" }
      ],
      "declaredCapabilities": {
        "reasoning": "high",
        "contextWindowTokens": 1000000,
        "toolUse": "required",
        "structuredOutput": "preferred"
      }
    }
  }
}
```

When the first candidate (`gemini/gemini-2.5-pro`) fails with a switchable error
(e.g., context-exceeded), the resolution logic falls through to the next
candidate.  If all candidates are exhausted, the node is blocked with the
`exhaustedChain` flag.

The monitor UI shows this fallback history:

- **Execution Plan model column** — a compact suffix like `[fb:2]` (2 attempts),
  `[fb:2,s1]` (2 attempts, 1 switch), or `[fb:!]` (chain exhausted) is appended
  to the active model name.
- **Runner live pane** — detail lines under a `── Resolution ──` header list the
  full candidate chain (`✓candidate → ✕failed`) and any switch events with
  reasons.

## Related

- [Binding and resolution contracts](../README.md)
- [Pipeline boundaries](./pipeline-boundaries.md)
- [Adapter contract](./adapter-contract.md)
