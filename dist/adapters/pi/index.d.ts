import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function goalPiExtension(pi: ExtensionAPI): void;
export declare function readPiAssistantTokenTotalFromEntries(entries: Array<Record<string, unknown>>): number;
export declare function normalizePiAssistantUsage(usage: unknown): number;
