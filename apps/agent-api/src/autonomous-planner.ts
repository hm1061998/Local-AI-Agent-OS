import { z } from 'zod';
import type { ModelProvider } from '@local-agent/model-provider';
import type { TaskAnalysis } from '@local-agent/shared-types';
import { uniqueCapabilities } from './autonomy-policy';

const autonomousPlanSchema = z.object({
  capabilities: z.array(z.string().min(2).max(80)).max(8),
  successCriteria: z.array(z.string().min(3).max(200)).min(1).max(8),
  artifacts: z.array(z.string().regex(/^\.[a-z0-9]{1,8}$/i)).max(4),
  strategy: z.enum(['reuse', 'compose', 'create_skill', 'install_tool']),
  rationale: z.string().min(3).max(500),
});
export type AutonomousPlan = z.infer<typeof autonomousPlanSchema>;

/**
 * The LLM decides *what capability is needed*, not which shell command to run.
 * Commands, packages and permissions remain resolved by local policy.
 */
export class AutonomousPlanner {
  constructor(private readonly model: ModelProvider) {}
  async plan(input: string, analysis: TaskAnalysis, knownCapabilities: string[]) {
    const result = await this.model.generateStructured({
      prompt: [
        'You are an autonomous agent planner.',
        `User request: ${input}`,
        `Initial analysis: ${JSON.stringify(analysis)}`,
        `Known capabilities: ${knownCapabilities.join(', ') || 'none'}`,
        'Identify the minimum capabilities and concrete completion criteria.',
        'Use capability names such as filesystem:read, document:pdf, spreadsheet:xlsx, browser:automation, image:transform, code:modify, testing:run.',
        'If no known capability fits, choose create_skill. Never return commands, package names, credentials, or URLs.',
      ].join('\n'),
      schema: autonomousPlanSchema,
    });
    return { ...result, capabilities: uniqueCapabilities(result.capabilities) };
  }
}

export function applyAutonomousPlan(analysis: TaskAnalysis, plan: AutonomousPlan): TaskAnalysis {
  const fixedArtifacts = analysis.constraints.filter((constraint) => constraint.startsWith('artifact:'));
  const hasDeterministicArtifact = fixedArtifacts.length > 0;
  const hasDeterministicRead =
    analysis.category === 'filesystem' &&
    analysis.requiredCapabilities.length === 1 &&
    analysis.requiredCapabilities[0] === 'filesystem:read';
  const policyCapabilities = plan.capabilities.filter((capability) =>
    /^(filesystem|document|spreadsheet|data|browser|image|code|testing|network):[a-z0-9-]+$/i.test(
      capability,
    ),
  );
  return {
    ...analysis,
    // Once the request itself establishes an artifact contract, its capability
    // chain is authoritative. Do not let an abstract model capability create a
    // meaningless extra skill/step in a concrete export plan.
    requiredCapabilities: uniqueCapabilities([
      ...analysis.requiredCapabilities,
      // A literal file-read request is already a complete one-skill workflow.
      // Keep the model from appending speculative capabilities to it.
      ...(hasDeterministicArtifact || hasDeterministicRead ? [] : policyCapabilities),
    ]),
    constraints: uniqueCapabilities([
      ...analysis.constraints,
      ...plan.successCriteria.map((criterion) => `success:${criterion}`),
      // Artifact contracts are derived from explicit user intent (for example
      // "create a PDF"), never hallucinated from the planner response.
    ]),
  };
}
