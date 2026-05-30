import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDefaultStateRoot } from "./state-root.js";
import type { ContinuationReservation, GoalLedgerEvent, GoalRecord, GoalStore } from "./types.js";

interface SqliteGoalRow {
  session_key: string;
  goal_id: string;
  objective: string;
  status: GoalRecord["status"];
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  created_at: string;
  updated_at: string;
  goal_turns_since_audit_reset: number;
}

interface SqliteReservationRow {
  session_key: string;
  attempt_id: string;
  goal_id: string;
  goal_updated_at: string;
  attempt_count: number;
  status: ContinuationReservation["status"];
  host_turn_id: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
}

interface SqliteLedgerRow {
  event_id: string;
  session_key: string;
  goal_id: string | null;
  type: GoalLedgerEvent["type"];
  at: string;
  details_json: string | null;
}

export class SQLiteGoalStore implements GoalStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(options: { stateRoot?: string; dbPath?: string } = {}) {
    this.dbPath = options.dbPath ? resolve(options.dbPath) : resolve(resolveDefaultStateRoot(options.stateRoot), "goals.sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
  }

  async getCurrentGoal(sessionKey: string): Promise<GoalRecord | undefined> {
    const row = this.db.prepare("SELECT * FROM goals WHERE session_key = ?").get(sessionKey) as SqliteGoalRow | undefined;
    return row ? rowToGoal(row) : undefined;
  }

  async saveGoal(goal: GoalRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goals (
          session_key, goal_id, objective, status, token_budget, tokens_used, time_used_seconds,
          created_at, updated_at, goal_turns_since_audit_reset
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          goal_id = excluded.goal_id,
          objective = excluded.objective,
          status = excluded.status,
          token_budget = excluded.token_budget,
          tokens_used = excluded.tokens_used,
          time_used_seconds = excluded.time_used_seconds,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          goal_turns_since_audit_reset = excluded.goal_turns_since_audit_reset`,
      )
      .run(
        goal.sessionKey,
        goal.goalId,
        goal.objective,
        goal.status,
        goal.tokenBudget ?? null,
        goal.tokensUsed,
        goal.timeUsedSeconds,
        goal.createdAt,
        goal.updatedAt,
        goal.goalTurnsSinceAuditReset,
      );
  }

  async clearGoal(sessionKey: string): Promise<void> {
    this.db.prepare("DELETE FROM goals WHERE session_key = ?").run(sessionKey);
    this.db.prepare("DELETE FROM continuation_reservations WHERE session_key = ?").run(sessionKey);
  }

  async getReservation(sessionKey: string): Promise<ContinuationReservation | undefined> {
    const row = this.db
      .prepare("SELECT * FROM continuation_reservations WHERE session_key = ?")
      .get(sessionKey) as SqliteReservationRow | undefined;
    return row ? rowToReservation(row) : undefined;
  }

  async saveReservation(reservation: ContinuationReservation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO continuation_reservations (
          session_key, attempt_id, goal_id, goal_updated_at, attempt_count, status,
          host_turn_id, created_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          attempt_id = excluded.attempt_id,
          goal_id = excluded.goal_id,
          goal_updated_at = excluded.goal_updated_at,
          attempt_count = excluded.attempt_count,
          status = excluded.status,
          host_turn_id = excluded.host_turn_id,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          expires_at = excluded.expires_at`,
      )
      .run(
        reservation.sessionKey,
        reservation.attemptId,
        reservation.goalId,
        reservation.goalUpdatedAt,
        reservation.attemptCount,
        reservation.status,
        reservation.hostTurnId ?? null,
        reservation.createdAt,
        reservation.updatedAt,
        reservation.expiresAt,
      );
  }

  async clearReservation(sessionKey: string): Promise<void> {
    this.db.prepare("DELETE FROM continuation_reservations WHERE session_key = ?").run(sessionKey);
  }

  async clearExpiredReservations(now = new Date()): Promise<number> {
    const result = this.db.prepare("DELETE FROM continuation_reservations WHERE expires_at <= ?").run(now.toISOString());
    return Number(result.changes ?? 0);
  }

  async appendLedgerEvent(event: GoalLedgerEvent): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_ledger (event_id, session_key, goal_id, type, at, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId ?? fallbackEventId(event),
        event.sessionKey,
        event.goalId ?? null,
        event.type,
        event.at,
        event.details === undefined ? null : JSON.stringify(event.details),
      );
  }

  async listLedgerEvents(sessionKey: string, goalId?: string): Promise<GoalLedgerEvent[]> {
    const rows = goalId === undefined
      ? this.db
          .prepare("SELECT * FROM goal_ledger WHERE session_key = ? ORDER BY id ASC")
          .all(sessionKey) as unknown as SqliteLedgerRow[]
      : this.db
          .prepare("SELECT * FROM goal_ledger WHERE session_key = ? AND goal_id = ? ORDER BY id ASC")
          .all(sessionKey, goalId) as unknown as SqliteLedgerRow[];
    return rows.map(rowToLedgerEvent);
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS goals (
        session_key TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        token_budget INTEGER,
        tokens_used INTEGER NOT NULL DEFAULT 0,
        time_used_seconds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        goal_turns_since_audit_reset INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS continuation_reservations (
        session_key TEXT PRIMARY KEY,
        attempt_id TEXT NOT NULL,
        goal_id TEXT NOT NULL,
        goal_updated_at TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        host_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_key TEXT NOT NULL,
        goal_id TEXT,
        type TEXT NOT NULL,
        at TEXT NOT NULL,
        details_json TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_goal_ledger_session_goal ON goal_ledger(session_key, goal_id, id);
    `);
  }
}

function rowToGoal(row: SqliteGoalRow): GoalRecord {
  return {
    sessionKey: row.session_key,
    goalId: row.goal_id,
    objective: row.objective,
    status: row.status,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    goalTurnsSinceAuditReset: row.goal_turns_since_audit_reset,
  };
}

function rowToReservation(row: SqliteReservationRow): ContinuationReservation {
  return {
    sessionKey: row.session_key,
    attemptId: row.attempt_id,
    goalId: row.goal_id,
    goalUpdatedAt: row.goal_updated_at,
    attemptCount: row.attempt_count,
    status: row.status,
    hostTurnId: row.host_turn_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function rowToLedgerEvent(row: SqliteLedgerRow): GoalLedgerEvent {
  return {
    eventId: row.event_id,
    sessionKey: row.session_key,
    goalId: row.goal_id ?? undefined,
    type: row.type,
    at: row.at,
    details: parseDetails(row.details_json),
  };
}

function parseDetails(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function fallbackEventId(event: GoalLedgerEvent): string {
  return `${event.at}:${event.sessionKey}:${event.goalId ?? "none"}:${event.type}:${Math.random().toString(36).slice(2)}`;
}
