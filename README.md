# agent-goal-runtime

Portable Codex-compatible `/goal` runtime with a Pi bridge.

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
node dist/cli.js --state-root /tmp/agent-goal-smoke clear
```

The CLI is only a debug/smoke surface. Full Codex-compatible auto-continuation requires a harness adapter.

## Harness-neutral subagent adapter contract

The portable core exports a `HarnessSubagentAdapter` contract for agent harnesses
such as Pi, Codex, Claude Code, OpenCode, or a shell/JSON-RPC bridge. The
contract covers:

- starting a subagent session for a DAG node,
- sending follow-up prompts,
- polling session state,
- optionally streaming harness events,
- aborting a session.

Helpers such as `startGoalSubagent()`, `sendGoalSubagentPrompt()`, and
`syncGoalSubagentState()` translate harness-level session handles and status into
durable `GoalSubagentRecord` updates. `GoalRuntime` wraps these helpers so a
controller can persist subagent starts and state syncs without depending on any
specific harness implementation.

The Pi adapter exports `PiHarnessSubagentAdapter`, which launches detached Pi RPC
sessions for DAG nodes, resumes existing session files for follow-up prompts, and
infers subagent state from Pi JSONL transcripts. Subagents are instructed to use
`SUBAGENT_RESULT:` / `SUBAGENT_BLOCKED:` markers; those markers are controller
inputs only, not completion gates.

## Controller orchestration loop

`runGoalControllerTick()` and `runGoalControllerLoop()` provide the first portable
controller runtime:

- synchronize active subagents through the configured harness adapter,
- keep subagent self-reports in `controllerValidating` unless a controller
  validator approves them,
- apply controller validation results to complete, block, or follow up a node,
- compute the next ready queue and start schedulable DAG nodes,
- accept a workspace allocator hook so native Git worktree allocation can remain
  a strategy instead of hard-coded controller behavior.

`GoalRuntime` exposes the same APIs as instance methods so adapters can drive the
loop without reaching into the store directly.

## Goal DAG planning and scheduling

The portable core exports deterministic DAG helpers for controller adapters. See
[`docs/goal-dag-format.md`](docs/goal-dag-format.md) for the user-facing objective
format supported by `/goal <objective>`.

- `planGoalDagFromObjective()` converts an objective into `GoalDagPlanNodeInput`
  records using either a single-node fallback or explicit markdown task-list / heading parsing,
- task-list annotations such as `[id: ...]`, `[after: ...]`, `[parallel]`,
  `[validators: ...]`, `[outputs: ...]`, and conflict hints (`[files: ...]`,
  `[modules: ...]`, `[capabilities: ...]`) let callers shape the generated DAG
  without a harness-specific planner,
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
- apply terminal subagent cleanup policy that removes completed worktrees by
  default while preserving blocked/failed worktrees for inspection.

Subagent allocation is available through `allocateSubagentWorkspace()` and the
controller-loop adapter `createNativeGitSubagentWorkspaceAllocator()`. The
allocator returns the subagent id, worktree path, branch, and allocation metadata
for the controller loop's workspace hook, so each DAG node can run in its own
branch/worktree without coupling the scheduler to Git. Cleanup helpers
`cleanupTerminalSubagentWorkspaces()` and `cleanupSubagentWorkspace()` are
explicit host-policy calls; the controller loop does not delete worktrees
implicitly.

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
cd /home/shawn/projects/active/agent-goal-runtime
npm install
npm run build
```

Then install or load this directory as a Pi package:

```bash
pi install /home/shawn/projects/active/agent-goal-runtime
# or one-off:
pi -e /home/shawn/projects/active/agent-goal-runtime/dist/adapters/pi/index.js
```

After the GitHub repository is published, install the pinned release from GitHub:

```bash
pi install git:github.com/a5345534/agent-goal-runtime@v0.1.0
```

The Pi bridge registers these commands and model-visible tools:

