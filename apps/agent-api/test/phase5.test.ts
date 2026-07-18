import { describe, expect, it } from 'vitest';
import { agentMessageSchema, defaultMultiAgentBudget } from '@local-agent/agent-protocol';
import { AgentDatabase } from '../src/database';
import {
  BudgetGuard,
  MessageBus,
  assertDelegationAllowed,
  canRetry,
  decideAgentMode,
  inferTaskSignals,
  resolveRisk,
  resolveSecurityDecision,
  runLocalBenchmark,
} from '../src/multi-agent';

describe('Phase 5 multi-agent policy', () => {
  it('validates typed messages and required correlation metadata', () => {
    expect(() => agentMessageSchema.parse({})).toThrow();
  });
  it('blocks direct agent-to-agent communication and broadcast', () => {
    expect(() => assertDelegationAllowed('planner', 'executor')).toThrow('DELEGATION_FORBIDDEN');
    expect(() => assertDelegationAllowed('supervisor', 'planner')).not.toThrow();
  });
  it('enforces global message budget', () => {
    const guard = new BudgetGuard({ ...defaultMultiAgentBudget, maxTotalMessages: 1 });
    guard.consume('messages');
    expect(() => guard.consume('messages')).toThrow('BUDGET_EXCEEDED');
  });
  it('enforces a separate per-agent budget', () => {
    const guard = new BudgetGuard(defaultMultiAgentBudget, {
      maxMessages: 1,
      maxModelCalls: 1,
      timeoutMs: 1000,
    });
    guard.consumeAgent('planner', 'messages');
    expect(() => guard.consumeAgent('planner', 'messages')).toThrow('AGENT_BUDGET_EXCEEDED');
  });
  it('persists messages idempotently', () => {
    const db = new AgentDatabase(':memory:');
    const bus = new MessageBus(db, new BudgetGuard(), 'task-1', 'correlation-1');
    const message = bus.send('supervisor', 'planner', 'PLAN_REQUESTED', {});
    expect(db.saveAgentMessage(message)).toBe(false);
  });
  it('uses higher risk and never retries hard rejection', () => {
    expect(resolveRisk('medium', 'high')).toBe('high');
    expect(canRetry('SECURITY_REJECTED', 0)).toBe(false);
    expect(canRetry('EXECUTION_FAILED', 0)).toBe(true);
    expect(canRetry('EXECUTION_FAILED', 1)).toBe(false);
  });
  it('gives forbidden security findings precedence', () => {
    expect(
      resolveSecurityDecision({
        decision: 'approved',
        findings: [{ code: 'FORBIDDEN_ACTION', severity: 'high' }],
      }).decision,
    ).toBe('rejected');
  });
  it('selects mode deterministically', () => {
    expect(decideAgentMode('automatic', inferTaskSignals('hello'))).toBe('single');
    expect(decideAgentMode('automatic', inferTaskSignals('modify files and run test'))).toBe(
      'multi',
    );
    expect(decideAgentMode('single', inferTaskSignals('delete secret and run command'))).toBe(
      'single',
    );
  });
  it('runs the ten-case local benchmark', () => {
    const result = runLocalBenchmark();
    expect(result.cases).toHaveLength(10);
    expect(result.successRate).toBe(0.6);
  });
});
