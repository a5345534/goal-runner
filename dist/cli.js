#!/usr/bin/env node
import { cwd } from "node:process";
import { GoalRuntime, SQLiteGoalStore, buildGoalDebugReport, createGoalDebugTracerFromEnv, formatGoalDebugReport, parseGoalCommand } from "./core/index.js";
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
const debugTracer = createGoalDebugTracerFromEnv({ stateRoot });
const runtime = new GoalRuntime({ store, debugTracer });
try {
    if (args[0] === "debug") {
        const reference = args[1];
        if (args.length > 2)
            throw new Error("debug accepts at most one goal-ref");
        const goal = reference ? await resolveCliGoal(runtime, reference) : await resolveCliDefaultGoal(runtime, sessionKey);
        const state = await runtime.getGoalOrchestrationState(goal.goalId);
        const ledgerEvents = await runtime.listLedgerEvents(goal.sessionKey, goal.goalId);
        await runtime.recordMonitorDebugSnapshot(goal, state, { source: "cli.debug", ledgerEvents });
        console.log(formatGoalDebugReport(buildGoalDebugReport({ goal, state, ledgerEvents, traceTarget: runtime.getDebugTraceTarget() })));
    }
    else {
        const commandLine = args.join(" ");
        const parsed = parseGoalCommand(commandLine);
        if (parsed.kind === "edit") {
            throw new Error("CLI edit requires passing the replacement objective directly, e.g. goal-runner \"new objective\" (agent-goal remains a legacy alias)");
        }
        const result = await runtime.executeParsedCommand(sessionKey, parsed);
        console.log(result.message);
    }
}
finally {
    store.close();
}
async function resolveCliDefaultGoal(runtime, sessionKey) {
    const current = (await runtime.getGoal(sessionKey)).goal;
    if (current)
        return current;
    const summaries = await runtime.listGoalSummaries();
    if (summaries.length === 1)
        return summaries[0];
    if (summaries.length === 0)
        throw new Error("No current goal.");
    throw new Error("Multiple goals exist; pass debug <goal-ref>.");
}
async function resolveCliGoal(runtime, reference) {
    const resolved = await runtime.resolveGoalReference(reference);
    if (resolved.kind === "found")
        return resolved.goal;
    if (resolved.kind === "ambiguous")
        throw new Error(`Ambiguous goal reference ${reference}: ${resolved.matches.map((goal) => goal.shortGoalId).join(", ")}`);
    throw new Error(`Goal not found: ${reference}`);
}
function printHelp() {
    console.log(`goal-runner — portable /goal runtime smoke CLI

Usage:
  goal-runner [--session KEY] [--state-root DIR]                  Show current goal
  goal-runner [--session KEY] [--state-root DIR] <objective>      Start/update goal
  goal-runner [--session KEY] [--state-root DIR] pause            Pause goal
  goal-runner [--session KEY] [--state-root DIR] resume           Resume goal
  goal-runner [--session KEY] [--state-root DIR] clear            Clear goal
  goal-runner [--session KEY] [--state-root DIR] debug [goal-ref] Debug report

Legacy alias: agent-goal

The CLI is a smoke/debug surface. Full Codex-compatible behavior requires a harness adapter such as the Pi bridge.`);
}
//# sourceMappingURL=cli.js.map