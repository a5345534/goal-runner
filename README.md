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
- prompt rendering that treats goal objectives as untrusted user-provided task data
- Pi extension adapter with transcript-aware blocked audit, slash-command token budgets, active-goal reminders, heuristic completion audit, post-stop tool guarding, abort/error pausing, and stale-continuation guards

Other agent harness bridges are intentionally out of scope for this first implementation and should be added through separate changes.

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

The Pi bridge registers:

- `/goal`
- `/goal --workspace <path-or-profile> --branch <branch> <objective>`
- `/goal --workspace <path-or-profile> --ref <ref> <objective>`
- `/goal --tokens 100k --workspace <path-or-profile> --branch <branch> <objective>`
- `/goal workspace add <name> --path <path> [--branch <branch>|--ref <ref>]`
- `/goal workspace list|show|remove`
- `/goal list`
- `/goal status|monitor|pause|resume|clear <goal-ref>`
- `/goal edit <goal-ref> <objective>`
- `/goal budget <goal-ref> <token-budget>`
- session-local legacy `/goal edit`, `/goal pause`, `/goal resume`, `/goal clear`
- `get_goal`
- `create_goal`
- `update_goal`

It deliberately does **not** register `goal_complete`, `pause_goal`, or `abort_goal`; completion remains `update_goal({"status":"complete"})`.

`/goal --tokens <budget> ...` accepts positive numbers with optional `k` or `m` suffixes, for example `100k` or `1.5m`. New Pi goals require an explicit execution workspace binding. Git-backed workspaces also require an explicit branch/ref binding, either inline or supplied by a named workspace profile. The adapter validates the configured workspace with read-only filesystem/git inspection and refuses missing, inaccessible, non-git branch/ref, branch/ref-mismatched, or host-policy-disallowed bindings; it does not create/delete worktrees, create branches, or switch branches. Set `AGENT_GOAL_ALLOWED_WORKSPACE_ROOTS` to a colon-separated list of allowed roots (semicolon-separated on Windows) to restrict eligible execution workspaces.

Bare `/goal` shows the current session's objective, status, elapsed time, token usage/budget, goal-turn count, and currently useful subcommands. `/goal list` lists recent materialized goals from the portable registry, including legacy session-bound goals. Targeted commands resolve full or short goal ids and reject ambiguous prefixes. The Pi status line uses compact status strings such as `🎯 active 18k/100k`, `🎯 paused`, `🎯 blocked`, `🎯 budget 100k/100k`, or `🎯 complete`.

Hidden continuation is implemented with Pi custom hidden messages using `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, guarded by runtime continuation reservations and adapter-side `attemptId` idempotency. The Pi bridge keeps the portable SQLite store canonical and mirrors goal snapshots, reservations, metadata, workspace profiles, clears, and ledger events into Pi custom session entries (`agent-goal-runtime-state`) so Pi session history can carry host-native goal traces without becoming mandatory storage for non-Pi adapters. While a goal is active, the Pi bridge also injects an ordinary-turn reminder that preserves the full objective as untrusted user-provided task data and explicitly keeps system/developer/workspace/tool policy above the goal. If Pi reports a goal turn ending with `aborted` or `error`, the bridge pauses the goal and requires `/goal resume` before automatic continuation resumes. When the failed turn includes partial assistant text or tool-call traces, the bridge preserves a hidden recovery context that treats the excerpt as untrusted transcript evidence for the later resume. Queued hidden continuations carry an adapter marker with goal id, observed update timestamp, and attempt id. Stale continuations are rewritten into non-runnable bookkeeping, and older duplicate continuations for the same active goal are superseded so only the latest matching continuation remains runnable.

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
