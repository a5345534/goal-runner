import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDefaultStateRoot } from "./state-root.js";
import type { GoalControllerAuditDecision } from "./controller-audit.js";
import type { GoalAuditDecisionRecord } from "./memory-store.js";
import type {
  BranchVerificationStatus,
  ContinuationReservation,
  GoalDagNode,
  GoalLedgerEvent,
  GoalRecord,
  GoalSessionMetadata,
  GoalStore,
  GoalSubagentRecord,
  GoalSummary,
  WorkspaceProfile,
  WorkspaceProfileKind,
  WorkspaceStatus,
} from "./types.js";

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

interface SqliteMetadataRow {
  session_key: string;
  goal_id: string;
  origin_session_key: string | null;
  execution_workspace: string | null;
  workspace_status: WorkspaceStatus | null;
  branch: string | null;
  ref: string | null;
  promotion_target_ref: string | null;
  branch_verification_status: BranchVerificationStatus | null;
  session_file: string | null;
  session_name: string | null;
  controller_model_scenario: string | null;
  controller_model_class: string | null;
  controller_model_arg: string | null;
  controller_model_resolution_json: string | null;
  legacy_session_bound: number;
  created_at: string;
  updated_at: string;
}

interface SqliteGoalSummaryRow extends SqliteGoalRow {
  origin_session_key: string | null;
  execution_workspace: string | null;
  workspace_status: WorkspaceStatus | null;
  branch: string | null;
  ref: string | null;
  promotion_target_ref: string | null;
  branch_verification_status: BranchVerificationStatus | null;
  session_file: string | null;
  session_name: string | null;
  controller_model_scenario: string | null;
  controller_model_class: string | null;
  controller_model_arg: string | null;
  controller_model_resolution_json: string | null;
  legacy_session_bound: number | null;
  metadata_updated_at: string | null;
  last_activity_at: string | null;
}

interface SqliteWorkspaceProfileRow {
  name: string;
  path: string;
  kind: WorkspaceProfileKind;
  branch: string | null;
  ref: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteDagNodeRow {
  goal_id: string;
  node_id: string;
  slug: string;
  objective: string;
  scope: string | null;
  kind: string | null;
  validation_json: string | null;
  quality_profiles_json: string | null;
  dependency_node_ids_json: string;
  expected_outputs_json: string;
  validators_json: string;
  workspace_strategy: string | null;
  workspace_json: string | null;
  risk: GoalDagNode["risk"] | null;
  model_scenario: string | null;
  model_class: string | null;
  model_arg: string | null;
  model_resolution_json: string | null;
  thinking_level: string | null;
  conflict_hints_json: string | null;
  completion_gates_json: string;
  status: GoalDagNode["status"];
  lifecycle_phase: GoalDagNode["lifecyclePhase"] | null;
  prepared_resources_json: string | null;
  last_adapter_observation_json: string | null;
  last_recovery_decision_json: string | null;
  last_validation_summary: string | null;
  created_at: string;
  updated_at: string;
}

interface SqliteSubagentRow {
  goal_id: string;
  node_id: string;
  subagent_id: string;
  harness_adapter_id: string;
  session_id: string | null;
  session_file: string | null;
  workspace_path: string | null;
  branch: string | null;
  ref: string | null;
  status: GoalSubagentRecord["status"];
  prompts_json: string;
  last_activity_at: string | null;
  self_reported_result: string | null;
  controller_validation_results_json: string | null;
  commit_sha: string | null;
  integration_status: string | null;
  integration_state: GoalSubagentRecord["integrationState"] | null;
  integration_source_branch: string | null;
  integration_source_ref: string | null;
  integration_source_head: string | null;
  integration_commit_sha: string | null;
  integration_error: string | null;
  integration_completed_at: string | null;
  retry_count: number | null;
  attempt_id: string | null;
  attempt_started_at: string | null;
  attempt_cursor_json: string | null;
  last_action_attempt_json: string | null;
  recovery_loop_signature: string | null;
  last_adapter_observation_json: string | null;
  last_recovery_decision_json: string | null;
  created_at: string;
  updated_at: string;
}

export class SQLiteGoalStore implements GoalStore {
  readonly dbPath: string;
  private db: DatabaseSync;

