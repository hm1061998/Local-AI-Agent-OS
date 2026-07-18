import { describe, expect, it } from 'vitest';
import { MockModelProvider } from '@local-agent/test-utils';
import type { SkillCreationProposal, SkillManifest } from '@local-agent/agent-protocol';
import { AgentDatabase } from '../src/database';
import { Orchestrator } from '../src/orchestrator';

describe('Phase 2 factory lifecycle', () => {
  it('pauses for approval, installs a prompt skill, and resumes the same task', async () => {
    const db = new AgentDatabase(':memory:');
    const model = new MockModelProvider({ title: 'Translate', intent: 'translate text', category: 'general', objectives: ['translate'], requiredCapabilities: ['language:translate'], constraints: [], estimatedRisk: 'low' });
    const orchestrator = new Orchestrator(db, model);
    const task = db.createTask('translate hello');
    await orchestrator.run(task.id, task.userInput);
    expect(db.getTask(task.id)?.state).toBe('waiting_for_approval');
    const approval = db.approvals()[0]!;
    expect(approval.taskId).toBe(task.id);
    const proposal = approval.proposal as SkillCreationProposal;
    const manifest: SkillManifest = { id: proposal.name, name: proposal.name, version: '1.0.0', description: proposal.description, tags: proposal.missingCapabilities, triggers: proposal.missingCapabilities, runtime: { type: 'prompt', timeoutSeconds: 30 }, inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, permissions: proposal.permissions, riskLevel: proposal.riskLevel, approvalRequired: false, capabilities: proposal.missingCapabilities };
    db.decideApproval(approval.id, 'approved', 'version');
    db.installSkill(manifest, 'active', 'agent');
    await orchestrator.resume(task.id);
    expect(db.getTask(task.id)?.state).toBe('completed');
    expect(db.events(task.id).some(event => event.type === 'SKILL_APPROVAL_REQUIRED')).toBe(true);
  });

  it('rejects a proposal without installing executable code', async () => {
    const db = new AgentDatabase(':memory:');
    const model = new MockModelProvider({ title: 'Custom', intent: 'custom', category: 'general', objectives: ['custom'], requiredCapabilities: ['custom:missing'], constraints: [], estimatedRisk: 'low' });
    const orchestrator = new Orchestrator(db, model);
    const task = db.createTask('custom task');
    await orchestrator.run(task.id, task.userInput);
    const approval = db.approvals()[0]!;
    db.decideApproval(approval.id, 'rejected');
    expect(db.listSkills()).toHaveLength(0);
  });
});
