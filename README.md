# goal-runner

Portable Codex-compatible `/goal` runtime with Pi and OpenCode bridges.

This project provides the common framework first:

- shared `/goal` command parser
- one-current-goal-per-session state model
- Codex-compatible goal statuses (`active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`)
- SQLite default store with a pluggable store interface
- lifecycle hooks for turn/tool/accounting events
- hidden continuation reservation + idempotent callback contract
- no-progress continuation suppression so pure chat/status turns do not spin forever
- model-visible `get_goal`, `create_goal`, and restricted `update_goal` behavior
- optional completion audit gate behind `update_goal({"status":"complete"})`, without adding `goal_complete`
- durable execution ledger for lifecycle, continuation, audit, completion, and blocked evidence
- durable task DAG and subagent registry data models for future controller orchestration
- prompt rendering that treats goal objectives as untrusted user-provided task data
- Pi extension adapter with transcript-aware blocked audit, slash-command token budgets, active-goal reminders, heuristic completion audit, post-stop tool guarding, abort/error pausing, and stale-continuation guards

Other agent harness bridges are intentionally out of scope for this first implementation and should be added through separate changes.

## Pipeline Role

`goal-runner` is Stage 3 of the goal execution pipeline:

```text
Goal DAG JSON → runtime execution
```

It consumes explicit DAG files through `/goal --dag <path>`. It does not generate DAG files and does not infer multi-node plans from prose, OpenSpec, PRDs, or markdown task lists. See [`docs/pipeline-boundaries.md`](docs/pipeline-boundaries.md) for the producer/consumer boundary.

The current orchestration-state slices record DAG nodes and subagent registry
records through the portable store/runtime APIs, provide a default native Git
workspace manager that can allocate dedicated controller and subagent
worktrees/branches, expose deterministic objective-to-DAG planning and scheduling
helpers, define a harness-neutral subagent adapter contract, provide a Pi
implementation backed by detached background Pi RPC sessions, and include a
portable controller orchestration loop wired to Pi `/goal <objective>` starts,
including polling supervision and controller-owned validation.

## Build and test

```bash
npm install
npm run check
```

## CLI smoke

```bash
npm run build
node dist/cli.js --state-root /tmp/agent-goal-smoke "finish the migration"
node dist/cli.js --state-root /tmp/agent-goal-smoke
node dist/cli.js --state-root /tmp/agent-goal-smoke pause
node dist/cli.js --state-root /tmp/agent-goal-smoke debug
node dist/cli.js --state-root /tmp/agent-goal-smoke clear
```

The CLI is only a debug/smoke surface. Full Codex-compatible auto-continuation requires a harness adapter.

## Harness-neutral subagent adapter contract

The portable core exports a `HarnessSubagentAdapter` contract for agent harnesses
such as Pi, Codex, Claude Code, OpenCode, or a shell/JSON-RPC bridge. The
contract covers:

- starting or attaching a subagent session for a DAG node using controller-prepared resources,
- sending follow-up prompts,
- polling session state,
- reporting normalized adapter observations such as `selfReportedComplete`, `selfReportedBlocked`, `protocolViolation`, `runnerError`, and `runnerLost`,
- optionally streaming harness events,
- aborting a session.

Helpers such as `startGoalSubagent()`, `sendGoalSubagentPrompt()`, and
`syncGoalSubagentState()` translate harness-level session handles, observations,
and status into durable `GoalSubagentRecord` updates. `GoalRuntime` wraps these
helpers so a controller can persist subagent starts, prepared resource bindings,
observations, and state syncs without depending on any specific harness
implementation.

The Pi adapter exports `PiHarnessSubagentAdapter`, which launches detached Pi RPC
sessions for DAG nodes, resumes existing session files for follow-up prompts, and
infers subagent state from Pi JSONL transcripts. Subagents are instructed to use
`SUBAGENT_RESULT:` / `SUBAGENT_BLOCKED:` markers; those markers are controller
inputs only, not completion gates.

## Controller orchestration loop

`runGoalControllerTick()` and `runGoalControllerLoop()` provide the first portable
controller runtime:

- synchronize active subagents through the configured harness adapter,
- persist detailed controller-owned lifecycle/resource/observation/recovery fields while preserving coarse node statuses for compatibility,
- keep subagent self-reports in `controllerValidating` unless a controller
  validator approves them,
- apply controller validation results to complete, block, or follow up a node,
- run an optional subagent integration gate after validation and before node completion,
- optionally route abnormal observations through a `ControllerExceptionHandler` that records durable recovery decisions,
- compute the next ready queue and start schedulable DAG nodes,
- accept a workspace allocator hook so native Git worktree allocation can remain
  a strategy instead of hard-coded controller behavior.

`GoalRuntime` exposes the same APIs as instance methods so adapters can drive the
loop without reaching into the store directly. For native-git worktree nodes,
subagent branch integration must reach `complete` or `not-required` before the
node can be marked `complete`; failed integration leaves the node blocked or sends
a follow-up prompt. When every DAG node reaches a terminal state, adapters can
call `finalizeGoalFromDagTerminalState()` to close the parent goal: all
`complete`/`superseded` nodes with successful required integrations mark the goal
`complete`, while any `blocked`/`failed` node or missing required integration
marks the goal `blocked` with ledger evidence from the terminal DAG state.

## Goal DAG planning and scheduling

The portable core exports deterministic DAG helpers for controller adapters. See
[`docs/goal-dag-format.md`](docs/goal-dag-format.md) for the user-facing JSON DAG
file format supported by `/goal --dag <path>`.

- `planGoalDagFromObjective()` converts free-form objective text into exactly one
  `GoalDagPlanNodeInput` fallback node and never parses markdown task lists into multiple nodes,
- `parseGoalDagFileContent()` and `planGoalDagFromFileDocument()` load explicit,
  schema-shaped JSON DAG files for multi-node execution, including optional
  model-routing scenarios for controller/subagent model selection,
- `createGoalDagNodes()` normalizes proposed DAG node inputs into durable node
  records,
- `assertValidGoalDag()` / `validateGoalDag()` reject duplicate nodes, missing
  dependencies, self-dependencies, and cycles,
- `getGoalDagReadyQueue()` computes runnable nodes by dependency completion,
  current subagent activity, max concurrency, and conflict hints.

`GoalRuntime` wraps these through `planGoalDag()`, `planGoalDagFromObjective()`,
and `getGoalDagReadyQueue()` so harness adapters can persist a plan, ask which
nodes are schedulable, and keep subagent self-reports separate from controller
validation.

## Native Git workspace manager

The portable core exports `NativeGitWorkspaceManager` for harnesses that want the
default Git-backed workspace strategy. It can:

- find the enclosing Git repository from an invocation directory,
- resolve a base ref from explicit options, configured defaults, controller
  workspace branch, remote default branch, current branch, or HEAD,
- create unique controller and subagent worktrees/branches under `.worktrees/`,
- record allocation shapes suitable for goal/subagent state metadata,
- clean up generated worktrees/branches when a host policy allows it,
- merge committed subagent branch heads into the controller workspace through
  `createNativeGitSubagentBranchIntegrator()` before node completion,
- apply terminal subagent cleanup policy that removes completed worktrees by
  default while preserving blocked/failed worktrees for inspection.

Subagent allocation is available through `allocateSubagentWorkspace()` and the
controller-loop adapter `createNativeGitSubagentWorkspaceAllocator()`. The
allocator returns the subagent id, worktree path, branch, and allocation metadata
for the controller loop's workspace hook, so each DAG node can run in its own
branch/worktree without coupling the scheduler to Git. The branch integrator uses
safe native-git merges, fails closed when the controller or subagent worktree has
uncommitted changes, aborts merge conflicts, records source/integrated commit
metadata, and returns a recovery prompt for conflict/dirty-worktree follow-up.
Node records can retain controller-prepared resource metadata so recovery
handlers can reuse the same worktree/branch/session context instead of creating
uncontrolled duplicates.
Cleanup helpers
`cleanupTerminalSubagentWorkspaces()` and `cleanupSubagentWorkspace()` are
explicit host-policy calls; the portable controller loop does not delete
worktrees implicitly. Harness adapters decide when terminal cleanup is safe; the
Pi adapter removes completed subagent worktrees and auto-allocated controller
worktrees after validated terminal closeout, while preserving explicit user
workspaces and blocked/failed subagent worktrees for inspection.

