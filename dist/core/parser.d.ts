export declare const MAX_GOAL_OBJECTIVE_CHARS = 4000;
export type GoalCommand = {
    kind: "show";
} | {
    kind: "start";
    objective: string;
} | {
    kind: "edit";
} | {
    kind: "pause";
} | {
    kind: "resume";
} | {
    kind: "clear";
};
export declare function validateGoalObjective(input: string): string;
export declare function parseGoalCommand(args?: string): GoalCommand;