| Command / tool | Purpose |
| --- | --- |
| `/goal` | Show the current/default goal status, DAG/subagent summary, elapsed time, token usage/budget, turn count, and useful subcommands. |
| `/goal <objective>` | Start a long-running orchestrated goal. The controller plans the objective into a DAG, allocates native Git worktrees, launches ready Pi subagents, supervises them, and validates completion. If no workspace is supplied, `/goal` auto-allocates a controller worktree/branch from the current Git repository. |
| `/goal --workspace <path> --branch <branch> <objective>` | Start an orchestrated goal in an explicit Git workspace/branch. |
| `/goal --workspace <path> --ref <ref> <objective>` | Start an orchestrated goal in an explicit Git workspace/ref. |
| `/goal --tokens <budget> <objective>` | Start an orchestrated goal with a token budget, for example `100k` or `1.5m`. |
| `/goal list` | List recent materialized goals and open the selected goal in the read-only monitor. |
| `/goal status [goal-ref]` | Show status, metadata, DAG nodes, subagents, and validation summaries for the selected/default goal. |
| `/goal monitor [goal-ref]` | Open a read-only monitor for the selected/default goal transcript and lifecycle controls. |
| `/goal pause [goal-ref]` | Pause the selected/default goal so automatic continuation stops until it is resumed. |
| `/goal resume [goal-ref]` | Resume a paused/blocked/budget-limited/usage-limited selected/default goal when policy allows continuation. |
| `/goal clear [goal-ref]` | Clear runtime state for the selected/default goal without deleting its execution workspace or worktree. |
| `/goal edit [goal-ref] <objective>` | Replace the selected/default goal's objective. If no objective is supplied, prompt with an editor. |
| `/goal budget [goal-ref] <token-budget>` | Replace the selected/default goal's token budget without resetting already-used tokens. |
| `get_goal` | Model-visible tool that returns the current Pi session goal, status, budget, usage, and elapsed time. |
| `create_goal` | Model-visible Codex-compatible tool that creates a current-session goal only when explicitly requested and no current goal exists. |
| `update_goal` | Model-visible Codex-compatible tool that marks the current goal `complete` or `blocked` subject to runtime audit rules. |

It deliberately does **not** register `goal_complete`, `pause_goal`, or `abort_goal`; completion remains `update_goal({"status":"complete"})`.

`/goal --tokens <budget> ...` accepts positive numbers with optional `k` or `m` suffixes, for example `100k` or `1.5m`. New Pi goals are always orchestrated. The controller can either use the supplied Git workspace or auto-allocate a native Git controller worktree/branch when workspace/branch/ref are omitted, then create subagent worktrees/branches under `.worktrees/`. Controller startup reports planned/started counts to the caller but does not send an initial model prompt to the controller session; token-consuming turns begin with subagent work or later controller validation/decision prompts. Explicit Git workspaces require a matching `--branch` or `--ref`. The adapter validates configured workspaces with read-only filesystem/git inspection and refuses missing, inaccessible, non-git, branch/ref-mismatched, or host-policy-disallowed bindings. Set `AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` to a colon-separated list of allowed roots (semicolon-separated on Windows) to restrict eligible execution workspaces. Set `AGENT_GOAL_PI_CONTROLLER_POLL_MS=0` to disable polling, and set `AGENT_GOAL_PI_RUN_VALIDATORS=1` to let controller validation execute shell validators instead of only checking expected outputs and recording skipped validators.

Bare `/goal` shows the current/default goal's objective, status, elapsed time, token usage/budget, goal-turn count, and currently useful subcommands. `/goal status` groups the objective, workspace, session, DAG summary, DAG nodes, and subagent records into readable sections with shortened ids/paths, and reports stalled DAGs when an otherwise active goal has only terminal failed/blocked nodes. `/goal monitor` opens a live dashboard that refreshes DAG and subagent state every second, showing node/subagent status counts, runtime duration, last activity age, branch/workspace, validation, notes, and transcript tail. `/goal list` lists recent materialized goals from the portable registry. Selecting a goal opens the same read-only monitor and keeps lifecycle actions as explicit buttons/commands rather than free-form input into the goal session. Targeted commands resolve full or short goal ids and reject ambiguous prefixes; when the goal-ref is omitted, commands prefer the current controller session's goal, then the latest non-terminal goal, then the latest goal. The Pi status line uses compact status strings such as `🎯 active 18k/100k`, `🎯 paused`, `🎯 blocked`, `🎯 budget 100k/100k`, or `🎯 complete`.

Hidden continuation is implemented with Pi custom hidden messages using `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, guarded by runtime continuation reservations and adapter-side `attemptId` idempotency. The Pi bridge keeps the portable SQLite store canonical and mirrors goal snapshots, reservations, metadata, clears, and ledger events into Pi custom session entries (`agent-goal-runtime-state`) so Pi session history can carry host-native goal traces without becoming mandatory storage for non-Pi adapters. While a goal is active, the Pi bridge also injects an ordinary-turn reminder that preserves the full objective as untrusted user-provided task data and explicitly keeps system/developer/workspace/tool policy above the goal. If Pi reports a goal turn ending with `aborted` or `error`, the bridge pauses the goal and requires `/goal resume` before automatic continuation resumes. When the failed turn includes partial assistant text or tool-call traces, the bridge preserves a hidden recovery context that treats the excerpt as untrusted transcript evidence for the later resume. Queued hidden continuations carry an adapter marker with goal id, observed update timestamp, and attempt id. Stale continuations are rewritten into non-runnable bookkeeping, and older duplicate continuations for the same active goal are superseded so only the latest matching continuation remains runnable.

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