This manager uses only native `git` commands and does not require Pi, GitHub,
OpenSpec, or project-local helper scripts.

## Pi bridge

The package declares a compiled Pi extension in `package.json`:

```json
{
  "pi": {
    "extensions": ["./dist/adapters/pi/index.js"]
  }
}
```

Build before installing or loading it:

```bash
cd /home/shawn/projects/active/goal-runner
npm install
npm run build
```

Then install or load this directory as a Pi package:

```bash
pi install /home/shawn/projects/active/goal-runner
# or one-off:
pi -e /home/shawn/projects/active/goal-runner/dist/adapters/pi/index.js
```

After the GitHub repository is published, install the pinned release from GitHub:

```bash
pi install git:github.com/a5345534/goal-runner@v0.1.0
```

The Pi bridge registers these commands and model-visible tools:

| Command / tool | Purpose |
| --- | --- |
| `/goal` | Show the current/default goal status, DAG/subagent summary, elapsed time, token usage/budget, turn count, and useful subcommands. |
| `/goal <objective>` | Start a long-running orchestrated goal with one execution node. If no workspace is supplied, `/goal` auto-allocates a controller worktree/branch from the current Git repository. |
| `/goal --dag <path>` | Start a long-running orchestrated goal from a JSON DAG file. See `docs/goal-dag-format.md`. |
| `/goal --workspace <path> --branch <branch> <objective>` | Start a single-node orchestrated goal in an explicit Git workspace/branch. |
| `/goal --workspace <path> --branch <branch> --dag <path>` | Start a file-based DAG goal in an explicit Git workspace/branch. |
| `/goal --workspace <path> --ref <ref> <objective>` | Start a single-node orchestrated goal in an explicit Git workspace/ref. |
| `/goal --tokens <budget> <objective>` | Start an orchestrated goal with a token budget, for example `100k` or `1.5m`. |
| `/goal list` | List recent materialized goals and open the selected goal in the read-only monitor. |
| `/goal status [goal-ref]` | Show status, metadata, DAG nodes, subagents, and validation summaries for the selected/default goal. |
| `/goal monitor [goal-ref]` | Open a read-only monitor for the selected/default goal transcript and lifecycle controls. |
| `/goal debug [goal-ref]` | Emit a point-in-time debug report with DAG/subagent counts, recent events, detected anomalies, and the active trace file when tracing is enabled. |
| `/goal config [key] [value\|clear]` | List, inspect, update, or clear goal-runner runtime configuration keys in one place. |
| `/goal pause [goal-ref]` | Pause the selected/default goal so automatic continuation stops until it is resumed. |
| `/goal resume [goal-ref]` | Resume a paused/blocked/budget-limited/usage-limited selected/default goal when policy allows continuation. |
| `/goal retry-node [goal-ref] <node-id>` | Reset a blocked/failed DAG node to `planned`, retire its non-terminal runner attempt, and resume controller scheduling so the node can start again with fresh resources. |
| `/goal continue-node [goal-ref] <node-id>` | Keep the current subagent/session/worktree, reset its controller retry counters, and ask the controller to continue the blocked/failed node in-place. |
| `/goal clear [goal-ref]` | Clear runtime state for the selected/default goal without deleting its execution workspace or worktree. |
| `/goal edit [goal-ref] <objective>` | Replace the selected/default goal's objective. If no objective is supplied, prompt with an editor. |
| `/goal budget [goal-ref] <token-budget>` | Replace the selected/default goal's token budget without resetting already-used tokens. |
| `get_goal` | Model-visible tool that returns the current Pi session goal, status, budget, usage, and elapsed time. |
| `get_goal_debug` | Model-visible read-only tool that returns the same diagnostic/anomaly report as `/goal debug`, so agents can inspect run traces without human slash-command intervention. |
| `goal_config` | Model-visible configuration tool for `show`, `get`, `set`, and `clear` operations. Agents should only `set`/`clear` when explicitly instructed by the user. |
| `create_goal` | Model-visible Codex-compatible tool that creates a current-session goal only when explicitly requested and no current goal exists. |
| `update_goal` | Model-visible Codex-compatible tool that marks the current goal `complete` or `blocked` subject to runtime audit rules. |

