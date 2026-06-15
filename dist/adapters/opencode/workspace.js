// Shared workspace flag parsing and validation for the opencode adapter.
//
// The opencode adapter does not have its own native workspace manager — it
// reuses the read-only workspace flag parser and git-backed binding
// validator that the Pi adapter exposes. Keeping the re-export here means
// the opencode adapter has a stable import path (`./workspace.js`) and a
// single place to swap in a different validation strategy in the future.
export { parseGoalWorkspaceFlags, resolveWorkspaceBinding, tokenize, validateExecutionWorkspace, } from "../pi/workspace.js";
//# sourceMappingURL=workspace.js.map