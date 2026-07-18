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
}
