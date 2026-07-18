export * from '@local-agent/shared-types';
export * from '@local-agent/event-schema';
export * from '@local-agent/skill-schema';
export interface CreateTaskRequest {
  input: string;
}
export interface ModelHealth {
  available: boolean;
  baseUrl: string;
  chatModel: string;
  chatModelAvailable: boolean;
  embedModel: string;
  embedModelAvailable: boolean;
  message: string;
}
export interface ModelProvider {
  streamChat(request: any): AsyncIterable<any>;
  generateStructured<T>(request: any): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<ModelHealth>;
}

import { z } from 'zod';

export const agentRoles = [
  'supervisor',
  'planner',
  'skill_builder',
  'security_reviewer',
  'executor',
  'result_judge',
] as const;
export const agentRoleSchema = z.enum(agentRoles);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const agentMessageSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  correlationId: z.string().min(1),
  causationId: z.string().min(1).optional(),
  from: agentRoleSchema,
  to: z.union([agentRoleSchema, z.literal('broadcast')]),
  type: z.string().min(1),
  timestamp: z.iso.datetime(),
  sequence: z.number().int().positive(),
  payload: z.unknown(),
});
export type AgentMessage<T = unknown> = Omit<z.infer<typeof agentMessageSchema>, 'payload'> & {
  payload: T;
};

export const multiAgentStates = [
  'TASK_RECEIVED',
  'SUPERVISOR_ANALYSIS',
  'PLANNER_ASSIGNED',
  'PLAN_READY',
  'SKILL_BUILDER_ASSIGNED',
  'SKILL_PROPOSAL_READY',
  'SECURITY_REVIEW_ASSIGNED',
  'SECURITY_REVIEW_READY',
  'USER_APPROVAL_REQUIRED',
  'SKILL_INSTALLED',
  'EXECUTOR_ASSIGNED',
  'EXECUTION_RUNNING',
  'RESULT_JUDGE_ASSIGNED',
  'RESULT_VALIDATED',
  'TASK_COMPLETED',
  'AGENT_FAILED',
  'BUDGET_EXCEEDED',
  'REVIEW_REJECTED',
  'USER_REJECTED',
  'EXECUTION_FAILED',
  'RESULT_INVALID',
  'TASK_FAILED',
] as const;
export type MultiAgentState = (typeof multiAgentStates)[number];

export const multiAgentBudgetSchema = z.object({
  maxTotalModelCalls: z.number().int().positive().default(12),
  maxTotalMessages: z.number().int().positive().default(30),
  maxDelegations: z.number().int().positive().default(10),
  maxPlanRevisions: z.number().int().nonnegative().default(2),
  maxSkillRevisions: z.number().int().nonnegative().default(2),
  maxExecutionRetries: z.number().int().nonnegative().default(1),
  maxDurationMs: z.number().int().positive().default(300_000),
});
export type MultiAgentBudget = z.infer<typeof multiAgentBudgetSchema>;
export const defaultMultiAgentBudget: MultiAgentBudget = multiAgentBudgetSchema.parse({});
export const agentBudgetSchema = z.object({
  maxModelCalls: z.number().int().positive().default(4),
  maxMessages: z.number().int().positive().default(8),
  timeoutMs: z.number().int().positive().default(60_000),
});
export type AgentBudget = z.infer<typeof agentBudgetSchema>;
export const defaultAgentBudget: AgentBudget = agentBudgetSchema.parse({});

export const securityReviewDecisionSchema = z.object({
  decision: z.enum(['approved', 'approved_with_conditions', 'rejected']),
  riskLevel: z.enum(['low', 'medium', 'high', 'critical']),
  findings: z.array(
    z.object({
      code: z.string(),
      severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
      message: z.string(),
      file: z.string().optional(),
      line: z.number().int().positive().optional(),
    }),
  ),
  requiredChanges: z.array(z.string()),
  permissionChanges: z.record(z.string(), z.unknown()),
  requiresUserApproval: z.boolean(),
});
export type SecurityReviewDecision = z.infer<typeof securityReviewDecisionSchema>;

export const resultJudgementSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(1),
  checks: z.array(z.object({ name: z.string(), passed: z.boolean(), evidence: z.string() })),
  retryRecommended: z.boolean(),
  retryReason: z.string().optional(),
});
export type ResultJudgement = z.infer<typeof resultJudgementSchema>;
