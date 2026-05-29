import { type GoalStatus, type GoalStatusInput } from "./types.js";
export declare function normalizeGoalStatus(value: GoalStatusInput | string): GoalStatus;
export declare function isGoalStatus(value: string): value is GoalStatus;
export declare function isAutoContinuableStatus(status: GoalStatus): boolean;
export declare function isStoppedStatus(status: GoalStatus): boolean;
export declare function toCodexWireStatus(status: GoalStatus): GoalStatus;
export declare function fromCodexWireStatus(status: string): GoalStatus;
