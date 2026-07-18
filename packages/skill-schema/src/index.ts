import { z } from 'zod';
export const permissionSchema = z.object({
  filesystem: z.object({
    read: z.array(z.string()),
    write: z.array(z.string()),
    delete: z.array(z.string()).max(0),
  }),
  commands: z.array(z.string()),
  network: z.object({ enabled: z.boolean(), allowedHosts: z.array(z.string()) }),
  environmentVariables: z.array(z.string()),
});
export const skillManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string(),
  tags: z.array(z.string()),
  triggers: z.array(z.string()),
  runtime: z.object({
    type: z.enum(['prompt', 'workflow', 'typescript', 'python']),
    entrypoint: z.string().optional(),
    timeoutSeconds: z.number().positive().max(300),
  }),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
  permissions: permissionSchema,
  riskLevel: z.enum(['low', 'medium', 'high', 'forbidden']),
  approvalRequired: z.boolean(),
  capabilities: z.array(z.string()).default([]),
});
export type SkillManifest = z.infer<typeof skillManifestSchema>;
export const skillStatuses = [
  'draft',
  'testing',
  'waiting_for_approval',
  'active',
  'disabled',
  'rejected',
  'archived',
] as const;
export type SkillStatus = (typeof skillStatuses)[number];
export interface SkillRecord {
  id: string;
  name: string;
  description: string;
  version: string;
  status: SkillStatus;
  manifest: SkillManifest;
  embedding?: number[];
  successRate: number;
  usageCount: number;
  failureCount: number;
  averageDurationMs: number;
  createdBy: 'system' | 'agent' | 'user';
  parentSkillId?: string;
  createdAt: string;
  updatedAt: string;
}
export const workflowDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  inputs: z.record(z.string(), z.unknown()),
  steps: z
    .array(
      z.object({
        id: z.string(),
        skillId: z.string(),
        dependsOn: z.array(z.string()),
        inputMapping: z.record(z.string(), z.string()),
        outputAlias: z.string(),
        condition: z.object({ expression: z.string().regex(/^[\w.\s=!<>&|()'"-]+$/) }).optional(),
      }),
    )
    .max(10),
  outputMapping: z.record(z.string(), z.string()),
});
export type WorkflowSkillDefinition = z.infer<typeof workflowDefinitionSchema>;
export const skillCreationProposalSchema = z.object({
  name: z.string(),
  description: z.string(),
  runtimeType: z.enum(['prompt', 'workflow']),
  reason: z.string(),
  missingCapabilities: z.array(z.string()),
  permissions: permissionSchema,
  riskLevel: z.enum(['low', 'medium', 'high']),
  testCases: z
    .array(
      z.object({
        name: z.string(),
        input: z.record(z.string(), z.unknown()),
        expectedAssertions: z.array(z.string()),
      }),
    )
    .min(1),
});
export type SkillCreationProposal = z.infer<typeof skillCreationProposalSchema>;
export interface SkillRoutingResult {
  candidates: Array<{ skillId: string; score: number; reasons: string[] }>;
  selectedSkillIds: string[];
  confidence: number;
  missingCapabilities: string[];
}
export const executionPlanSchema = z.object({
  goal: z.string(),
  steps: z.array(
    z.object({
      id: z.string(),
      order: z.number().int().positive(),
      title: z.string(),
      description: z.string(),
      skillId: z.string(),
      input: z.record(z.string(), z.unknown()),
      expectedOutput: z.string(),
      risk: z.enum(['low', 'medium', 'high']),
    }),
  ),
});
export type ExecutionPlan = z.infer<typeof executionPlanSchema>;
