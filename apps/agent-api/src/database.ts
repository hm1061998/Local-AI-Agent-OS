import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type {
  AgentEvent,
  AgentState,
  TaskRecord,
  SkillManifest,
  SkillRecord,
  SkillCreationProposal,
  AgentMessage,
} from '@local-agent/agent-protocol';
export class AgentDatabase {
  readonly db: Database.Database;
  constructor(path = process.env.DATABASE_PATH ?? './data/local-agent.db') {
    const target = path === ':memory:' ? path : resolve(path);
    if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true });
    this.db = new Database(target);
    this.migrate();
  }
  private migrate() {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,user_input TEXT NOT NULL,state TEXT NOT NULL,result_summary TEXT,error_code TEXT,error_message TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,started_at TEXT,completed_at TEXT,cancelled_at TEXT);CREATE TABLE IF NOT EXISTS task_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,sequence INTEGER NOT NULL,type TEXT NOT NULL,state TEXT NOT NULL,message TEXT NOT NULL,payload_json TEXT,created_at TEXT NOT NULL,UNIQUE(task_id,sequence));CREATE TABLE IF NOT EXISTS skills(id TEXT PRIMARY KEY,manifest_json TEXT NOT NULL,status TEXT DEFAULT 'active',created_by TEXT DEFAULT 'system',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS skill_versions(id TEXT PRIMARY KEY,skill_id TEXT NOT NULL,version TEXT NOT NULL,manifest_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(skill_id,version));CREATE TABLE IF NOT EXISTS skill_embeddings(skill_id TEXT PRIMARY KEY,embedding_json TEXT NOT NULL,model TEXT,updated_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS skill_usage_metrics(skill_id TEXT PRIMARY KEY,success_count INTEGER DEFAULT 0,failure_count INTEGER DEFAULT 0,total_duration_ms INTEGER DEFAULT 0,usage_count INTEGER DEFAULT 0);CREATE TABLE IF NOT EXISTS skill_dependencies(skill_id TEXT NOT NULL,depends_on_skill_id TEXT NOT NULL,PRIMARY KEY(skill_id,depends_on_skill_id));CREATE TABLE IF NOT EXISTS skill_approvals(id TEXT PRIMARY KEY,proposal_json TEXT NOT NULL,status TEXT NOT NULL,decision_scope TEXT,created_at TEXT NOT NULL,decided_at TEXT);CREATE TABLE IF NOT EXISTS skill_executions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,skill_id TEXT NOT NULL,status TEXT NOT NULL,input_json TEXT,output_json TEXT,started_at TEXT,completed_at TEXT);CREATE TABLE IF NOT EXISTS model_calls(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,model TEXT NOT NULL,purpose TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS audit_logs(id TEXT PRIMARY KEY,action TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT,details_json TEXT,created_at TEXT NOT NULL);`,
    );
    this.addColumn('skills', 'status', "TEXT NOT NULL DEFAULT 'active'");
    this.addColumn('skills', 'created_by', "TEXT NOT NULL DEFAULT 'system'");
    this.addColumn('skill_approvals', 'task_id', 'TEXT');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS sandbox_executions(id TEXT PRIMARY KEY,task_id TEXT,skill_id TEXT NOT NULL,runtime TEXT NOT NULL,status TEXT NOT NULL,findings_json TEXT NOT NULL,stdout TEXT,stderr TEXT,container_id TEXT,resource_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);`,
    );
    this.addColumn('sandbox_executions', 'package_json', 'TEXT');
    this.addColumn('sandbox_executions', 'output_json', 'TEXT');
    this.addColumn('sandbox_executions', 'staged_json', 'TEXT');
    this.addColumn('sandbox_executions', 'applied_json', 'TEXT');
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS agent_runs(task_id TEXT PRIMARY KEY,mode TEXT NOT NULL,state TEXT NOT NULL,current_owner TEXT,budget_json TEXT NOT NULL,usage_json TEXT NOT NULL,signals_json TEXT NOT NULL,started_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT);CREATE TABLE IF NOT EXISTS agent_messages(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,correlation_id TEXT NOT NULL,causation_id TEXT,from_role TEXT NOT NULL,to_role TEXT NOT NULL,type TEXT NOT NULL,sequence INTEGER NOT NULL,payload_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(task_id,sequence));CREATE TABLE IF NOT EXISTS agent_assignments(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,role TEXT NOT NULL,status TEXT NOT NULL,summary TEXT,created_at TEXT NOT NULL,completed_at TEXT);CREATE TABLE IF NOT EXISTS system_settings(key TEXT PRIMARY KEY,value_json TEXT NOT NULL,updated_at TEXT NOT NULL);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_permission_requests(id TEXT PRIMARY KEY,task_id TEXT NOT NULL UNIQUE,skill_id TEXT NOT NULL,permissions_json TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,scope TEXT,created_at TEXT NOT NULL,decided_at TEXT);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_permission_requests_v2(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,skill_id TEXT NOT NULL,permissions_json TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL,scope TEXT,created_at TEXT NOT NULL,decided_at TEXT);CREATE INDEX IF NOT EXISTS idx_permission_requests_v2_task ON task_permission_requests_v2(task_id,created_at);`,
    );
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS task_plans(task_id TEXT PRIMARY KEY,plan_json TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,decided_at TEXT);`,
    );
  }
  private addColumn(table: string, column: string, definition: string) {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column))
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  createTask(input: string): TaskRecord {
    const now = new Date().toISOString(),
      task: TaskRecord = {
        id: crypto.randomUUID(),
        title: input.slice(0, 80),
        userInput: input,
        state: 'idle',
        createdAt: now,
        updatedAt: now,
      };
    this.db
      .prepare(
        'INSERT INTO tasks(id,title,user_input,state,created_at,updated_at) VALUES(?,?,?,?,?,?)',
      )
      .run(task.id, task.title, task.userInput, task.state, now, now);
    return task;
  }
  updateTask(
    id: string,
    state: AgentState,
    patch: { resultSummary?: string; errorCode?: string; errorMessage?: string } = {},
  ) {
    const now = new Date().toISOString(),
      terminal = ['completed', 'failed', 'cancelled'].includes(state);
    this.db
      .prepare(
        `UPDATE tasks SET state=?,result_summary=COALESCE(?,result_summary),error_code=COALESCE(?,error_code),error_message=COALESCE(?,error_message),updated_at=?,started_at=COALESCE(started_at,?),completed_at=CASE WHEN ? THEN ? ELSE completed_at END,cancelled_at=CASE WHEN ? THEN ? ELSE cancelled_at END WHERE id=?`,
      )
      .run(
        state,
        patch.resultSummary ?? null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        now,
        now,
        terminal ? 1 : 0,
        now,
        state === 'cancelled' ? 1 : 0,
        now,
        id,
      );
  }
  addEvent(e: AgentEvent) {
    this.db
      .prepare(
        'INSERT INTO task_events(id,task_id,sequence,type,state,message,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        e.id,
        e.taskId,
        e.sequence,
        e.type,
        e.state,
        e.message,
        e.payload === undefined ? null : JSON.stringify(e.payload),
        e.timestamp,
      );
  }
  listTasks(): TaskRecord[] {
    return this.db
      .prepare(
        'SELECT id,title,user_input userInput,state,result_summary resultSummary,error_code errorCode,error_message errorMessage,created_at createdAt,updated_at updatedAt,started_at startedAt,completed_at completedAt,cancelled_at cancelledAt FROM tasks ORDER BY created_at DESC',
      )
      .all() as TaskRecord[];
  }
  getTask(id: string) {
    return this.listTasks().find((t) => t.id === id);
  }
  events(id: string): AgentEvent[] {
    return (
      this.db
        .prepare(
          'SELECT id,task_id taskId,sequence,type,state,message,created_at timestamp,payload_json payloadJson FROM task_events WHERE task_id=? ORDER BY sequence',
        )
        .all(id) as Array<AgentEvent & { payloadJson: string | null }>
    ).map(({ payloadJson, ...e }) => ({
      ...e,
      ...(payloadJson ? { payload: JSON.parse(payloadJson) } : {}),
    }));
  }
  installSkill(manifest: SkillManifest, status = 'active', createdBy = 'system') {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO skills(id,manifest_json,status,created_by,created_at,updated_at) VALUES(?,?,?,?,COALESCE((SELECT created_at FROM skills WHERE id=?),?),?)',
      )
      .run(manifest.id, JSON.stringify(manifest), status, createdBy, manifest.id, now, now);
    this.db
      .prepare(
        'INSERT OR IGNORE INTO skill_versions(id,skill_id,version,manifest_json,created_at) VALUES(?,?,?,?,?)',
      )
      .run(crypto.randomUUID(), manifest.id, manifest.version, JSON.stringify(manifest), now);
  }
  listSkills(): SkillRecord[] {
    return (
      this.db
        .prepare(
          `SELECT s.id,s.manifest_json manifest,s.status,s.created_by createdBy,s.created_at createdAt,s.updated_at updatedAt,e.embedding_json embedding,m.success_count successCount,m.failure_count failureCount,m.total_duration_ms totalDuration,m.usage_count usageCount FROM skills s LEFT JOIN skill_embeddings e ON e.skill_id=s.id LEFT JOIN skill_usage_metrics m ON m.skill_id=s.id`,
        )
        .all() as any[]
    ).map((r) => {
      const manifest = JSON.parse(r.manifest) as SkillManifest,
        usage = r.usageCount ?? 0,
        success = r.successCount ?? 0;
      return {
        id: r.id,
        name: manifest.name,
        description: manifest.description,
        version: manifest.version,
        status: r.status,
        manifest,
        ...(r.embedding ? { embedding: JSON.parse(r.embedding) } : {}),
        successRate: usage ? success / usage : 1,
        usageCount: usage,
        failureCount: r.failureCount ?? 0,
        averageDurationMs: usage ? (r.totalDuration ?? 0) / usage : 0,
        createdBy: r.createdBy,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }
  createApproval(proposal: SkillCreationProposal, taskId?: string) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO skill_approvals(id,proposal_json,status,task_id,created_at) VALUES(?,?,?,?,?)',
      )
      .run(id, JSON.stringify(proposal), 'pending', taskId ?? null, now);
    return { id, proposal, status: 'pending', taskId, createdAt: now };
  }
  approvals() {
    return (
      this.db
        .prepare(
          'SELECT id,proposal_json proposal,status,task_id taskId,decision_scope decisionScope,created_at createdAt,decided_at decidedAt FROM skill_approvals ORDER BY created_at DESC',
        )
        .all() as any[]
    ).map((r) => ({ ...r, proposal: JSON.parse(r.proposal) }));
  }
  decideApproval(id: string, status: 'approved' | 'rejected', scope?: string) {
    this.db
      .prepare('UPDATE skill_approvals SET status=?,decision_scope=?,decided_at=? WHERE id=?')
      .run(status, scope ?? null, new Date().toISOString(), id);
    return this.approvals().find((a) => a.id === id);
  }
  versions(id: string) {
    return (
      this.db
        .prepare(
          'SELECT version,manifest_json manifest,created_at createdAt FROM skill_versions WHERE skill_id=? ORDER BY created_at DESC',
        )
        .all(id) as any[]
    ).map((v) => ({ ...v, manifest: JSON.parse(v.manifest) }));
  }
  setStatus(id: string, status: string) {
    this.db
      .prepare('UPDATE skills SET status=?,updated_at=? WHERE id=?')
      .run(status, new Date().toISOString(), id);
  }
  createSandboxExecution(input: {
    skillId: string;
    runtime: string;
    findings: unknown;
    package?: unknown;
    taskId?: string;
  }) {
    const id = crypto.randomUUID(),
      now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT INTO sandbox_executions(id,task_id,skill_id,runtime,status,findings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)',
      )
      .run(
        id,
        input.taskId ?? null,
        input.skillId,
        input.runtime,
        'waiting_for_approval',
        JSON.stringify(input.findings),
        now,
        now,
      );
    if (input.package)
      this.db
        .prepare('UPDATE sandbox_executions SET package_json=? WHERE id=?')
        .run(JSON.stringify(input.package), id);
    this.audit('SANDBOX_SCAN_COMPLETED', 'sandbox_execution', id, input);
    return { id, ...input, status: 'waiting_for_approval', createdAt: now, updatedAt: now };
  }
  sandboxExecutions() {
    return (
      this.db
        .prepare(
          'SELECT id,task_id taskId,skill_id skillId,runtime,status,findings_json findings,package_json package,output_json output,staged_json staged,applied_json applied,stdout,stderr,container_id containerId,resource_json resources,created_at createdAt,updated_at updatedAt FROM sandbox_executions ORDER BY created_at DESC',
        )
        .all() as any[]
    ).map((row) => ({
      ...row,
      findings: JSON.parse(row.findings),
      ...(row.package ? { package: JSON.parse(row.package) } : {}),
      ...(row.output ? { output: JSON.parse(row.output) } : {}),
      ...(row.staged ? { staged: JSON.parse(row.staged) } : {}),
      ...(row.applied ? { applied: JSON.parse(row.applied) } : {}),
      ...(row.resources ? { resources: JSON.parse(row.resources) } : {}),
    }));
  }
  setSandboxStatus(
    id: string,
    status: string,
    patch: {
      stdout?: string;
      stderr?: string;
      resources?: unknown;
      output?: unknown;
      staged?: unknown;
      applied?: unknown;
    } = {},
  ) {
    this.db
      .prepare(
        'UPDATE sandbox_executions SET status=?,stdout=COALESCE(?,stdout),stderr=COALESCE(?,stderr),resource_json=COALESCE(?,resource_json),output_json=COALESCE(?,output_json),staged_json=COALESCE(?,staged_json),applied_json=COALESCE(?,applied_json),updated_at=? WHERE id=?',
      )
      .run(
        status,
        patch.stdout ?? null,
        patch.stderr ?? null,
        patch.resources ? JSON.stringify(patch.resources) : null,
        patch.output === undefined ? null : JSON.stringify(patch.output),
        patch.staged === undefined ? null : JSON.stringify(patch.staged),
        patch.applied === undefined ? null : JSON.stringify(patch.applied),
        new Date().toISOString(),
        id,
      );
    this.audit(`SANDBOX_${status.toUpperCase()}`, 'sandbox_execution', id, patch);
  }
  audit(action: string, entityType: string, entityId: string, details: unknown) {
    this.db
      .prepare(
        'INSERT INTO audit_logs(id,action,entity_type,entity_id,details_json,created_at) VALUES(?,?,?,?,?,?)',
      )
      .run(
        crypto.randomUUID(),
        action,
        entityType,
        entityId,
        JSON.stringify(details),
        new Date().toISOString(),
      );
  }
  auditLogs() {
    return this.db
      .prepare(
        'SELECT id,action,entity_type entityType,entity_id entityId,details_json details,created_at createdAt FROM audit_logs ORDER BY created_at DESC',
      )
      .all();
  }
  setting<T>(key: string, fallback: T): T {
    const row = this.db
      .prepare('SELECT value_json value FROM system_settings WHERE key=?')
      .get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : fallback;
  }
  setSetting(key: string, value: unknown) {
    this.db
      .prepare('INSERT OR REPLACE INTO system_settings(key,value_json,updated_at) VALUES(?,?,?)')
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
  createPermissionRequest(taskId: string, skillId: string, permissions: unknown, reason: string) {
    const existing = this.db
      .prepare(
        "SELECT id,task_id taskId,skill_id skillId,permissions_json permissions,reason,status,scope,created_at createdAt,decided_at decidedAt FROM task_permission_requests_v2 WHERE task_id=? AND skill_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
      )
      .get(taskId, skillId) as any;
    if (existing) return { ...existing, permissions: JSON.parse(existing.permissions) };
    const request = {
      id: crypto.randomUUID(),
      taskId,
      skillId,
      permissions,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(
        'INSERT INTO task_permission_requests_v2(id,task_id,skill_id,permissions_json,reason,status,created_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        request.id,
        taskId,
        skillId,
        JSON.stringify(permissions),
        reason,
        request.status,
        request.createdAt,
      );
    this.audit('PERMISSION_APPROVAL_REQUIRED', 'task', taskId, request);
    return request;
  }
  permissionRequest(taskId: string) {
    const row = this.db
      .prepare(
        "SELECT id,task_id taskId,skill_id skillId,permissions_json permissions,reason,status,scope,created_at createdAt,decided_at decidedAt FROM task_permission_requests_v2 WHERE task_id=? ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, created_at DESC LIMIT 1",
      )
      .get(taskId) as any;
    return row ? { ...row, permissions: JSON.parse(row.permissions) } : undefined;
  }
  decidePermission(id: string, status: 'approved' | 'rejected', scope: 'once' | 'all') {
    this.db
      .prepare('UPDATE task_permission_requests_v2 SET status=?,scope=?,decided_at=? WHERE id=?')
      .run(status, scope, new Date().toISOString(), id);
    const row = this.db
      .prepare('SELECT task_id taskId,skill_id skillId FROM task_permission_requests_v2 WHERE id=?')
      .get(id) as { taskId: string; skillId: string } | undefined;
    if (scope === 'all' && status === 'approved') this.setSetting('authorizeAllPermissions', true);
    if (row)
      this.audit(
        status === 'approved' ? 'PERMISSION_GRANTED' : 'PERMISSION_REJECTED',
        'task',
        row.taskId,
        { requestId: id, scope },
      );
    if (!row) return undefined;
    const request = this.db
      .prepare(
        'SELECT id,task_id taskId,skill_id skillId,permissions_json permissions,reason,status,scope,created_at createdAt,decided_at decidedAt FROM task_permission_requests_v2 WHERE id=?',
      )
      .get(id) as any;
    return request ? { ...request, permissions: JSON.parse(request.permissions) } : undefined;
  }
  createTaskPlan(taskId: string, plan: unknown) {
    const createdAt = new Date().toISOString();
    this.db
      .prepare('INSERT OR REPLACE INTO task_plans(task_id,plan_json,status,created_at,decided_at) VALUES(?,?,?, ?,NULL)')
      .run(taskId, JSON.stringify(plan), 'pending', createdAt);
    return { taskId, plan, status: 'pending', createdAt };
  }
  taskPlan(taskId: string) {
    const row = this.db
      .prepare('SELECT task_id taskId,plan_json plan,status,created_at createdAt,decided_at decidedAt FROM task_plans WHERE task_id=?')
      .get(taskId) as { taskId: string; plan: string; status: string; createdAt: string; decidedAt?: string } | undefined;
    return row ? { ...row, plan: JSON.parse(row.plan) } : undefined;
  }
  decideTaskPlan(taskId: string, status: 'approved' | 'rejected') {
    this.db
      .prepare('UPDATE task_plans SET status=?,decided_at=? WHERE task_id=?')
      .run(status, new Date().toISOString(), taskId);
    return this.taskPlan(taskId);
  }
  hasPermissionGrant(taskId: string, skillId?: string) {
    return (
      this.setting<boolean>('authorizeAllPermissions', false) ||
      Boolean(
        this.db
          .prepare(
            `SELECT 1 FROM task_permission_requests_v2 WHERE task_id=? AND status='approved'${skillId ? ' AND skill_id=?' : ''} LIMIT 1`,
          )
          .get(...(skillId ? [taskId, skillId] : [taskId])),
      )
    );
  }
  createAgentRun(taskId: string, mode: string, state: string, budget: unknown, signals: unknown) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agent_runs(task_id,mode,state,current_owner,budget_json,usage_json,signals_json,started_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)',
      )
      .run(
        taskId,
        mode,
        state,
        'supervisor',
        JSON.stringify(budget),
        JSON.stringify({
          modelCalls: 0,
          messages: 0,
          delegations: 0,
          planRevisions: 0,
          skillRevisions: 0,
          executionRetries: 0,
        }),
        JSON.stringify(signals),
        now,
        now,
      );
  }
  updateAgentRun(
    taskId: string,
    state: string,
    owner: string | null,
    usage: unknown,
    completed = false,
  ) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        'UPDATE agent_runs SET state=?,current_owner=?,usage_json=?,updated_at=?,completed_at=CASE WHEN ? THEN ? ELSE completed_at END WHERE task_id=?',
      )
      .run(state, owner, JSON.stringify(usage), now, completed ? 1 : 0, now, taskId);
  }
  addAssignment(taskId: string, role: string, status: string, summary: string) {
    this.db
      .prepare(
        'INSERT INTO agent_assignments(id,task_id,role,status,summary,created_at,completed_at) VALUES(?,?,?,?,?,?,?)',
      )
      .run(
        crypto.randomUUID(),
        taskId,
        role,
        status,
        summary,
        new Date().toISOString(),
        status === 'completed' ? new Date().toISOString() : null,
      );
  }
  saveAgentMessage(message: AgentMessage) {
    const result = this.db
      .prepare(
        'INSERT OR IGNORE INTO agent_messages(id,task_id,correlation_id,causation_id,from_role,to_role,type,sequence,payload_json,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        message.id,
        message.taskId,
        message.correlationId,
        message.causationId ?? null,
        message.from,
        message.to,
        message.type,
        message.sequence,
        JSON.stringify(message.payload),
        message.timestamp,
      );
    return result.changes > 0;
  }
  agentFlow(taskId?: string) {
    const runs = this.db
      .prepare(
        `SELECT task_id taskId,mode,state,current_owner currentOwner,budget_json budget,usage_json usage,signals_json signals,started_at startedAt,updated_at updatedAt,completed_at completedAt FROM agent_runs ${taskId ? 'WHERE task_id=?' : ''} ORDER BY started_at DESC`,
      )
      .all(...(taskId ? [taskId] : [])) as any[];
    return runs.map((run) => ({
      ...run,
      budget: JSON.parse(run.budget),
      usage: JSON.parse(run.usage),
      signals: JSON.parse(run.signals),
      messages: (
        this.db
          .prepare(
            'SELECT id,task_id taskId,correlation_id correlationId,causation_id causationId,from_role "from",to_role "to",type,sequence,payload_json payload,timestamp FROM (SELECT *,created_at timestamp FROM agent_messages) WHERE task_id=? ORDER BY sequence',
          )
          .all(run.taskId) as any[]
      ).map((m) => ({ ...m, payload: JSON.parse(m.payload) })),
      assignments: this.db
        .prepare(
          'SELECT id,role,status,summary,created_at createdAt,completed_at completedAt FROM agent_assignments WHERE task_id=? ORDER BY created_at',
        )
        .all(run.taskId),
    }));
  }
}
