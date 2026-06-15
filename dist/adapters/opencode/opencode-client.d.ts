import type { OpencodeClient } from "./shims.d.ts";
export type { OpencodeClient } from "./shims.d.ts";
export declare function isAbortError(error: unknown): boolean;
export declare function isUnavailableError(error: unknown): boolean;
export declare function createNoopOpencodeClient(): OpencodeClient;
