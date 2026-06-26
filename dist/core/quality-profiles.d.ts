import { GOAL_QUALITY_PROFILES, isGoalQualityProfile, type GoalQualityProfile } from "goal-contract";
export { GOAL_QUALITY_PROFILES, isGoalQualityProfile, type GoalQualityProfile };
export declare function qualityProfilesOf(value: unknown): string[];
export declare function cloneQualityProfiles(value: readonly GoalQualityProfile[] | undefined): GoalQualityProfile[] | undefined;
export declare function unsupportedQualityProfilesOf(value: unknown): string[];
export declare function renderQualityProfileGuardrailLines(value: unknown): string[];
