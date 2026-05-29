# agent-goal-runtime

Portable Codex-compatible `/goal` runtime with a Pi bridge.

This project provides the common framework first:

- shared `/goal` command parser
- one-current-goal-per-session state model
- Codex-compatible goal statuses (`active`, `paused`, `blocked`, `usageLimited`, `budgetLimited`, `complete`)
- SQLite default store with a pluggable store interface
- lifecycle hooks for turn/tool/accounting events
- hidden continuation reservation + idempotent callback contract
- model-visible `get_goal`, `create_goal`, and restricted `update_goal` behavior
- Pi extension adapter with transcript-aware blocked audit

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

The Pi bridge registers:

- `/goal`
- `/goal <objective>`
- `/goal edit`
- `/goal pause`
- `/goal resume`
- `/goal clear`
- `get_goal`
- `create_goal`
- `update_goal`

Hidden continuation is implemented with Pi custom hidden messages using `pi.sendMessage(..., { triggerTurn: true, deliverAs: "followUp" })`, guarded by runtime continuation reservations and adapter-side `attemptId` idempotency.

## Blocked rule

`update_goal({ "status": "blocked" })` is restricted. The same blocking condition must recur for at least three consecutive goal turns before the goal can be marked blocked. This prevents early abandonment after a single failed command or ordinary difficulty.

The core runtime always enforces the three-turn minimum when turn count is available. The Pi bridge adds a stricter transcript-aware audit for blocked updates: it derives normalized blocker signatures from recent failed tool results or explicit blocked/cannot-proceed assistant text and rejects `blocked` when the recent signatures do not match across the threshold. This preserves the Codex-style status-only tool schema while making Pi's adapter harder to misuse.
