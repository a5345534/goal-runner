/**
 * Pi already accepts goal-runner's canonical `provider/model` model id.
 * This adapter keeps slash-form unchanged and only normalizes legacy
 * dotted provider prefixes seen in older persisted/routing data.
 */
export declare function normalizePiModelArg(modelArg: string | undefined): string | undefined;
