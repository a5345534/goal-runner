import { homedir } from "node:os";
import { resolve } from "node:path";
export function resolveDefaultStateRoot(explicitStateRoot) {
    if (explicitStateRoot)
        return resolve(expandHome(explicitStateRoot));
    if (process.env.AGENT_GOAL_STATE_HOME)
        return resolve(expandHome(process.env.AGENT_GOAL_STATE_HOME));
    if (process.env.XDG_STATE_HOME)
        return resolve(process.env.XDG_STATE_HOME, "agent-goal-runtime");
    return resolve(homedir(), ".local", "state", "agent-goal-runtime");
}
function expandHome(path) {
    if (path === "~")
        return homedir();
    if (path.startsWith("~/"))
        return resolve(homedir(), path.slice(2));
    return path;
}
//# sourceMappingURL=state-root.js.map