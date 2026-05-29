export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
export function validateGoalObjective(input) {
    const objective = input.trim();
    if (!objective) {
        throw new Error("goal objective must not be empty");
    }
    const length = Array.from(objective).length;
    if (length > MAX_GOAL_OBJECTIVE_CHARS) {
        throw new Error(`goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`);
    }
    return objective;
}
export function parseGoalCommand(args = "") {
    const trimmed = args.trim();
    if (!trimmed)
        return { kind: "show" };
    switch (trimmed) {
        case "edit":
            return { kind: "edit" };
        case "pause":
            return { kind: "pause" };
        case "resume":
            return { kind: "resume" };
        case "clear":
            return { kind: "clear" };
        default:
            return { kind: "start", objective: validateGoalObjective(trimmed) };
    }
}
//# sourceMappingURL=parser.js.map