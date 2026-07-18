import { EventEmitter } from 'node:events';
import type { AgentEvent, AgentState, ExecutionBudget, TaskAnalysis } from '@local-agent/agent-protocol';
import { ModelProviderError, type ModelProvider } from '@local-agent/model-provider';
import { DEFAULT_BUDGET, taskAnalysisSchema } from '@local-agent/shared-types';
import { AgentDatabase } from './database';
import { createPlan, executeSkill, routeSkills, validatePlan } from './skills';

export class BudgetGuard {
  modelCalls = 0;
  steps = 0;
  readonly started = Date.now();
  constructor(readonly budget: ExecutionBudget = DEFAULT_BUDGET) {}
  modelCall() { if (++this.modelCalls > this.budget.maxModelCalls) this.fail(); }
  step() { if (++this.steps > this.budget.maxSteps) this.fail(); this.time(); }
  time() { if (Date.now() - this.started > this.budget.maxExecutionTimeMs) this.fail(); }
  private fail(): never { throw new Error('BUDGET_EXCEEDED'); }
}

const transitions: Record<AgentState, AgentState[]> = {
  idle: ['analyzing_task', 'cancelled'],
  analyzing_task: ['searching_skills', 'failed', 'cancelled'],
  searching_skills: ['planning', 'failed', 'cancelled'],
  planning: ['executing', 'failed', 'cancelled'],
  creating_skill: ['failed'], testing_skill: ['failed'], waiting_for_approval: ['cancelled'],
  executing: ['validating', 'failed', 'cancelled'], validating: ['completed', 'failed', 'cancelled'],
  completed: [], failed: [], cancelled: [],
};

export function assertTransition(from: AgentState, to: AgentState) {
  if (!transitions[from].includes(to)) throw new Error(`Invalid transition ${from} -> ${to}`);
}

export class Orchestrator extends EventEmitter {
  private controllers = new Map<string, AbortController>();
  private sequence = new Map<string, number>();
  constructor(private db: AgentDatabase, private model: ModelProvider, private workspace = process.env.AGENT_WORKSPACE ?? process.cwd()) { super(); }
  cancel(id: string) { this.controllers.get(id)?.abort(); }

  async run(id: string, input: string, budget = DEFAULT_BUDGET) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const guard = new BudgetGuard(budget);
    let state: AgentState = 'idle';
    const move = async (to: AgentState, type: AgentEvent['type'], message: string, payload?: unknown) => {
      assertTransition(state, to); state = to; this.db.updateTask(id, state); this.event(id, type, state, message, payload);
    };
    try {
      this.event(id, 'TASK_RECEIVED', 'idle', 'Đã nhận tác vụ.');
      await move('analyzing_task', 'TASK_ANALYSIS_STARTED', 'Đang phân tích yêu cầu.');
      guard.modelCall();
      const analysis = await this.analyze(input, controller.signal);
      this.event(id, 'TASK_ANALYSIS_COMPLETED', state, `Đã xác định ${analysis.objectives.length} mục tiêu.`, analysis);
      await move('searching_skills', 'SKILL_SEARCH_STARTED', 'Đang tìm skill phù hợp.');
      const routing = routeSkills(analysis);
      if (!routing.selectedSkillIds.length) throw new Error('SKILL_NOT_FOUND');
      this.event(id, 'SKILL_SELECTED', state, `Đã chọn ${routing.selectedSkillIds.length} skill.`, routing);
      await move('planning', 'PLAN_GENERATION_STARTED', 'Đang xây dựng kế hoạch.');
      const plan = validatePlan(createPlan(analysis, routing), budget.maxSteps);
      this.event(id, 'PLAN_GENERATED', state, `Kế hoạch có ${plan.steps.length} bước.`, plan);
      await move('executing', 'EXECUTION_STARTED', 'Bắt đầu thực thi.');
      const results: unknown[] = [];
      for (const step of plan.steps) {
        guard.step();
        if (controller.signal.aborted) throw new Error('TASK_CANCELLED');
        this.event(id, 'STEP_STARTED', state, `Đang thực thi bước ${step.order}/${plan.steps.length}.`, step);
        results.push(await executeSkill(step.skillId, step.input, this.workspace, controller.signal));
        this.event(id, 'STEP_COMPLETED', state, `Đã hoàn thành bước ${step.order}.`);
      }
      await move('validating', 'RESULT_VALIDATION_STARTED', 'Đang kiểm tra kết quả.');
      this.event(id, 'RESULT_VALIDATION_COMPLETED', state, 'Kết quả hợp lệ.', { results });
      await move('completed', 'TASK_COMPLETED', 'Hoàn thành.', { results });
      this.db.updateTask(id, 'completed', { resultSummary: `Hoàn thành ${plan.steps.length} bước.` });
    } catch (error) {
      const rawCode = error instanceof Error ? error.message : 'UNEXPECTED_ERROR';
      const cancelled = rawCode === 'TASK_CANCELLED' || controller.signal.aborted;
      const code = cancelled ? 'TASK_CANCELLED' : rawCode;
      const target: AgentState = cancelled ? 'cancelled' : 'failed';
      if (transitions[state].includes(target)) {
        state = target;
        this.db.updateTask(id, state, { errorCode: code, errorMessage: code });
        this.event(id, cancelled ? 'EXECUTION_CANCELLED' : 'TASK_FAILED', state, cancelled ? 'Đã hủy tác vụ.' : `Tác vụ thất bại: ${code}`);
      }
    } finally { this.controllers.delete(id); }
  }

  private async analyze(input: string, signal: AbortSignal): Promise<TaskAnalysis> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new Error('TASK_CANCELLED');
      try { return await this.model.generateStructured({ prompt: `Phân tích task sau và chỉ trả JSON hợp lệ: ${input}`, schema: taskAnalysisSchema, signal }); }
      catch (error) {
        if (signal.aborted) throw new Error('TASK_CANCELLED');
        if (error instanceof ModelProviderError) throw error;
        last = error;
      }
    }
    if (last instanceof Error && last.message === 'OLLAMA_UNAVAILABLE') throw last;
    throw new Error('STRUCTURED_OUTPUT_INVALID');
  }

  private event(taskId: string, type: AgentEvent['type'], state: AgentState, message: string, payload?: unknown) {
    const event: AgentEvent = { id: crypto.randomUUID(), taskId, type, state, message, timestamp: new Date().toISOString(), sequence: (this.sequence.get(taskId) ?? 0) + 1, ...(payload === undefined ? {} : { payload }) };
    this.sequence.set(taskId, event.sequence);
    this.db.addEvent(event);
    this.emit('event', event);
  }
}
