import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveDefaultStateRoot } from "./state-root.js";
export class SQLiteGoalStore {
    dbPath;
    db;
    constructor(options = {}) {
        this.dbPath = options.dbPath ? resolve(options.dbPath) : resolve(resolveDefaultStateRoot(options.stateRoot), "goals.sqlite");
        mkdirSync(dirname(this.dbPath), { recursive: true });
        this.db = new DatabaseSync(this.dbPath);
        this.migrate();
    }
    async getCurrentGoal(sessionKey) {
        const row = this.db.prepare("SELECT * FROM goals WHERE session_key = ?").get(sessionKey);
        return row ? rowToGoal(row) : undefined;
    }
    async saveGoal(goal) {
        this.db
            .prepare(`INSERT INTO goals (
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
          goal_turns_since_audit_reset = excluded.goal_turns_since_audit_reset`)
            .run(goal.sessionKey, goal.goalId, goal.objective, goal.status, goal.tokenBudget ?? null, goal.tokensUsed, goal.timeUsedSeconds, goal.createdAt, goal.updatedAt, goal.goalTurnsSinceAuditReset);
    }
    async clearGoal(sessionKey) {
        this.db.prepare("DELETE FROM goals WHERE session_key = ?").run(sessionKey);
        this.db.prepare("DELETE FROM continuation_reservations WHERE session_key = ?").run(sessionKey);
    }
    async getReservation(sessionKey) {
        const row = this.db
            .prepare("SELECT * FROM continuation_reservations WHERE session_key = ?")
            .get(sessionKey);
        return row ? rowToReservation(row) : undefined;
    }
    async saveReservation(reservation) {
        this.db
            .prepare(`INSERT INTO continuation_reservations (
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
          expires_at = excluded.expires_at`)
            .run(reservation.sessionKey, reservation.attemptId, reservation.goalId, reservation.goalUpdatedAt, reservation.attemptCount, reservation.status, reservation.hostTurnId ?? null, reservation.createdAt, reservation.updatedAt, reservation.expiresAt);
    }
    async clearReservation(sessionKey) {
        this.db.prepare("DELETE FROM continuation_reservations WHERE session_key = ?").run(sessionKey);
    }
    async clearExpiredReservations(now = new Date()) {
        const result = this.db.prepare("DELETE FROM continuation_reservations WHERE expires_at <= ?").run(now.toISOString());
        return Number(result.changes ?? 0);
    }
    async appendLedgerEvent(event) {
        this.db
            .prepare(`INSERT INTO goal_ledger (event_id, session_key, goal_id, type, at, details_json)
         VALUES (?, ?, ?, ?, ?, ?)`)
            .run(event.eventId ?? fallbackEventId(event), event.sessionKey, event.goalId ?? null, event.type, event.at, event.details === undefined ? null : JSON.stringify(event.details));
    }
    async listLedgerEvents(sessionKey, goalId) {
        const rows = goalId === undefined
            ? this.db
                .prepare("SELECT * FROM goal_ledger WHERE session_key = ? ORDER BY id ASC")
                .all(sessionKey)
            : this.db
                .prepare("SELECT * FROM goal_ledger WHERE session_key = ? AND goal_id = ? ORDER BY id ASC")
                .all(sessionKey, goalId);
        return rows.map(rowToLedgerEvent);
    }
    async saveGoalSessionMetadata(metadata) {
        this.db
            .prepare(`INSERT INTO goal_session_metadata (
          session_key, goal_id, origin_session_key, execution_workspace, workspace_status,
          branch, ref, branch_verification_status, session_file, session_name,
          legacy_session_bound, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          goal_id = excluded.goal_id,
          origin_session_key = excluded.origin_session_key,
          execution_workspace = excluded.execution_workspace,
          workspace_status = excluded.workspace_status,
          branch = excluded.branch,
          ref = excluded.ref,
          branch_verification_status = excluded.branch_verification_status,
          session_file = excluded.session_file,
          session_name = excluded.session_name,
          legacy_session_bound = excluded.legacy_session_bound,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at`)
            .run(metadata.sessionKey, metadata.goalId, metadata.originSessionKey ?? null, metadata.executionWorkspace ?? null, metadata.workspaceStatus ?? null, metadata.branch ?? null, metadata.ref ?? null, metadata.branchVerificationStatus ?? null, metadata.sessionFile ?? null, metadata.sessionName ?? null, metadata.legacySessionBound ? 1 : 0, metadata.createdAt, metadata.updatedAt);
    }
    async getGoalSessionMetadata(sessionKey) {
        const row = this.db.prepare("SELECT * FROM goal_session_metadata WHERE session_key = ?").get(sessionKey);
        return row ? rowToMetadata(row) : undefined;
    }
    async listGoalSummaries() {
        const rows = this.db
            .prepare(`SELECT g.*,
          m.origin_session_key,
          m.execution_workspace,
          m.workspace_status,
          m.branch,
          m.ref,
          m.branch_verification_status,
          m.session_file,
          m.session_name,
          m.legacy_session_bound,
          m.updated_at AS metadata_updated_at,
          COALESCE(MAX(l.at), g.updated_at) AS last_activity_at
        FROM goals g
        LEFT JOIN goal_session_metadata m ON m.session_key = g.session_key
        LEFT JOIN goal_ledger l ON l.session_key = g.session_key AND (l.goal_id = g.goal_id OR l.goal_id IS NULL)
        GROUP BY g.session_key
        ORDER BY last_activity_at DESC`)
            .all();
        return rows.map(rowToGoalSummary);
    }
    async saveGoalDagNode(node) {
        this.db
            .prepare(`INSERT INTO goal_dag_nodes (
          goal_id, node_id, slug, objective, scope, dependency_node_ids_json,
          expected_outputs_json, validators_json, workspace_strategy, risk,
          model_scenario, model_arg, conflict_hints_json, completion_gates_json, status, last_validation_summary,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(goal_id, node_id) DO UPDATE SET
          slug = excluded.slug,
          objective = excluded.objective,
          scope = excluded.scope,
          dependency_node_ids_json = excluded.dependency_node_ids_json,
          expected_outputs_json = excluded.expected_outputs_json,
          validators_json = excluded.validators_json,
          workspace_strategy = excluded.workspace_strategy,
          risk = excluded.risk,
          model_scenario = excluded.model_scenario,
          model_arg = excluded.model_arg,
          conflict_hints_json = excluded.conflict_hints_json,
          completion_gates_json = excluded.completion_gates_json,
          status = excluded.status,
          last_validation_summary = excluded.last_validation_summary,
          updated_at = excluded.updated_at`)
            .run(node.goalId, node.nodeId, node.slug, node.objective, node.scope ?? null, JSON.stringify(node.dependencyNodeIds), JSON.stringify(node.expectedOutputs), JSON.stringify(node.validators), node.workspaceStrategy ?? null, node.risk ?? null, node.modelScenario ?? null, node.modelArg ?? null, node.conflictHints === undefined ? null : JSON.stringify(node.conflictHints), JSON.stringify(node.completionGates), node.status, node.lastValidationSummary ?? null, node.createdAt, node.updatedAt);
    }
    async getGoalDagNode(goalId, nodeId) {
        const row = this.db
            .prepare("SELECT * FROM goal_dag_nodes WHERE goal_id = ? AND node_id = ?")
            .get(goalId, nodeId);
        return row ? rowToDagNode(row) : undefined;
    }
    async listGoalDagNodes(goalId) {
        const rows = this.db
            .prepare("SELECT * FROM goal_dag_nodes WHERE goal_id = ? ORDER BY created_at ASC, node_id ASC")
            .all(goalId);
        return rows.map(rowToDagNode);
    }
    async saveGoalSubagent(subagent) {
        this.db
            .prepare(`INSERT INTO goal_subagents (
          goal_id, node_id, subagent_id, harness_adapter_id, session_id,
          session_file, workspace_path, branch, ref, status, prompts_json,
          last_activity_at, self_reported_result, controller_validation_results_json,
          commit_sha, integration_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          updated_at = excluded.updated_at`)
            .run(subagent.goalId, subagent.nodeId, subagent.subagentId, subagent.harnessAdapterId, subagent.sessionId ?? null, subagent.sessionFile ?? null, subagent.workspacePath ?? null, subagent.branch ?? null, subagent.ref ?? null, subagent.status, JSON.stringify(subagent.prompts), subagent.lastActivityAt ?? null, subagent.selfReportedResult ?? null, subagent.controllerValidationResults === undefined ? null : JSON.stringify(subagent.controllerValidationResults), subagent.commitSha ?? null, subagent.integrationStatus ?? null, subagent.createdAt, subagent.updatedAt);
    }
    async getGoalSubagent(goalId, subagentId) {
        const row = this.db
            .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? AND subagent_id = ?")
            .get(goalId, subagentId);
        return row ? rowToSubagent(row) : undefined;
    }
    async listGoalSubagents(goalId, nodeId) {
        const rows = nodeId === undefined
            ? this.db
                .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? ORDER BY created_at ASC, subagent_id ASC")
                .all(goalId)
            : this.db
                .prepare("SELECT * FROM goal_subagents WHERE goal_id = ? AND node_id = ? ORDER BY created_at ASC, subagent_id ASC")
                .all(goalId, nodeId);
        return rows.map(rowToSubagent);
    }
    async saveWorkspaceProfile(profile) {
        this.db
            .prepare(`INSERT INTO workspace_profiles (name, path, kind, branch, ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           path = excluded.path,
           kind = excluded.kind,
           branch = excluded.branch,
           ref = excluded.ref,
           updated_at = excluded.updated_at`)
            .run(profile.name, profile.path, profile.kind, profile.branch ?? null, profile.ref ?? null, profile.createdAt, profile.updatedAt);
    }
    async getWorkspaceProfile(name) {
        const row = this.db.prepare("SELECT * FROM workspace_profiles WHERE name = ?").get(name);
        return row ? rowToWorkspaceProfile(row) : undefined;
    }
    async listWorkspaceProfiles() {
        const rows = this.db.prepare("SELECT * FROM workspace_profiles ORDER BY name ASC").all();
        return rows.map(rowToWorkspaceProfile);
    }
    async deleteWorkspaceProfile(name) {
        const result = this.db.prepare("DELETE FROM workspace_profiles WHERE name = ?").run(name);
        return Number(result.changes ?? 0) > 0;
    }
    close() {
        this.db.close();
    }
    migrate() {
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
        branch_verification_status TEXT,
        session_file TEXT,
        session_name TEXT,
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
        dependency_node_ids_json TEXT NOT NULL,
        expected_outputs_json TEXT NOT NULL,
        validators_json TEXT NOT NULL,
        workspace_strategy TEXT,
        risk TEXT,
        model_scenario TEXT,
        model_arg TEXT,
        conflict_hints_json TEXT,
        completion_gates_json TEXT NOT NULL,
        status TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (goal_id, subagent_id)
      );
      CREATE INDEX IF NOT EXISTS idx_goal_subagents_goal_node ON goal_subagents(goal_id, node_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_goal_subagents_goal_status ON goal_subagents(goal_id, status, updated_at);
    `);
        addColumnIfMissing(this.db, "goal_dag_nodes", "model_scenario", "TEXT");
        addColumnIfMissing(this.db, "goal_dag_nodes", "model_arg", "TEXT");
    }
}
function addColumnIfMissing(db, table, column, definition) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    if (rows.some((row) => row.name === column))
        return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
function rowToGoal(row) {
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
function rowToReservation(row) {
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
function rowToLedgerEvent(row) {
    return {
        eventId: row.event_id,
        sessionKey: row.session_key,
        goalId: row.goal_id ?? undefined,
        type: row.type,
        at: row.at,
        details: parseDetails(row.details_json),
    };
}
function rowToMetadata(row) {
    return {
        sessionKey: row.session_key,
        goalId: row.goal_id,
        originSessionKey: row.origin_session_key ?? undefined,
        executionWorkspace: row.execution_workspace ?? undefined,
        workspaceStatus: row.workspace_status ?? undefined,
        branch: row.branch ?? undefined,
        ref: row.ref ?? undefined,
        branchVerificationStatus: row.branch_verification_status ?? undefined,
        sessionFile: row.session_file ?? undefined,
        sessionName: row.session_name ?? undefined,
        legacySessionBound: row.legacy_session_bound === 1,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function rowToGoalSummary(row) {
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
        branchVerificationStatus: row.branch_verification_status ?? undefined,
        sessionFile: row.session_file ?? undefined,
        sessionName: row.session_name ?? undefined,
        legacySessionBound: row.legacy_session_bound === null ? true : row.legacy_session_bound === 1,
    };
}
function rowToWorkspaceProfile(row) {
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
function rowToDagNode(row) {
    return {
        goalId: row.goal_id,
        nodeId: row.node_id,
        slug: row.slug,
        objective: row.objective,
        scope: row.scope ?? undefined,
        dependencyNodeIds: parseStringArray(row.dependency_node_ids_json),
        expectedOutputs: parseStringArray(row.expected_outputs_json),
        validators: parseStringArray(row.validators_json),
        workspaceStrategy: row.workspace_strategy ?? undefined,
        risk: row.risk ?? undefined,
        modelScenario: row.model_scenario ?? undefined,
        modelArg: row.model_arg ?? undefined,
        conflictHints: parseConflictHints(row.conflict_hints_json),
        completionGates: parseStringArray(row.completion_gates_json),
        status: row.status,
        lastValidationSummary: row.last_validation_summary ?? undefined,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function rowToSubagent(row) {
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}
function parseDetails(json) {
    if (!json)
        return undefined;
    try {
        const parsed = JSON.parse(json);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    }
    catch {
        return undefined;
    }
}
function parseStringArray(json) {
    try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((value) => typeof value === "string") : [];
    }
    catch {
        return [];
    }
}
function parseConflictHints(json) {
    if (!json)
        return undefined;
    try {
        const parsed = JSON.parse(json);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return undefined;
        const record = parsed;
        return {
            files: Array.isArray(record.files) ? record.files.filter((value) => typeof value === "string") : undefined,
            modules: Array.isArray(record.modules) ? record.modules.filter((value) => typeof value === "string") : undefined,
            capabilities: Array.isArray(record.capabilities) ? record.capabilities.filter((value) => typeof value === "string") : undefined,
        };
    }
    catch {
        return undefined;
    }
}
function fallbackEventId(event) {
    return `${event.at}:${event.sessionKey}:${event.goalId ?? "none"}:${event.type}:${Math.random().toString(36).slice(2)}`;
}
function summarizeObjective(objective) {
    return objective.length <= 120 ? objective : `${objective.slice(0, 117)}...`;
}
//# sourceMappingURL=sqlite-store.js.map