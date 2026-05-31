import type {
  ContinuationReservation,
  GoalLedgerEvent,
  GoalRecord,
  GoalSessionMetadata,
  GoalStore,
  GoalSummary,
  WorkspaceProfile,
} from "../../core/index.js";

export const PI_GOAL_SESSION_ENTRY_TYPE = "agent-goal-runtime-state";
export const PI_GOAL_SESSION_ENTRY_VERSION = 1;

export type PiGoalSessionEntryData =
  | { version: 1; kind: "goal_snapshot"; sessionKey: string; goal: GoalRecord; at: string }
  | { version: 1; kind: "goal_cleared"; sessionKey: string; at: string }
  | { version: 1; kind: "reservation_snapshot"; sessionKey: string; reservation: ContinuationReservation; at: string }
  | { version: 1; kind: "reservation_cleared"; sessionKey: string; at: string }
  | { version: 1; kind: "ledger_event"; sessionKey: string; goalId?: string; event: GoalLedgerEvent; at: string }
  | { version: 1; kind: "goal_session_metadata"; sessionKey: string; goalId: string; metadata: GoalSessionMetadata; at: string }
  | { version: 1; kind: "workspace_profile"; profile: WorkspaceProfile; at: string }
  | { version: 1; kind: "workspace_profile_removed"; name: string; at: string };

export interface PiSessionGoalMirrorStoreOptions {
  now?: () => Date;
  onMirrorError?: (error: unknown) => void;
}

/**
 * Mirrors portable GoalStore writes into Pi custom session entries.
 *
 * The wrapped portable store remains canonical. Pi custom entries are an append-only
 * host-native trace that can follow Pi resume/fork/tree/compaction without making
 * Pi session files mandatory for non-Pi adapters.
 */
export class PiSessionGoalMirrorStore implements GoalStore {
  private readonly now: () => Date;
  private readonly onMirrorError?: (error: unknown) => void;

  constructor(
    private readonly primary: GoalStore,
    private readonly appendEntry: (data: PiGoalSessionEntryData) => void,
    options: PiSessionGoalMirrorStoreOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.onMirrorError = options.onMirrorError;
  }

  getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined> {
    return this.primary.getCurrentGoal(sessionKey);
  }

  async saveGoal(goal: GoalRecord): Promise<void> {
    await this.primary.saveGoal(goal);
    this.mirror({ version: 1, kind: "goal_snapshot", sessionKey: goal.sessionKey, goal, at: this.nowIso() });
  }

  async clearGoal(sessionKey: string): Promise<void> {
    await this.primary.clearGoal(sessionKey);
    this.mirror({ version: 1, kind: "goal_cleared", sessionKey, at: this.nowIso() });
  }

  getReservation(sessionKey: string): Promise<ContinuationReservation | undefined> {
    return this.primary.getReservation(sessionKey);
  }

  async saveReservation(reservation: ContinuationReservation): Promise<void> {
    await this.primary.saveReservation(reservation);
    this.mirror({
      version: 1,
      kind: "reservation_snapshot",
      sessionKey: reservation.sessionKey,
      reservation,
      at: this.nowIso(),
    });
  }

  async clearReservation(sessionKey: string): Promise<void> {
    await this.primary.clearReservation(sessionKey);
    this.mirror({ version: 1, kind: "reservation_cleared", sessionKey, at: this.nowIso() });
  }

  clearExpiredReservations(now?: Date): Promise<number> {
    return this.primary.clearExpiredReservations(now);
  }

  async appendLedgerEvent(event: GoalLedgerEvent): Promise<void> {
    await this.primary.appendLedgerEvent(event);
    this.mirror({
      version: 1,
      kind: "ledger_event",
      sessionKey: event.sessionKey,
      goalId: event.goalId,
      event,
      at: this.nowIso(),
    });
  }

  listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]> {
    return this.primary.listLedgerEvents(sessionKey, goalId);
  }

  async saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void> {
    await this.primary.saveGoalSessionMetadata(metadata);
    this.mirror({
      version: 1,
      kind: "goal_session_metadata",
      sessionKey: metadata.sessionKey,
      goalId: metadata.goalId,
      metadata,
      at: this.nowIso(),
    });
  }

  getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined> {
    return this.primary.getGoalSessionMetadata(sessionKey);
  }

  listGoalSummaries(): Promise<GoalSummary[]> {
    return this.primary.listGoalSummaries();
  }

  async saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void> {
    await this.primary.saveWorkspaceProfile(profile);
    this.mirror({ version: 1, kind: "workspace_profile", profile, at: this.nowIso() });
  }

  getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined> {
    return this.primary.getWorkspaceProfile(name);
  }

  listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
    return this.primary.listWorkspaceProfiles();
  }

  async deleteWorkspaceProfile(name: string): Promise<boolean> {
    const deleted = await this.primary.deleteWorkspaceProfile(name);
    if (deleted) this.mirror({ version: 1, kind: "workspace_profile_removed", name, at: this.nowIso() });
    return deleted;
  }

  close(): Promise<void> | void {
    return this.primary.close?.();
  }

  private mirror(data: PiGoalSessionEntryData): void {
    try {
      this.appendEntry(data);
    } catch (error) {
      this.onMirrorError?.(error);
    }
  }

  private nowIso(): string {
    return this.now().toISOString();
  }
}

export function readPiGoalSessionMirrorEntries(entries: Array<Record<string, unknown>>): PiGoalSessionEntryData[] {
  const mirrored: PiGoalSessionEntryData[] = [];
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== PI_GOAL_SESSION_ENTRY_TYPE) continue;
    const data = entry.data;
    if (isPiGoalSessionEntryData(data)) mirrored.push(data);
  }
  return mirrored;
}

function isPiGoalSessionEntryData(value: unknown): value is PiGoalSessionEntryData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== PI_GOAL_SESSION_ENTRY_VERSION || typeof record.kind !== "string") return false;
  if ("sessionKey" in record && typeof record.sessionKey !== "string") return false;
  if ("at" in record && typeof record.at !== "string") return false;
  switch (record.kind) {
    case "goal_snapshot":
      return typeof record.sessionKey === "string" && isRecord(record.goal);
    case "goal_cleared":
    case "reservation_cleared":
      return typeof record.sessionKey === "string" && typeof record.at === "string";
    case "reservation_snapshot":
      return typeof record.sessionKey === "string" && isRecord(record.reservation);
    case "ledger_event":
      return typeof record.sessionKey === "string" && isRecord(record.event);
    case "goal_session_metadata":
      return typeof record.sessionKey === "string" && typeof record.goalId === "string" && isRecord(record.metadata);
    case "workspace_profile":
      return isRecord(record.profile) && typeof record.at === "string";
    case "workspace_profile_removed":
      return typeof record.name === "string" && typeof record.at === "string";
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