  constructor(options: { stateRoot?: string; dbPath?: string } = {}) {
    this.dbPath = options.dbPath ? resolve(options.dbPath) : resolve(resolveDefaultStateRoot(options.stateRoot), "goals.sqlite");
    mkdirSync(dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.configureConnection();
    this.migrate();
  }

  private configureConnection(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 10000");
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

  async saveGoalSessionMetadata(metadata: GoalSessionMetadata): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_session_metadata (
          session_key, goal_id, origin_session_key, execution_workspace, workspace_status,
          branch, ref, promotion_target_ref, branch_verification_status, session_file, session_name,
          controller_model_scenario, controller_model_class, controller_model_arg, controller_model_resolution_json,
          legacy_session_bound, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          goal_id = excluded.goal_id,
          origin_session_key = excluded.origin_session_key,
          execution_workspace = excluded.execution_workspace,
          workspace_status = excluded.workspace_status,
          branch = excluded.branch,
          ref = excluded.ref,
          promotion_target_ref = excluded.promotion_target_ref,
          branch_verification_status = excluded.branch_verification_status,
          session_file = excluded.session_file,
          session_name = excluded.session_name,
          controller_model_scenario = excluded.controller_model_scenario,
          controller_model_class = excluded.controller_model_class,
          controller_model_arg = excluded.controller_model_arg,
          controller_model_resolution_json = excluded.controller_model_resolution_json,
          legacy_session_bound = excluded.legacy_session_bound,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`,
      )
      .run(
        metadata.sessionKey,
        metadata.goalId,
        metadata.originSessionKey ?? null,
        metadata.executionWorkspace ?? null,
        metadata.workspaceStatus ?? null,
        metadata.branch ?? null,
        metadata.ref ?? null,
        metadata.promotionTargetRef ?? null,
        metadata.branchVerificationStatus ?? null,
        metadata.sessionFile ?? null,
        metadata.sessionName ?? null,
        metadata.controllerModelScenario ?? null,
        metadata.controllerModelClass ?? null,
        metadata.controllerModelArg ?? null,
        metadata.controllerModelResolution === undefined ? null : JSON.stringify(metadata.controllerModelResolution),
        metadata.legacySessionBound ? 1 : 0,
        metadata.createdAt,
        metadata.updatedAt,
      );
  }

  async getGoalSessionMetadata(sessionKey: string): Promise<GoalSessionMetadata | undefined> {
    const row = this.db.prepare("SELECT * FROM goal_session_metadata WHERE session_key = ?").get(sessionKey) as SqliteMetadataRow | undefined;
    return row ? rowToMetadata(row) : undefined;
  }

  async listGoalSummaries(): Promise<GoalSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT g.*,
          m.origin_session_key,
          m.execution_workspace,
          m.workspace_status,
          m.branch,
          m.ref,
          m.promotion_target_ref,
          m.branch_verification_status,
          m.session_file,
          m.session_name,
          m.controller_model_scenario,
          m.controller_model_class,
          m.controller_model_arg,
          m.controller_model_resolution_json,
          m.legacy_session_bound,
          m.updated_at AS metadata_updated_at,
          COALESCE(MAX(l.at), g.updated_at) AS last_activity_at
        FROM goals g
        LEFT JOIN goal_session_metadata m ON m.session_key = g.session_key
        LEFT JOIN goal_ledger l ON l.session_key = g.session_key AND (l.goal_id = g.goal_id OR l.goal_id IS NULL)
        GROUP BY g.session_key
        ORDER BY last_activity_at DESC`,
      )
      .all() as unknown as SqliteGoalSummaryRow[];
    return rows.map(rowToGoalSummary);
  }

  async saveGoalDagNode(node: GoalDagNode): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_dag_nodes (
          goal_id, node_id, slug, objective, scope, kind, validation_json, quality_profiles_json, dependency_node_ids_json,
          expected_outputs_json, validators_json, workspace_strategy, workspace_json, risk,
          model_scenario, model_class, model_arg, model_resolution_json, thinking_level, conflict_hints_json, completion_gates_json, status,
          lifecycle_phase, prepared_resources_json, last_adapter_observation_json, last_recovery_decision_json,
          last_validation_summary, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, node_id) DO UPDATE SET
          slug = excluded.slug,
          objective = excluded.objective,
          scope = excluded.scope,
          kind = excluded.kind,
          validation_json = excluded.validation_json,
          quality_profiles_json = excluded.quality_profiles_json,
          dependency_node_ids_json = excluded.dependency_node_ids_json,
          expected_outputs_json = excluded.expected_outputs_json,
          validators_json = excluded.validators_json,
          workspace_strategy = excluded.workspace_strategy,
          workspace_json = excluded.workspace_json,
          risk = excluded.risk,
          model_scenario = excluded.model_scenario,
          model_class = excluded.model_class,
          model_arg = excluded.model_arg,
          model_resolution_json = excluded.model_resolution_json,
          thinking_level = excluded.thinking_level,
          conflict_hints_json = excluded.conflict_hints_json,
          completion_gates_json = excluded.completion_gates_json,
          status = excluded.status,
          lifecycle_phase = excluded.lifecycle_phase,
          prepared_resources_json = excluded.prepared_resources_json,
          last_adapter_observation_json = excluded.last_adapter_observation_json,
          last_recovery_decision_json = excluded.last_recovery_decision_json,
          last_validation_summary = excluded.last_validation_summary,
          updated_at = excluded.updated_at`,
      )
      .run(
        node.goalId,
        node.nodeId,
        node.slug,
        node.objective,
        node.scope ?? null,
        node.kind ?? null,
        node.validation === undefined ? null : JSON.stringify(node.validation),
        node.qualityProfiles === undefined ? null : JSON.stringify(node.qualityProfiles),
        JSON.stringify(node.dependencyNodeIds),
        JSON.stringify(node.expectedOutputs),
        JSON.stringify(node.validators),
        node.workspaceStrategy ?? null,
        node.workspace === undefined ? null : JSON.stringify(node.workspace),
        node.risk ?? null,
        node.modelScenario ?? null,
        node.modelClass ?? null,
        node.modelArg ?? null,
        node.modelResolution === undefined ? null : JSON.stringify(node.modelResolution),
        node.thinkingLevel ?? null,
        node.conflictHints === undefined ? null : JSON.stringify(node.conflictHints),
        JSON.stringify(node.completionGates),
        node.status,
        node.lifecyclePhase ?? null,
        node.preparedResources === undefined ? null : JSON.stringify(node.preparedResources),
        node.lastAdapterObservation === undefined ? null : JSON.stringify(node.lastAdapterObservation),
        node.lastRecoveryDecision === undefined ? null : JSON.stringify(node.lastRecoveryDecision),
        node.lastValidationSummary ?? null,
        node.createdAt,
        node.updatedAt,
      );
  }

  async getGoalDagNode(goalId: string, nodeId: string): Promise<GoalDagNode | undefined> {
    const row = this.db
      .prepare("SELECT * FROM goal_dag_nodes WHERE goal_id = ? AND node_id = ?")
      .get(goalId, nodeId) as SqliteDagNodeRow | undefined;
    return row ? rowToDagNode(row) : undefined;
  }

  async listGoalDagNodes(goalId: string): Promise<GoalDagNode[]> {
    const rows = this.db
      .prepare("SELECT * FROM goal_dag_nodes WHERE goal_id = ? ORDER BY created_at ASC, node_id ASC")
      .all(goalId) as unknown as SqliteDagNodeRow[];
    return rows.map(rowToDagNode);
  }

  async saveGoalSubagent(subagent: GoalSubagentRecord): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO goal_subagents (
          goal_id, node_id, subagent_id, harness_adapter_id, session_id,
          session_file, workspace_path, branch, ref, status, prompts_json,
          last_activity_at, self_reported_result, controller_validation_results_json,
          commit_sha, integration_status, integration_state, integration_source_branch,
          integration_source_ref, integration_source_head, integration_commit_sha,
          integration_error, integration_completed_at, retry_count, attempt_id,
          attempt_started_at, attempt_cursor_json, last_action_attempt_json,
          recovery_loop_signature, last_adapter_observation_json, last_recovery_decision_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, subagent_id) DO UPDATE SET
          node_id = excluded.node_id,
          harness_adapter_id = excluded.harness_adapter_id,
          session_id = excluded.session_id,
          session_file = excluded.session_file,
          workspace_path = excluded.workspace_path,
          branch = excluded.branch,
          ref = excluded.ref,
          status = excluded.status,
          prompts_json = excluded.prompts_json,
          last_activity_at = excluded.last_activity_at,
          self_reported_result = excluded.self_reported_result,
          controller_validation_results_json = excluded.controller_validation_results_json,
          commit_sha = excluded.commit_sha,
          integration_status = excluded.integration_status,
          integration_state = excluded.integration_state,
          integration_source_branch = excluded.integration_source_branch,
          integration_source_ref = excluded.integration_source_ref,
          integration_source_head = excluded.integration_source_head,
          integration_commit_sha = excluded.integration_commit_sha,
          integration_error = excluded.integration_error,
          integration_completed_at = excluded.integration_completed_at,
          retry_count = excluded.retry_count,
          attempt_id = excluded.attempt_id,
          attempt_started_at = excluded.attempt_started_at,
          attempt_cursor_json = excluded.attempt_cursor_json,
          last_action_attempt_json = excluded.last_action_attempt_json,
          recovery_loop_signature = excluded.recovery_loop_signature,
          last_adapter_observation_json = excluded.last_adapter_observation_json,
          last_recovery_decision_json = excluded.last_recovery_decision_json,
          updated_at = excluded.updated_at`,
      )
      .run(
        subagent.goalId,
        subagent.nodeId,
        subagent.subagentId,
        subagent.harnessAdapterId,
        subagent.sessionId ?? null,
        subagent.sessionFile ?? null,
        subagent.workspacePath ?? null,
        subagent.branch ?? null,
        subagent.ref ?? null,
        subagent.status,
        JSON.stringify(subagent.prompts),
        subagent.lastActivityAt ?? null,
        subagent.selfReportedResult ?? null,
        subagent.controllerValidationResults === undefined ? null : JSON.stringify(subagent.controllerValidationResults),
        subagent.commitSha ?? null,
        subagent.integrationStatus ?? null,
        subagent.integrationState ?? null,
        subagent.integrationSourceBranch ?? null,
        subagent.integrationSourceRef ?? null,
        subagent.integrationSourceHead ?? null,
        subagent.integrationCommitSha ?? null,
        subagent.integrationError ?? null,
        subagent.integrationCompletedAt ?? null,
        subagent.retryCount ?? null,
        subagent.attemptId ?? null,
        subagent.attemptStartedAt ?? null,
        subagent.attemptCursor === undefined ? null : JSON.stringify(subagent.attemptCursor),
        subagent.lastActionAttempt === undefined ? null : JSON.stringify(subagent.lastActionAttempt),
        subagent.recoveryLoopSignature ?? null,
        subagent.lastAdapterObservation === undefined ? null : JSON.stringify(subagent.lastAdapterObservation),
        subagent.lastRecoveryDecision === undefined ? null : JSON.stringify(subagent.lastRecoveryDecision),
        subagent.createdAt,
        subagent.updatedAt,
      );
  }

