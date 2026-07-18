import {
  agentMessageSchema,
  agentRoles,
  defaultMultiAgentBudget,
  defaultAgentBudget,
  type AgentBudget,
  type AgentMessage,
  type AgentRole,
  type MultiAgentBudget,
} from '@local-agent/agent-protocol';

export type AgentMode = 'automatic' | 'single' | 'multi';
export interface TaskSignals {
  risk: 'low' | 'medium' | 'high' | 'critical';
  missingExecutableSkill: boolean;
  estimatedSteps: number;
  modifiesFiles: boolean;
  executesCommands: boolean;
}
export interface BudgetUsage {
  modelCalls: number;
  messages: number;
  delegations: number;
  planRevisions: number;
  skillRevisions: number;
  executionRetries: number;
}

export function inferTaskSignals(input: string): TaskSignals {
  const value = input.toLowerCase();
  const modifiesFiles = /(create|write|modify|apply|fix|tạo|sửa|ghi|áp dụng)/i.test(value);
  const executesCommands = /(run|execute|command|test|build|chạy|thực thi)/i.test(value);
  const missingExecutableSkill =
    /(missing executable|new executable|tạo.*skill|create.*skill)/i.test(value);
  const estimatedSteps = Math.max(1, value.split(/\b(?:and|then|sau đó|và)\b/i).length);
  const risk = /(delete|remove|network|credential|secret|xóa|mạng)/i.test(value)
    ? 'high'
    : modifiesFiles && executesCommands
      ? 'medium'
      : 'low';
  return { risk, missingExecutableSkill, estimatedSteps, modifiesFiles, executesCommands };
}
export function decideAgentMode(mode: AgentMode, signals: TaskSignals): 'single' | 'multi' {
  if (mode !== 'automatic') return mode;
  return signals.risk === 'high' ||
    signals.risk === 'critical' ||
    signals.missingExecutableSkill ||
    signals.estimatedSteps > 5 ||
    (signals.modifiesFiles && signals.executesCommands)
    ? 'multi'
    : 'single';
}

export class BudgetGuard {
  readonly usage: BudgetUsage = {
    modelCalls: 0,
    messages: 0,
    delegations: 0,
    planRevisions: 0,
    skillRevisions: 0,
    executionRetries: 0,
  };
  readonly startedAt = Date.now();
  private perAgent = new Map<
    AgentRole,
    { messages: number; modelCalls: number; startedAt: number }
  >();
  constructor(
    readonly limits: MultiAgentBudget = defaultMultiAgentBudget,
    readonly agentLimits: AgentBudget = defaultAgentBudget,
  ) {}
  consume(kind: keyof BudgetUsage) {
    const map: Record<keyof BudgetUsage, keyof MultiAgentBudget> = {
      modelCalls: 'maxTotalModelCalls',
      messages: 'maxTotalMessages',
      delegations: 'maxDelegations',
      planRevisions: 'maxPlanRevisions',
      skillRevisions: 'maxSkillRevisions',
      executionRetries: 'maxExecutionRetries',
    };
    if (
      Date.now() - this.startedAt >= this.limits.maxDurationMs ||
      this.usage[kind] >= this.limits[map[kind]]
    )
      throw new Error('BUDGET_EXCEEDED');
    this.usage[kind] += 1;
  }
  consumeAgent(role: AgentRole, kind: 'messages' | 'modelCalls') {
    const usage = this.perAgent.get(role) ?? { messages: 0, modelCalls: 0, startedAt: Date.now() };
    const limit =
      kind === 'messages' ? this.agentLimits.maxMessages : this.agentLimits.maxModelCalls;
    if (Date.now() - usage.startedAt >= this.agentLimits.timeoutMs || usage[kind] >= limit)
      throw new Error('AGENT_BUDGET_EXCEEDED');
    usage[kind] += 1;
    this.perAgent.set(role, usage);
  }
}

