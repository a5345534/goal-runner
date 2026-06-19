import type { GoalControllerAuditOptions, GoalControllerAuditSnapshot } from "../../core/index.js";
export declare function controllerAuditOptions(): GoalControllerAuditOptions;
export declare function createAuditModel(): (snapshot: GoalControllerAuditSnapshot) => Promise<unknown>;