  async getGoalSubagent(goalId: string, subagentId: string): Promise<GoalSubagentRecord | undefined> {
    const row = this.db
      .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? AND subagent_id = ?")
      .get(goalId, subagentId) as SqliteSubagentRow | undefined;
    return row ? rowToSubagent(row) : undefined;
  }

  async listGoalSubagents(goalId: string, nodeId?: string): Promise<GoalSubagentRecord[]> {
    const rows = nodeId === undefined
      ? this.db
          .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? ORDER BY created_at ASC, subagent_id ASC")
          .all(goalId) as unknown as SqliteSubagentRow[]
      : this.db
          .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? AND node_id = ? ORDER BY created_at ASC, subagent_id ASC")
          .all(goalId, nodeId) as unknown as SqliteSubagentRow[];
    return rows.map(rowToSubagent);
  }

  async saveWorkspaceProfile(profile: WorkspaceProfile): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO workspace_profiles (name, path, kind, branch, ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           kind = excluded.kind,
           branch = excluded.branch,
           ref = excluded.ref,
           updated_at = excluded.updated_at`,
      )
      .run(profile.name, profile.path, profile.kind, profile.branch ?? null, profile.ref ?? null, profile.createdAt, profile.updatedAt);
  }

  async getWorkspaceProfile(name: string): Promise<WorkspaceProfile | undefined> {
    const row = this.db.prepare("SELECT * FROM workspace_profiles WHERE name = ?").get(name) as SqliteWorkspaceProfileRow | undefined;
    return row ? rowToWorkspaceProfile(row) : undefined;
  }

  async listWorkspaceProfiles(): Promise<WorkspaceProfile[]> {
    const rows = this.db.prepare("SELECT * FROM workspace_profiles ORDER BY name ASC").all() as unknown as SqliteWorkspaceProfileRow[];
    return rows.map(rowToWorkspaceProfile);
  }

  async deleteWorkspaceProfile(name: string): Promise<boolean> {
    const result = this.db.prepare("DELETE FROM workspace_profiles WHERE name = ?").run(name);
    return Number(result.changes ?? 0) > 0;
  }

  async pruneLedgerEvents(goalId: string, options: { maxEvents: number }): Promise<number> {
    const countRow = this.db.prepare("SELECT COUNT(*) AS cnt FROM goal_ledger WHERE goal_id = ?").get(goalId) as { cnt?: number } | undefined;
    const total = countRow?.cnt ?? 0;
    if (total <= options.maxEvents) return 0;
    const excess = total - options.maxEvents;
    const result = this.db.prepare(
      `DELETE FROM goal_ledger WHERE id IN (
        SELECT id FROM goal_ledger WHERE goal_id = ? ORDER BY id ASC LIMIT ?
      )`,
    ).run(goalId, excess);
    return Number(result.changes ?? 0);
  }

  /**
   * Returns the latest controller audit decision and applied action names,
   * or `undefined` when no audit has completed for this goal.
   */
  async getLatestAuditDecision(goalId: string): Promise<GoalAuditDecisionRecord | undefined> {
    const rows = this.db
      .prepare(
        `SELECT type, at, details_json FROM goal_ledger
         WHERE goal_id = ? AND type IN ('controller_audit_finished', 'controller_audit_action_applied')
         ORDER BY id ASC`,
      )
      .all(goalId) as unknown as Array<{ type: string; at: string; details_json: string | null }>;

    // Walk forward to find the latest finished event and collect trailing applied actions.
    let latestFinished: { at: string; details: Record<string, unknown> } | undefined;
    let appliedActionNames: string[] = [];

    for (const row of rows) {
      const details = parseDetails(row.details_json) ?? {};
      if (row.type === "controller_audit_finished") {
        latestFinished = { at: row.at, details };
        appliedActionNames = [];
      } else if (row.type === "controller_audit_action_applied" && latestFinished && row.at >= latestFinished.at) {
        const actionName = (details.action as string) ?? "pause-goal";
        appliedActionNames.push(actionName);
      }
    }

    if (!latestFinished) return undefined;
    const decision = latestFinished.details as unknown as GoalControllerAuditDecision;
    if (!decision.risk || !decision.summary) return undefined;

    return { decision, finishedAt: latestFinished.at, appliedActionNames };
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
      CREATE TABLE IF NOT EXISTS goal_session_metadata (
        session_key TEXT PRIMARY KEY,
        goal_id TEXT NOT NULL,
        origin_session_key TEXT,
        execution_workspace TEXT,
        workspace_status TEXT,
        branch TEXT,
        ref TEXT,
        promotion_target_ref TEXT,
        branch_verification_status TEXT,
        session_file TEXT,
        session_name TEXT,
        controller_model_scenario TEXT,
        controller_model_class TEXT,
        controller_model_arg TEXT,
        controller_model_resolution_json TEXT,
        legacy_session_bound INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_goal_session_metadata_goal_id ON goal_session_metadata(goal_id);
      CREATE TABLE IF NOT EXISTS workspace_profiles (
        name TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        kind TEXT NOT NULL,
        branch TEXT,
        ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS goal_dag_nodes (
        goal_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        objective TEXT NOT NULL,
        scope TEXT,
        kind TEXT,
        validation_json TEXT,
        quality_profiles_json TEXT,
        dependency_node_ids_json TEXT NOT NULL,
        expected_outputs_json TEXT NOT NULL,
        validators_json TEXT NOT NULL,
        workspace_strategy TEXT,
        workspace_json TEXT,
        risk TEXT,
        model_scenario TEXT,
        model_class TEXT,
        model_arg TEXT,
        model_resolution_json TEXT,
        thinking_level TEXT,
        conflict_hints_json TEXT,
        completion_gates_json TEXT NOT NULL,
        status TEXT NOT NULL,
        lifecycle_phase TEXT,
        prepared_resources_json TEXT,
        last_adapter_observation_json TEXT,
        last_recovery_decision_json TEXT,
        last_validation_summary TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, node_id)
      );
      CREATE INDEX IF NOT EXISTS idx_goal_dag_nodes_goal_status ON goal_dag_nodes(goal_id, status, created_at);
      CREATE TABLE IF NOT EXISTS goal_subagents (
        goal_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        subagent_id TEXT NOT NULL,
        harness_adapter_id TEXT NOT NULL,
        session_id TEXT,
        session_file TEXT,
        workspace_path TEXT,
        branch TEXT,
        ref TEXT,
        status TEXT NOT NULL,
        prompts_json TEXT NOT NULL,
        last_activity_at TEXT,
        self_reported_result TEXT,
        controller_validation_results_json TEXT,
        commit_sha TEXT,
        integration_status TEXT,
        integration_state TEXT,
        integration_source_branch TEXT,
        integration_source_ref TEXT,
        integration_source_head TEXT,
        integration_commit_sha TEXT,
        integration_error TEXT,
        integration_completed_at TEXT,
        retry_count INTEGER,
        attempt_id TEXT,
        attempt_started_at TEXT,
        attempt_cursor_json TEXT,
        last_action_attempt_json TEXT,
        recovery_loop_signature TEXT,
        last_adapter_observation_json TEXT,
        last_recovery_decision_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, subagent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_goal_subagents_goal_node ON goal_subagents(goal_id, node_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_goal_subagents_goal_status ON goal_subagents(goal_id, status, updated_at);
    `);
    addColumnIfMissing(this.db, "goal_dag_nodes", "model_scenario", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "model_class", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "model_arg", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "model_resolution_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "thinking_level", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "workspace_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "kind", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "validation_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "quality_profiles_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "lifecycle_phase", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "prepared_resources_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "last_adapter_observation_json", "TEXT");
    addColumnIfMissing(this.db, "goal_dag_nodes", "last_recovery_decision_json", "TEXT");
    addColumnIfMissing(this.db, "goal_session_metadata", "promotion_target_ref", "TEXT");
    addColumnIfMissing(this.db, "goal_session_metadata", "controller_model_scenario", "TEXT");
    addColumnIfMissing(this.db, "goal_session_metadata", "controller_model_class", "TEXT");
    addColumnIfMissing(this.db, "goal_session_metadata", "controller_model_arg", "TEXT");
    addColumnIfMissing(this.db, "goal_session_metadata", "controller_model_resolution_json", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "retry_count", "INTEGER");
    addColumnIfMissing(this.db, "goal_subagents", "integration_state", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_source_branch", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_source_ref", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_source_head", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_commit_sha", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_error", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "integration_completed_at", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "attempt_id", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "attempt_started_at", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "attempt_cursor_json", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "last_action_attempt_json", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "recovery_loop_signature", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "last_adapter_observation_json", "TEXT");
    addColumnIfMissing(this.db, "goal_subagents", "last_recovery_decision_json", "TEXT");
  }
}

function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
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

function rowToMetadata(row: SqliteMetadataRow): GoalSessionMetadata {
  return {
    sessionKey: row.session_key,
    goalId: row.goal_id,
    originSessionKey: row.origin_session_key ?? undefined,
    executionWorkspace: row.execution_workspace ?? undefined,
    workspaceStatus: row.workspace_status ?? undefined,
    branch: row.branch ?? undefined,
    ref: row.ref ?? undefined,
    promotionTargetRef: row.promotion_target_ref ?? undefined,
    branchVerificationStatus: row.branch_verification_status ?? undefined,
    sessionFile: row.session_file ?? undefined,
    sessionName: row.session_name ?? undefined,
    controllerModelScenario: row.controller_model_scenario ?? undefined,
    controllerModelClass: row.controller_model_class ?? undefined,
    controllerModelArg: row.controller_model_arg ?? undefined,
    controllerModelResolution: parseRecord(row.controller_model_resolution_json) as GoalSessionMetadata["controllerModelResolution"] | undefined,
    legacySessionBound: row.legacy_session_bound === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToGoalSummary(row: SqliteGoalSummaryRow): GoalSummary {
  return {
    sessionKey: row.session_key,
    goalId: row.goal_id,
    shortGoalId: row.goal_id.slice(0, 8),
    objective: row.objective,
    objectiveSummary: summarizeObjective(row.objective),
    status: row.status,
    activityState: row.status === "active" ? "idle-eligible" : row.status,
    tokenBudget: row.token_budget ?? undefined,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActivityAt: row.last_activity_at ?? row.updated_at,
    originSessionKey: row.origin_session_key ?? undefined,
    executionWorkspace: row.execution_workspace ?? undefined,
    workspaceStatus: row.workspace_status ?? (row.origin_session_key ? undefined : "legacy"),
    branch: row.branch ?? undefined,
    ref: row.ref ?? undefined,
    promotionTargetRef: row.promotion_target_ref ?? undefined,
    branchVerificationStatus: row.branch_verification_status ?? undefined,
    sessionFile: row.session_file ?? undefined,
    sessionName: row.session_name ?? undefined,
    controllerModelScenario: row.controller_model_scenario ?? undefined,
    controllerModelClass: row.controller_model_class ?? undefined,
    controllerModelArg: row.controller_model_arg ?? undefined,
    controllerModelResolution: parseRecord(row.controller_model_resolution_json) as GoalSummary["controllerModelResolution"] | undefined,
    legacySessionBound: row.legacy_session_bound === null ? true : row.legacy_session_bound === 1,
  };
}

function rowToWorkspaceProfile(row: SqliteWorkspaceProfileRow): WorkspaceProfile {
  return {
    name: row.name,
    path: row.path,
    kind: row.kind,
    branch: row.branch ?? undefined,
    ref: row.ref ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDagNode(row: SqliteDagNodeRow): GoalDagNode {
  return {
    goalId: row.goal_id,
    nodeId: row.node_id,
    slug: row.slug,
    objective: row.objective,
    scope: row.scope ?? undefined,
    kind: row.kind ?? undefined,
    validation: parseValidationContract(row.validation_json),
    qualityProfiles: parseQualityProfiles(row.quality_profiles_json),
    dependencyNodeIds: parseStringArray(row.dependency_node_ids_json),
    expectedOutputs: parseStringArray(row.expected_outputs_json),
    validators: parseStringArray(row.validators_json),
    workspaceStrategy: row.workspace_strategy ?? undefined,
    workspace: parseWorkspaceBinding(row.workspace_json),
    risk: row.risk ?? undefined,
    modelScenario: row.model_scenario ?? undefined,
    modelClass: row.model_class ?? undefined,
    modelArg: row.model_arg ?? undefined,
    modelResolution: parseRecord(row.model_resolution_json) as GoalDagNode["modelResolution"] | undefined,
    thinkingLevel: row.thinking_level ?? undefined,
    conflictHints: parseConflictHints(row.conflict_hints_json),
    completionGates: parseStringArray(row.completion_gates_json),
    status: row.status,
    lifecyclePhase: row.lifecycle_phase ?? undefined,
    preparedResources: parseRecord(row.prepared_resources_json) as GoalDagNode["preparedResources"] | undefined,
    lastAdapterObservation: parseRecord(row.last_adapter_observation_json) as GoalDagNode["lastAdapterObservation"] | undefined,
    lastRecoveryDecision: parseRecord(row.last_recovery_decision_json) as GoalDagNode["lastRecoveryDecision"] | undefined,
    lastValidationSummary: row.last_validation_summary ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSubagent(row: SqliteSubagentRow): GoalSubagentRecord {
  return {
    goalId: row.goal_id,
    nodeId: row.node_id,
    subagentId: row.subagent_id,
    harnessAdapterId: row.harness_adapter_id,
    sessionId: row.session_id ?? undefined,
    sessionFile: row.session_file ?? undefined,
    workspacePath: row.workspace_path ?? undefined,
    branch: row.branch ?? undefined,
    ref: row.ref ?? undefined,
    status: row.status,
    prompts: parseStringArray(row.prompts_json),
    lastActivityAt: row.last_activity_at ?? undefined,
    selfReportedResult: row.self_reported_result ?? undefined,
    controllerValidationResults: row.controller_validation_results_json ? parseStringArray(row.controller_validation_results_json) : undefined,
    commitSha: row.commit_sha ?? undefined,
    integrationStatus: row.integration_status ?? undefined,
    integrationState: row.integration_state ?? undefined,
    integrationSourceBranch: row.integration_source_branch ?? undefined,
    integrationSourceRef: row.integration_source_ref ?? undefined,
    integrationSourceHead: row.integration_source_head ?? undefined,
    integrationCommitSha: row.integration_commit_sha ?? undefined,
    integrationError: row.integration_error ?? undefined,
    integrationCompletedAt: row.integration_completed_at ?? undefined,
    retryCount: row.retry_count ?? undefined,
    attemptId: row.attempt_id ?? undefined,
    attemptStartedAt: row.attempt_started_at ?? undefined,
    attemptCursor: parseRecord(row.attempt_cursor_json) as GoalSubagentRecord["attemptCursor"] | undefined,
    lastActionAttempt: parseRecord(row.last_action_attempt_json) as GoalSubagentRecord["lastActionAttempt"] | undefined,
    recoveryLoopSignature: row.recovery_loop_signature ?? undefined,
    lastAdapterObservation: parseRecord(row.last_adapter_observation_json) as GoalSubagentRecord["lastAdapterObservation"] | undefined,
    lastRecoveryDecision: parseRecord(row.last_recovery_decision_json) as GoalSubagentRecord["lastRecoveryDecision"] | undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseDetails(json: string | null): Record<string, unknown> | undefined {
  return parseRecord(json);
}

function parseRecord(json: string | null): Record<string, unknown> | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function parseWorkspaceBinding(json: string | null): GoalDagNode["workspace"] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as GoalDagNode["workspace"] : undefined;
  } catch {
    return undefined;
  }
}

function parseValidationContract(json: string | null): GoalDagNode["validation"] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    return parsed as GoalDagNode["validation"];
  } catch {
    return undefined;
  }
}

function parseQualityProfiles(json: string | null): GoalDagNode["qualityProfiles"] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const profiles = parsed.filter((value): value is string => typeof value === "string");
    return profiles.length > 0 ? profiles as GoalDagNode["qualityProfiles"] : undefined;
  } catch {
    return undefined;
  }
}

function parseConflictHints(json: string | null): GoalDagNode["conflictHints"] | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    return {
      files: Array.isArray(record.files) ? record.files.filter((value): value is string => typeof value === "string") : undefined,
      modules: Array.isArray(record.modules) ? record.modules.filter((value): value is string => typeof value === "string") : undefined,
      capabilities: Array.isArray(record.capabilities) ? record.capabilities.filter((value): value is string => typeof value === "string") : undefined,
    };
  } catch {
    return undefined;
  }
}

function fallbackEventId(event: GoalLedgerEvent): string {
  return `${event.at}:${event.sessionKey}:${event.goalId ?? "none"}:${event.type}:${Math.random().toString(36).slice(2)}`;
}

function summarizeObjective(objective: string): string {
  return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