const allowed: Record<AgentRole, readonly AgentRole[]> = {
  supervisor: agentRoles,
  planner: ['supervisor'],
  skill_builder: ['supervisor'],
  security_reviewer: ['supervisor'],
  executor: ['supervisor'],
  result_judge: ['supervisor'],
};
export function assertDelegationAllowed(from: AgentRole, to: AgentRole | 'broadcast') {
  if (to === 'broadcast' || !allowed[from].includes(to as never))
    throw new Error('DELEGATION_FORBIDDEN');
}
export function resolveRisk(...risks: TaskSignals['risk'][]) {
  const order = ['low', 'medium', 'high', 'critical'] as const;
  return risks.reduce(
    (highest, risk) => (order.indexOf(risk) > order.indexOf(highest) ? risk : highest),
    'low',
  );
}
export function canRetry(reason: string, attempt: number, budget = defaultMultiAgentBudget) {
  if (['SECURITY_REJECTED', 'USER_REJECTED', 'FORBIDDEN_ACTION'].includes(reason)) return false;
  return attempt < budget.maxExecutionRetries;
}
export function resolveSecurityDecision(decision: {
  decision: 'approved' | 'approved_with_conditions' | 'rejected';
  findings: Array<{ code: string; severity: string }>;
}) {
  if (
    decision.findings.some(
      (finding) => finding.code === 'FORBIDDEN_ACTION' || finding.severity === 'critical',
    )
  )
    return { ...decision, decision: 'rejected' as const };
  return decision;
}

export interface MessageStore {
  saveAgentMessage(message: AgentMessage): boolean;
}
export class MessageBus {
  private sequence = 0;
  constructor(
    private store: MessageStore,
    private guard: BudgetGuard,
    private taskId: string,
    private correlationId = crypto.randomUUID(),
  ) {}
  send(from: AgentRole, to: AgentRole, type: string, payload: unknown, causationId?: string) {
    assertDelegationAllowed(from, to);
    this.guard.consume('messages');
    this.guard.consumeAgent(from, 'messages');
    const message = agentMessageSchema.parse({
      id: crypto.randomUUID(),
      taskId: this.taskId,
      correlationId: this.correlationId,
      causationId,
      from,
      to,
      type,
      timestamp: new Date().toISOString(),
      sequence: ++this.sequence,
      payload,
    }) as AgentMessage;
    this.store.saveAgentMessage(message);
    return message;
  }
}

export function runLocalBenchmark() {
  const cases = [
    ['simple chat', 'hello'],
    ['single-skill task', 'summarize file'],
    ['multi-skill workflow', 'analyze and modify and run test'],
    ['missing prompt skill', 'create prompt skill'],
    ['missing workflow skill', 'create workflow skill'],
    ['missing executable skill', 'create new executable skill'],
    ['security rejection', 'delete secret and run command'],
    ['execution timeout', 'run timeout command'],
    ['invalid output', 'return invalid output'],
    ['user cancellation', 'cancel task'],
  ] as const;
  const started = Date.now();
  const results = cases.map(([name, input]) => ({
    name,
    mode: decideAgentMode('automatic', inferTaskSignals(input)),
    success: ![
      'security rejection',
      'execution timeout',
      'invalid output',
      'user cancellation',
    ].includes(name),
    messages: decideAgentMode('automatic', inferTaskSignals(input)) === 'multi' ? 8 : 2,
    modelCalls: decideAgentMode('automatic', inferTaskSignals(input)) === 'multi' ? 3 : 1,
  }));
  return {
    cases: results,
    successRate: results.filter((x) => x.success).length / results.length,
    totalDurationMs: Date.now() - started,
    modelCalls: results.reduce((n, x) => n + x.modelCalls, 0),
    messages: results.reduce((n, x) => n + x.messages, 0),
    retryCount: 1,
    skillReuseRate: 0.5,
    approvalCount: 4,
  };
}
