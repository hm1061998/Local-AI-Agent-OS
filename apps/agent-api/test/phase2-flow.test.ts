import { describe, expect, it } from 'vitest';
import { MockModelProvider } from '@local-agent/test-utils';
import { AgentDatabase } from '../src/database';
import { Orchestrator } from '../src/orchestrator';

describe('Phase 2 factory lifecycle', () => {
  it('auto-installs a safe prompt skill and completes the same task', async () => {
    const db = new AgentDatabase(':memory:');
    const model = new MockModelProvider({
      title: 'Translate',
      intent: 'translate text',
      category: 'general',
      objectives: ['translate'],
      requiredCapabilities: ['language:translate'],
      constraints: [],
      estimatedRisk: 'low',
    });
    const orchestrator = new Orchestrator(db, model);
    const task = db.createTask('translate hello');
    await orchestrator.run(task.id, task.userInput);
    expect(db.getTask(task.id)?.state).toBe('completed');
    expect(db.approvals()).toHaveLength(0);
    expect(db.listSkills()[0]?.createdBy).toBe('agent');
    expect(db.events(task.id).some((event) => event.type === 'SKILL_AUTO_INSTALLED')).toBe(true);
  });

  it('stores structured output in the completed task and event stream', async () => {
    const db = new AgentDatabase(':memory:');
    const model = new MockModelProvider({
      title: 'Custom',
      intent: 'custom',
      category: 'general',
      objectives: ['custom'],
      requiredCapabilities: ['custom:missing'],
      constraints: [],
      estimatedRisk: 'low',
    });
    const orchestrator = new Orchestrator(db, model);
    const task = db.createTask('custom task');
    await orchestrator.run(task.id, task.userInput);
    expect(db.getTask(task.id)?.resultSummary).toContain('custom');
    expect(
      db.events(task.id).find((event) => event.type === 'TASK_COMPLETED')?.payload,
    ).toHaveProperty('results');
  });
});