It deliberately does **not** register `goal_complete`, `pause_goal`, or `abort_goal`; completion remains `update_goal({"status":"complete"})`.

### Goal configuration

`/goal config` lists every goal-runner parameter managed by the Pi bridge, its
effective value, source (`env`, `config`, `default`, or `unset`), backing
environment variables, and config file path. Use:

```text
/goal config                         # list all settings
/goal config controller-poll-ms      # inspect one setting
/goal config controller-poll-ms 0    # disable polling
/goal config debug-trace on          # enable trace for the next Pi reload/start
/goal config debug-trace-file /tmp/goal-debug.jsonl
/goal config model-routing-file .goal/model-routing.json
/goal config trusted-submodule-url-patterns '["https://github.com/a5345534/*"]'
/goal config max-subagents clear     # remove config value, falling back to env/default
```

Agents can use the model-visible `goal_config` tool with `{ "action": "show" }`,
`{ "action": "get", "key": "debug-trace" }`, `{ "action": "set", ... }`, or
`{ "action": "clear", ... }`. Environment variables still override config-file
values. Settings backed by legacy env-only code paths are applied as config-backed
environment defaults when the Pi extension loads; values marked as restart/reload
settings require a fresh Pi/goal-controller process to affect already-loaded
components.

`/goal config` currently covers: subagent concurrency/retry limits, controller
poll/lease timing, debug trace on/file/dir, allowed workspace roots, completion
audit mode, model routing/catalog/binding overrides, trusted submodule URL
patterns, and controller audit model.

`/goal --tokens <budget> ...` accepts positive numbers with optional `k` or `m` suffixes, for example `100k` or `1.5m`. New Pi goals are always orchestrated. Free-form objectives produce one execution node; multi-node DAGs require `/goal --dag <path>` with a JSON file matching `schemas/goal-dag.schema.json`. DAG files can declare `modelRouting.scenarios` plus rules so the controller session and each subagent node can use different abstract `modelClass` values by scenario. Concrete provider/model ids are resolved only by goal-runner harness binding catalogs, with resolution evidence persisted on controller metadata and DAG nodes. Reusable routing can also be provided through `AGENT_GOAL_MODEL_ROUTING_FILE` or `AGENT_GOAL_MODEL_ROUTING_JSON`, with DAG-local routing taking precedence. The controller can either use the supplied Git workspace or auto-allocate a native Git controller worktree/branch when workspace/branch/ref are omitted, then create subagent worktrees/branches under `.worktrees/`. Controller startup reports planned/started counts to the caller but does not send an initial model prompt to the controller session; token-consuming turns begin with subagent work or later controller validation/decision prompts. Explicit Git workspaces require a matching `--branch` or `--ref`. The adapter validates configured workspaces with read-only filesystem/git inspection and refuses missing, inaccessible, non-git, branch/ref-mismatched, or host-policy-disallowed bindings. Pi persists orchestration state in the goal store and restores active controller pollers on later session starts or `/goal` command entry. After all DAG nodes are terminal, controller validation passes, and required subagent branch integrations succeed (or are recorded as `not-required`), Pi marks the parent goal complete/blocked, clears stale subagent error notes, stops the controller poller, removes completed subagent worktrees, and removes auto-allocated controller worktrees; explicit workspaces and blocked/failed subagent worktrees are preserved. Subagents are prompted to commit intended repository changes on their assigned branch before reporting `SUBAGENT_RESULT:` because uncommitted work cannot be merged into the controller workspace. Set `AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` to a colon-separated list of allowed roots (semicolon-separated on Windows) to restrict eligible execution workspaces. Set `AGENT_GOAL_PI_CONTROLLER_POLL_MS=0` to disable polling. Pi controller validation always executes declared shell validators; nodes that declare validators never pass on self-report alone.

### Debug trace and run diagnostics

`/goal debug [goal-ref]`, the model-visible `get_goal_debug` tool, and
`goal-runner debug [goal-ref]` produce a compact post-run diagnostic report from
the durable goal store. The report summarizes
DAG node/subagent status counts, recent ledger events, and anomaly signatures
such as runner-starting without a live subagent, recoverable runner-launch
failures waiting for retry, blocked/failed nodes, failed integrations, and DAGs
that are terminal but not finalized.

