import { z } from 'zod';
export const agentStates=['idle','analyzing_task','searching_skills','planning','creating_skill','testing_skill','waiting_for_approval','executing','validating','completed','failed','cancelled'] as const;
export type AgentState=(typeof agentStates)[number];
export const executionBudgetSchema=z.object({maxSteps:z.number().int().positive(),maxModelCalls:z.number().int().positive(),maxExecutionTimeMs:z.number().int().positive(),maxGeneratedFiles:z.number().int().nonnegative(),maxRetriesPerStep:z.number().int().nonnegative()});
export type ExecutionBudget=z.infer<typeof executionBudgetSchema>;
export const DEFAULT_BUDGET:ExecutionBudget={maxSteps:8,maxModelCalls:6,maxExecutionTimeMs:180000,maxGeneratedFiles:20,maxRetriesPerStep:1};
export const taskAnalysisSchema=z.object({title:z.string().min(1),intent:z.string().min(1),category:z.enum(['filesystem','code_analysis','testing','reporting','general']),objectives:z.array(z.string()).min(1),requiredCapabilities:z.array(z.string()),constraints:z.array(z.string()),estimatedRisk:z.enum(['low','medium','high'])});
export type TaskAnalysis=z.infer<typeof taskAnalysisSchema>;
export interface AgentError{code:'OLLAMA_UNAVAILABLE'|'OLLAMA_GENERATION_FAILED'|'MODEL_NOT_FOUND'|'STRUCTURED_OUTPUT_INVALID'|'SKILL_NOT_FOUND'|'PLAN_INVALID'|'BUDGET_EXCEEDED'|'EXECUTION_TIMEOUT'|'TASK_CANCELLED'|'WORKSPACE_ACCESS_DENIED'|'UNEXPECTED_ERROR';message:string;recoverable:boolean;details?:Record<string,unknown>}
export interface TaskRecord{id:string;title:string;userInput:string;state:AgentState;resultSummary?:string|null;errorCode?:string|null;errorMessage?:string|null;createdAt:string;updatedAt:string;startedAt?:string|null;completedAt?:string|null;cancelledAt?:string|null}
