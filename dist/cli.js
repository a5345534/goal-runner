#!/usr/bin/env node
import { cwd } from "node:process";
import { GoalRuntime, SQLiteGoalStore, parseGoalCommand } from "./core/index.js";
const args = process.argv.slice(2);
const sessionIndex = args.indexOf("--session");
let sessionKey = `cli:${cwd()}`;
if (sessionIndex >= 0) {
    const value = args[sessionIndex + 1];
    if (!value)
        throw new Error("--session requires a value");
    sessionKey = value;
    args.splice(sessionIndex, 2);
}
const stateRootIndex = args.indexOf("--state-root");
let stateRoot;
if (stateRootIndex >= 0) {
    const value = args[stateRootIndex + 1];
    if (!value)
        throw new Error("--state-root requires a value");
    stateRoot = value;
    args.splice(stateRootIndex, 2);
}
if (args[0] === "--help" || args[0] === "-h") {
    printHelp();
    process.exit(0);
}
// Guard against accidental CLI invocation with a /goal prefix
if (args[0] === "/goal" || args[0]?.startsWith("/goal")) {
    console.error(`Rejected: first argument starts with '/goal'. Did you mean to type a bare objective or subcommand?`);
    console.error(`Usage: goal-runner [--session KEY] [--state-root DIR] <objective>`);
    process.exit(2);
}
const store = new SQLiteGoalStore({ stateRoot });
const runtime = new GoalRuntime({ store });
try {
    const commandLine = args.join(" ");
    const parsed = parseGoalCommand(commandLine);
    if (parsed.kind === "edit") {
        throw new Error("CLI edit requires passing the replacement objective directly, e.g. goal-runner \"new objective\" (agent-goal remains a legacy alias)");
    }
    const result = await runtime.executeParsedCommand(sessionKey, parsed);
    console.log(result.message);
}
finally {
    store.close();
}
function printHelp() {
    console.log(`goal-runner — portable /goal runtime smoke CLI

Usage:
  goal-runner [--session KEY] [--state-root DIR]                  Show current goal
  goal-runner [--session KEY] [--state-root DIR] <objective>      Start/update goal
  goal-runner [--session KEY] [--state-root DIR] pause            Pause goal
  goal-runner [--session KEY] [--state-root DIR] resume           Resume goal
  goal-runner [--session KEY] [--state-root DIR] clear            Clear goal

Legacy alias: agent-goal

The CLI is a smoke/debug surface. Full Codex-compatible behavior requires a harness adapter such as the Pi bridge.`);
}
//# sourceMappingURL=cli.js.map