Use `/goal config debug-trace on` or set `GOAL_RUNNER_DEBUG_TRACE=1` (or legacy
`AGENT_GOAL_DEBUG_TRACE=1`) before starting Pi/OpenCode/CLI to persist JSONL trace events under the runtime state
root (`debug-traces/goal-runner-debug-YYYY-MM-DD.jsonl` by default). The trace
captures logical store/database operations, controller tick/loop summaries,
monitor snapshot summaries, and one structured `anomaly` event for each detected
abnormal condition. Override the destination with `GOAL_RUNNER_DEBUG_TRACE_DIR`
or `GOAL_RUNNER_DEBUG_TRACE_FILE`. Trace details are intentionally compact and
redact prompt/objective/content-like fields so they can be attached to bug
reports without copying full transcripts.

For auto-allocated native-Git controller workspaces, submodule retained-ref publish trusts existing versioned submodule URLs when a gitlink is updated but the parent tree's `.gitmodules` URL for that path is unchanged. Newly added submodules or `.gitmodules` URL changes still require an operator allowlist before retained-ref publishing. Configure extra trusted URLs before starting or resuming the controller with `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS`, using either a JSON array or comma/newline-separated patterns. Patterns require exact match unless they end in `*`, which performs prefix matching. Example: `AGENT_GOAL_NATIVE_GIT_TRUSTED_SUBMODULE_URL_PATTERNS='["https://github.com/a5345534/*"]'`. Ordinary `goal/...` branches are not treated as durable refs, and a running Pi/controller process must be restarted or freshly loaded to pick up environment changes.

### Workspace preflight gate

Before starting a new goal controller, the adapter always runs a read-only Git
preflight inspector on the execution workspace. The inspector scans the root
worktree and every known submodule for uncommitted changes (staged, unstaged, and
untracked files in the root; gitlink mismatches and internal worktree dirtiness
in submodules). It uses **only read-only Git commands**. It never runs
`git commit`, `git stash`, `git checkout`, `git clean`, `git reset`, or any other
mutating repair command.

When the gate finds dirtiness, it produces specific diagnostics naming each dirty
path, its kind (staged/unstaged/untracked for root files; gitlink-changed or
internal-dirty for submodules), and a summary. The start is then blocked and the
diagnostic is reported to the user. The workspace is left **exactly as found** so
the user can inspect and decide on a repair strategy. No automatic repair is
ever attempted.

**Explicit workspaces** (`--workspace <path>`) block on any uncommitted change in
the root or any submodule. The diagnostic lists every dirty entry with path and
kind so the user knows exactly what needs attention.

**Auto-allocated workspaces** (no `--workspace` supplied) should be clean by
construction because the controller creates a fresh worktree from a known base
ref. If the preflight finds dirtiness in an auto-allocated workspace, the gate
still blocks and the diagnostic suggests checking for stale worktree collisions
or dirty base refs.

The preflight inspects **only the execution workspace**. The current invocation
directory (where the user typed `/goal`) is never checked. In-progress work
elsewhere in the repository does not block a goal that runs in a clean
worktree.

#### Manual repair guidance

The preflight gate blocks but does not repair. When a start is blocked, use
standard Git workflows to resolve the dirtiness, then re-run `/goal`:

**Root worktree changes** (staged, unstaged, or untracked files in the repository
root):

```bash
# Option A: commit the changes
cd <execution-workspace>
git add -A
git commit -m "resolve preflight: staged/unstaged/untracked changes"
/goal --workspace <path> --branch <branch> <objective>   # retry

# Option B: stash the changes (can re-apply later)
cd <execution-workspace>
git stash push --include-untracked --message "preflight stash"
/goal --workspace <path> --branch <branch> <objective>   # retry

# Option C: discard specific untracked or unstaged changes
cd <execution-workspace>
git clean -fd <untracked-path>              # remove untracked files
git checkout -- <path>                     # discard unstaged changes
git restore --staged <path>                # unstage staged changes
/goal --workspace <path> --branch <branch> <objective>   # retry
```

**Submodule gitlink changes** (the parent records a different submodule commit;
the diagnostic shows `gitlink changed`):

```bash
cd <execution-workspace>
# Option A: commit the gitlink update as an intentional pin change
git add <submodule-path>
git commit -m "update submodule pin"

# Option B: restore the expected submodule SHA
git submodule update <submodule-path>
```

**Submodule internal dirtiness** (uncommitted files inside a submodule worktree;
the diagnostic lists specific files):

```bash
cd <execution-workspace>/<submodule-path>
# Option A: commit inside the submodule
git add -A
git commit -m "resolve preflight: internal changes"

# Option B: stash inside the submodule
git stash push --include-untracked --message "preflight stash"
```

#### Retryability

Preflight gate blocking is not a permanent error. After the user commits,
stashes, or cleans the offending entries, re-running the same `/goal` command
will start the goal controller. The gate is purely a start-time cleanliness check
and does not record any blocking state in the goal store. No special
unblock/resume command is needed; just fix the workspace and retry.

#### What the preflight gate does not do

- It does **not** run any automatic Git repair (`git commit`, `git stash`,
  `git clean`, `git checkout`, `git reset`, or any mutating subcommand).
- It does **not** inspect the invocation directory or any workspace other than
  the execution workspace.
- It does **not** enforce remote submodule publish durability, remote push
  safety, or closeout-time submodule re-verification. Those belong to the
  closeout pipeline, which is a separate scope.
- It does **not** block on detached HEAD (detached HEAD is reported in the
  diagnostic summary but does not, by itself, prevent a start).
- It does **not** inspect ignored files (`.gitignore`-excluded paths).

DAG nodes can also declare a generic test-spec validation contract through `kind` and `validation` metadata. A planner can model test-spec-first work as visible `test-spec` / `test-review` / `implementation` / `audit` nodes, lock approved test artifacts by sha256, and require evidence such as `validators-ran`, `locked-artifacts-unchanged`, `implementation-diff-present`, or `audit-report-present`. Controller validation fails closed when locked artifacts change, required evidence is missing, declared validators are skipped, a high-risk `kind=implementation` node has no validation contract, or an audit report used for `audit-report-present` explicitly says violations remain. `requiredEvidence` is a closed vocabulary: unsupported labels are rejected by DAG parsing and also blocked by runtime validation if encountered in old durable state; map natural-language checks to explicit `validators`, `artifactLocks`, path policy (`allowedPaths`/`forbiddenPaths`), or `auditReportPaths` fields.

Bare `/goal` shows the current/default goal's objective, status, elapsed time, token usage/budget, goal-turn count, and currently useful subcommands. `/goal status` groups the objective, workspace, session, DAG summary, DAG nodes, and subagent records into readable sections with shortened ids/paths, and reports stalled DAGs when an otherwise active goal has only terminal failed/blocked nodes. `/goal monitor` opens a live dashboard that refreshes DAG and subagent state every second, showing node/subagent status counts, runtime duration, last activity age, branch/workspace, validation, notes, and transcript tail. The monitor has separate `DAG / Subagents` and `Transcript tail` panes: press `d` or `t` to focus a pane, `↑↓` to scroll the focused pane, `PageUp`/`PageDown` for page scrolling, `Home` for top, and `End` for DAG bottom or transcript live tail. `/goal list` lists recent materialized goals from the portable registry. Selecting a goal opens the same read-only monitor and keeps lifecycle actions as explicit buttons/commands rather than free-form input into the goal session. Targeted commands resolve full or short goal ids and reject ambiguous prefixes; when the goal-ref is omitted, commands prefer the current controller session's goal, then the latest non-terminal goal, then the latest goal. `/goal retry-node [goal-ref] <node-id>` is the fresh-resource escape hatch for blocked or failed DAG nodes; `/goal continue-node [goal-ref] <node-id>` is the same-subagent escape hatch that preserves the existing session/worktree and only resets controller retry counters. The Pi status line uses compact status strings such as `🎯 active 18k/100k`, `🎯 paused`, `🎯 blocked`, `🎯 budget 100k/100k`, or `🎯 complete`.

Hidden continuation is implemented with Pi custom hidden messages using `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, guarded by runtime continuation reservations and adapter-side `attemptId` idempotency. The Pi bridge keeps the portable SQLite store canonical and mirrors goal snapshots, reservations, metadata, clears, and ledger events into Pi custom session entries (`goal-runner-state`) so Pi session history can carry host-native goal traces without becoming mandatory storage for non-Pi adapters. While a goal is active, the Pi bridge also injects an ordinary-turn reminder that preserves the full objective as untrusted user-provided task data and explicitly keeps system/developer/workspace/tool policy above the goal. If Pi reports a goal turn ending with `aborted` or `error`, the bridge pauses the goal and requires `/goal resume` before automatic continuation resumes. When the failed turn includes partial assistant text or tool-call traces, the bridge preserves a hidden recovery context that treats the excerpt as untrusted transcript evidence for the later resume. Queued hidden continuations carry an adapter marker with goal id, observed update timestamp, and attempt id. Stale continuations are rewritten into non-runnable bookkeeping, and older duplicate continuations for the same active goal are superseded so only the latest matching continuation remains runnable.

Automatic continuation is progress-gated: a completed turn only queues another hidden continuation when the adapter reports meaningful progress such as task-relevant read/write/edit/bash/test activity. Pure chat, repeated status checks, or rejected completion attempts leave the goal active but return control to the user instead of spinning.

The Pi adapter also installs a post-stop guard where Pi exposes tool-call interception. After a goal is completed, blocked, paused, budget/usage-limited, or a completion audit rejects in the current turn, subsequent write-capable tools are blocked for that turn; the model should summarize and yield.

## Blocked rule

`update_goal({ "status": "blocked" })` is restricted. The same blocking condition must recur for at least three consecutive goal turns before the goal can be marked blocked. This prevents early abandonment after a single failed command or ordinary difficulty.

The core runtime always enforces the three-turn minimum when turn count is available. The Pi bridge adds a stricter transcript-aware audit for blocked updates: it derives normalized blocker signatures from recent failed tool results or explicit blocked/cannot-proceed assistant text and rejects `blocked` when the recent signatures do not match across the threshold. This preserves the Codex-style status-only tool schema while making Pi's adapter harder to misuse.

## Completion audit and ledger

Completion is still requested with:

```json
{"status":"complete"}
```

through `update_goal`. The runtime can now run a pluggable completion audit before recording the terminal `complete` state. Audit approval records completion; audit rejection leaves the goal non-terminal, records the rejection in the execution ledger, suppresses same-turn continuation, and reports the reason to the user/model.

The Pi adapter enables a lightweight transcript heuristic auditor by default. Disable it with:

```bash
AGENT_GOAL_COMPLETION_AUDIT=off
# or
PI_GOAL_COMPLETION_AUDIT=off
```

The heuristic approves when the Pi transcript contains task-relevant tool evidence or verification signals such as tests/builds/checks/OpenSpec validation. It rejects pure self-certification with no task-relevant tool or verification evidence. Hosts can replace this with a stronger auditor through the runtime callback contract.

Every goal store now also records a durable ledger of lifecycle and execution events: create/edit/pause/resume, turn start/finish, meaningful progress, continuation outcomes, completion requests, audit results, completed/blocked transitions, and budget/usage limits. The ledger is portable store data, not Pi-only `.pi/goals/*.md` canonical state.

## Pi token accounting

The portable runtime accepts normalized token snapshots. The Pi adapter normalizes completed assistant usage as `input + output` when those channels are present and excludes provider cache accounting channels such as `cacheRead` / `cacheWrite` from goal budget usage. If a Pi/bridged usage object lacks input/output channels but exposes a finite positive `totalTokens`, the adapter uses that as a fallback. The core runtime still computes deltas and transitions goals to `budgetLimited` when the normalized total reaches the configured budget.

## OpenCode bridge

The package also exports a compiled OpenCode plugin. The plugin reuses
the same portable runtime the Pi bridge uses, so the Codex-compatible
`get_goal`, `create_goal`, `update_goal` tools and the orchestrating
`/goal` workflow work the same way inside OpenCode TUI and server
modes.

The opencode adapter is loaded by OpenCode's plugin system (it is
*not* auto-installed by `npm install`). After publishing the package,
install the pinned release into the user's opencode config with:

```bash
opencode plugin install github:a5345534/goal-runner@v0.1.0
# or for a local development build:
opencode plugin install /home/shawn/projects/active/goal-runner
```

The adapter is reachable from a built checkout through:

```bash
node -e "import('./dist/adapters/opencode/index.js').then(m => console.log(typeof m.opencodeGoalPlugin))"
# function
```

The plugin registers the same three Codex-compatible model tools
(`get_goal`, `create_goal`, `update_goal`) plus a `goal_command` tool
that takes the full `/goal <args>` string. In TUI mode the plugin also
registers a `/goal` slash command that prompts for input and forwards
it to the same handler. Outside TUI mode, the model invokes the
`goal_command` tool.

| Command / tool | Purpose |
| --- | --- |
| `/goal` | Show the current goal (delegates to `get_goal`). |
| `/goal <objective>` | Start an orchestrated goal (same `--workspace` / `--branch` / `--ref` / `--tokens` flags the Pi bridge accepts). |
| `/goal --dag <path>` | Start an orchestrated goal whose objective + DAG come from a JSON DAG file (see [`docs/goal-dag-format.md`](docs/goal-dag-format.md)). |
| `/goal --model-routing '<json>'` | Inline `modelClass` routing config (same schema as the Pi bridge). |
| `/goal --model-routing-file <path>` | Load model-routing config from a file. |
| `/goal list` | List recent opencode goals. |
| `/goal status [goal-ref]` | Show DAG, subagent, and validation summary for the goal. |
| `/goal monitor [goal-ref]` | Render a text-based monitor with per-node status, validation summary, subagent branch / workspace, and self-reported notes. |
| `/goal pause / resume / clear [goal-ref]` | Lifecycle operations, resolved by short goal id when supplied. |
| `/goal edit / budget [goal-ref] <value>` | Objective and token-budget edits. |
| `get_goal` | Model-visible: returns the current opencode goal, status, budget, usage, and elapsed time. |
| `create_goal` | Model-visible Codex-compatible create. |
| `update_goal` | Model-visible Codex-compatible complete/blocked, with the same audit gates the Pi bridge enforces. |
| `goal_command` | Tool counterpart of `/goal` so non-TUI modes can run goal commands. |

The bridge is intentionally close to the Pi bridge: hidden
continuation uses the same `<agent_goal_continuation>` markers
rewritten through `experimental.chat.messages.transform`; the post-stop
tool guard uses `tool.execute.before`; completion audits are off by
default and toggled through the same `AGENT_GOAL_COMPLETION_AUDIT` env
var; the subagent adapter spawns detached `opencode serve --port 0`
background processes per DAG node in dedicated worktrees, mirroring
the Pi bridge's detached-child pattern.

The controller poll loop also calls the portable runtime's
`finalizeGoalFromDagTerminalState` when the DAG reaches a terminal
state, then runs `cleanupTerminalSubagentWorkspaces` to remove each
subagent's native-git worktree and shuts down the detached opencode
background session. `AGENT_GOAL_OPENCODE_CONTROLLER_POLL_MS=0` disables
controller polling. OpenCode controller validation always executes
declared shell validators instead of accepting self-report only. Set
`AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` to a colon-separated list of
allowed roots to restrict eligible execution workspaces.

Model routing uses abstract classes only: `--model-routing`,
`--model-routing-file`, `AGENT_GOAL_MODEL_ROUTING_FILE`,
`AGENT_GOAL_MODEL_ROUTING_JSON`, and DAG file `modelRouting` all contain
`modelClass` values. Harness adapters resolve those classes through model-class
and binding catalogs, persist resolution evidence, and then translate the
resolved model into the harness-specific concrete model argument. By default the
catalogs come from `goal-contract/catalogs/model-classes.json` and
`goal-contract/catalogs/bindings/<harness>.json`; operators can override them
with `AGENT_GOAL_MODEL_CLASS_CATALOG_FILE`,
`AGENT_GOAL_MODEL_CLASS_CATALOG_JSON`, `AGENT_GOAL_MODEL_BINDING_FILE`, or
`AGENT_GOAL_MODEL_BINDING_JSON`. Explicit file overrides fail closed when the
file is missing, invalid, for the wrong harness, or under-capable for the
requested class.
