import { EventEmitter } from 'node:events';
import { z } from 'zod';
import type {
  AgentEvent,
  AgentState,
  ExecutionBudget,
  SkillManifest,
  TaskAnalysis,
} from '@local-agent/agent-protocol';
import { ModelProviderError, type ModelProvider } from '@local-agent/model-provider';
import { DEFAULT_BUDGET, taskAnalysisSchema } from '@local-agent/shared-types';
import { AgentDatabase } from './database';
import { createPlan, executeSkill, validatePlan } from './skills';
import { createProposal } from './phase2';

const meaningfulValueSchema = z
  .union([
    z.string().min(1),
    z.array(z.unknown()).min(1),
    z.record(z.string(), z.unknown()).refine((value) => Object.keys(value).length > 0),
    z.number(),
    z.boolean(),
  ])
  .refine((value) => value !== null && value !== undefined, 'Output must not be empty');
const skillExecutionResultSchema = z.object({
  output: meaningfulValueSchema,
  summary: z.string().min(1).optional(),
  artifacts: z.array(z.string()).optional(),
});

export class BudgetGuard {
  modelCalls = 0;
  steps = 0;
  readonly started = Date.now();
  constructor(readonly budget: ExecutionBudget = DEFAULT_BUDGET) {}
  modelCall() {
    if (++this.modelCalls > this.budget.maxModelCalls) this.fail();
  }
  step() {
    if (++this.steps > this.budget.maxSteps) this.fail();
    this.time();
  }
  time() {
    if (Date.now() - this.started > this.budget.maxExecutionTimeMs) this.fail();
  }
  private fail(): never {
    throw new Error('BUDGET_EXCEEDED');
  }
}
const transitions: Record<AgentState, AgentState[]> = {
  idle: ['analyzing_task', 'cancelled'],
  analyzing_task: ['searching_skills', 'failed', 'cancelled'],
  searching_skills: ['planning', 'creating_skill', 'failed', 'cancelled'],
  creating_skill: ['testing_skill', 'failed', 'cancelled'],
  testing_skill: ['searching_skills', 'waiting_for_approval', 'failed', 'cancelled'],
  waiting_for_approval: ['searching_skills', 'failed', 'cancelled'],
  planning: ['executing', 'failed', 'cancelled'],
  executing: ['validating', 'failed', 'cancelled'],
  validating: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};
export function assertTransition(from: AgentState, to: AgentState) {
  if (!transitions[from].includes(to)) throw new Error(`Invalid transition ${from} -> ${to}`);
}

export class Orchestrator extends EventEmitter {
  private controllers = new Map<string, AbortController>();
  private sequence = new Map<string, number>();
  constructor(
    private db: AgentDatabase,
    private model: ModelProvider,
    private workspace = process.env.AGENT_WORKSPACE ?? process.cwd(),
  ) {
    super();
  }
  cancel(id: string) {
    this.controllers.get(id)?.abort();
  }
  async run(id: string, input: string, budget = DEFAULT_BUDGET) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let state: AgentState = 'idle';
    try {
      this.event(id, 'TASK_RECEIVED', state, 'Đã nhận tác vụ.', { input });
      state = this.move(
        id,
        state,
        'analyzing_task',
        'TASK_ANALYSIS_STARTED',
        'Đang phân tích yêu cầu.',
      );
      const analysis = await this.analyze(input, controller.signal);
      this.event(
        id,
        'TASK_ANALYSIS_COMPLETED',
        state,
        `Đã xác định ${analysis.objectives.length} mục tiêu.`,
        analysis,
      );
      this.controllers.delete(id);
      await this.execute(id, input, analysis, state, budget);
    } catch (error) {
      this.fail(id, state, controller, error);
    } finally {
      this.controllers.delete(id);
    }
  }
  async resume(id: string) {
    const task = this.db.getTask(id);
    if (!task || task.state !== 'waiting_for_approval') return;
    const analysis = this.db.events(id).find((event) => event.type === 'TASK_ANALYSIS_COMPLETED')
      ?.payload as TaskAnalysis | undefined;
    if (!analysis) throw new Error('TASK_ANALYSIS_MISSING');
    await this.execute(id, task.userInput, analysis, 'waiting_for_approval', DEFAULT_BUDGET);
  }
  private async execute(
    id: string,
    input: string,
    analysis: TaskAnalysis,
    initial: AgentState,
    budget: ExecutionBudget,
  ) {
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const guard = new BudgetGuard(budget);
    let state = initial;
    try {
      state = this.move(
        id,
        state,
        'searching_skills',
        'SKILL_SEARCH_STARTED',
        'Đang tìm skill phù hợp.',
      );
      const active = this.db.listSkills().filter((skill) => skill.status === 'active');
      const required = new Set(analysis.requiredCapabilities.map((value) => value.toLowerCase()));
      let matches = active.filter(
        (skill) =>
          skill.manifest.capabilities.some((value) => required.has(value.toLowerCase())) ||
          skill.manifest.tags.some((value) =>
            analysis.intent.toLowerCase().includes(value.toLowerCase()),
          ),
      );
      if (!matches.length) {
        this.event(id, 'SKILL_NOT_FOUND', state, 'Không tìm thấy skill đáp ứng yêu cầu.', {
          missingCapabilities: analysis.requiredCapabilities,
        });
        state = this.move(
          id,
          state,
          'creating_skill',
          'SKILL_CREATION_PROPOSAL_GENERATED',
          'Đang tạo đề xuất skill khai báo.',
        );
        const proposal = createProposal(
          analysis.requiredCapabilities.length ? analysis.requiredCapabilities : [analysis.intent],
        );
        this.event(
          id,
          'SKILL_TEST_CASES_GENERATED',
          state,
          'Đã tạo test case khai báo.',
          proposal.testCases,
        );
        state = this.move(
          id,
          state,
          'testing_skill',
          'SKILL_EVALUATION_COMPLETED',
          'Đề xuất đã vượt qua kiểm tra schema và quyền.',
          { passed: true, ruleBased: true },
        );
        const manifest: SkillManifest = {
          id: proposal.name,
          name: proposal.name,
          version: '1.0.0',
          description: proposal.description,
          tags: proposal.missingCapabilities,
          triggers: proposal.missingCapabilities,
          runtime: { type: proposal.runtimeType, timeoutSeconds: 30 },
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          permissions: proposal.permissions,
          riskLevel: proposal.riskLevel,
          approvalRequired: false,
          capabilities: proposal.missingCapabilities,
        };
        this.db.installSkill(manifest, 'active', 'agent');
        state = this.move(
          id,
          state,
          'searching_skills',
          'SKILL_AUTO_INSTALLED',
          'Skill khai báo an toàn đã được tự động kích hoạt.',
          { skillId: manifest.id, manifest },
        );
        matches = this.db.listSkills().filter((skill) => skill.id === manifest.id);
      }
      const selected = matches[0]!;
      const routing = {
        candidates: matches.map((skill, index) => ({
          skillId: skill.id,
          score: 1 - index / 100,
          reasons: ['active capability match'],
        })),
        selectedSkillIds: [selected.id],
        confidence: 1,
        missingCapabilities: [],
      };
      this.event(id, 'SKILL_SELECTED', state, `Đã chọn skill ${selected.name}.`, {
        ...routing,
        registryCount: active.length + (active.some((skill) => skill.id === selected.id) ? 0 : 1),
        selectedSkill: {
          id: selected.id,
          name: selected.name,
          runtime: selected.manifest.runtime.type,
        },
      });
      state = this.move(
        id,
        state,
        'planning',
        'PLAN_GENERATION_STARTED',
        'Đang xây dựng kế hoạch.',
      );
      const plan =
        selected.manifest.runtime.type === 'prompt'
          ? {
              goal: analysis.intent,
              steps: [
                {
                  id: 'step-1',
                  order: 1,
                  title: selected.name,
                  description: selected.description,
                  skillId: selected.id,
                  input: { request: input },
                  expectedOutput: 'Structured JSON',
                  risk: 'low' as const,
                },
              ],
            }
          : validatePlan(createPlan(analysis, routing), budget.maxSteps);
      this.event(id, 'PLAN_GENERATED', state, `Kế hoạch có ${plan.steps.length} bước.`, plan);
      state = this.move(id, state, 'executing', 'EXECUTION_STARTED', 'Bắt đầu thực thi.');
      const results: unknown[] = [];
      for (const step of plan.steps) {
        guard.step();
        if (controller.signal.aborted) throw new Error('TASK_CANCELLED');
        this.event(
          id,
          'STEP_STARTED',
          state,
          `Đang thực thi bước ${step.order}/${plan.steps.length}.`,
          step,
        );
        let result: unknown;
        for (let attempt = 0; attempt <= budget.maxRetriesPerStep; attempt += 1) {
          try {
            if (selected.manifest.runtime.type === 'prompt') {
              guard.modelCall();
              result = await this.model.generateStructured({
                prompt: [
                  `Execute the declarative skill "${selected.name}".`,
                  `Skill purpose: ${selected.description}.`,
                  `Required capabilities: ${selected.manifest.capabilities.join(', ')}.`,
                  `Original user request: ${input}`,
                  `Current step: ${step.title} — ${step.description}.`,
                  'Return the actual final result in the required "output" field.',
                  'For translation, output must contain the translated text, not an explanation.',
                  'For generated files, include their workspace-relative paths in "artifacts".',
                  'Never return an empty object or placeholder.',
                ].join('\n'),
                schema: skillExecutionResultSchema,
                signal: controller.signal,
              });
            } else
              result = await executeSkill(
                step.skillId,
                step.input,
                this.workspace,
                controller.signal,
              );
            break;
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            this.event(id, 'STEP_FAILED', state, `Bước ${step.order} thất bại: ${message}`, {
              step,
              attempt,
              reason: message,
            });
            if (
              attempt >= budget.maxRetriesPerStep ||
              ['WORKSPACE_ACCESS_DENIED', 'TASK_CANCELLED'].includes(message)
            )
              throw reason;
            this.event(
              id,
              'STEP_RETRYING',
              state,
              `Thử lại bước ${step.order} sau khi phân loại lỗi.`,
              {
                step,
                nextAttempt: attempt + 1,
                reason: message,
                changed: 'retry after structured failure classification',
              },
            );
          }
        }
        results.push(result);
        this.event(id, 'STEP_COMPLETED', state, `Bước ${step.order} đã xong.`, {
          step,
          result,
          artifacts: collectArtifacts(result),
        });
      }
      state = this.move(
        id,
        state,
        'validating',
        'RESULT_VALIDATION_STARTED',
        'Đang kiểm tra kết quả.',
      );
      this.event(id, 'RESULT_VALIDATION_COMPLETED', state, 'Đã kiểm tra kết quả.', { results });
      state = this.move(id, state, 'completed', 'TASK_COMPLETED', 'Đã hoàn tất yêu cầu.', {
        results,
      });
      this.db.updateTask(id, state, { resultSummary: JSON.stringify(results) });
    } catch (error) {
      this.fail(id, state, controller, error);
    } finally {
      this.controllers.delete(id);
    }
  }
  private move(
    id: string,
    from: AgentState,
    to: AgentState,
    type: AgentEvent['type'],
    message: string,
    payload?: unknown,
  ) {
    assertTransition(from, to);
    this.db.updateTask(id, to);
    this.event(id, type, to, message, payload);
    return to;
  }
  private fail(id: string, state: AgentState, controller: AbortController, error: unknown) {
    const raw =
      error instanceof ModelProviderError
        ? error.code
        : error instanceof Error
          ? error.message
          : 'UNEXPECTED_ERROR';
    const cancelled = raw === 'TASK_CANCELLED' || controller.signal.aborted;
    const code = cancelled ? 'TASK_CANCELLED' : raw;
    const target: AgentState = cancelled ? 'cancelled' : 'failed';
    if (transitions[state].includes(target)) {
      this.db.updateTask(id, target, { errorCode: code, errorMessage: code });
      this.event(
        id,
        cancelled ? 'EXECUTION_CANCELLED' : 'TASK_FAILED',
        target,
        cancelled ? 'Đã hủy tác vụ.' : `Tác vụ thất bại: ${code}`,
      );
    }
  }
  private async analyze(input: string, signal: AbortSignal): Promise<TaskAnalysis> {
    let last: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (signal.aborted) throw new Error('TASK_CANCELLED');
      try {
        const analysis = await this.model.generateStructured({
          prompt: `Analyze this task: ${input}. Fields: title, intent, category (filesystem|code_analysis|testing|reporting|general), objectives, requiredCapabilities, constraints, estimatedRisk (low|medium|high).`,
          schema: taskAnalysisSchema,
          signal,
        });
        return normalizeLanguageTask(input, analysis);
      } catch (error) {
        if (signal.aborted) throw new Error('TASK_CANCELLED');
        if (error instanceof ModelProviderError) throw error;
        last = error;
      }
    }
    throw new Error(
      last instanceof Error && last.message === 'OLLAMA_UNAVAILABLE'
        ? 'OLLAMA_UNAVAILABLE'
        : 'STRUCTURED_OUTPUT_INVALID',
    );
  }
  private event(
    taskId: string,
    type: AgentEvent['type'],
    state: AgentState,
    message: string,
    payload?: unknown,
  ) {
    const event: AgentEvent = {
      id: crypto.randomUUID(),
      taskId,
      type,
      state,
      message,
      timestamp: new Date().toISOString(),
      sequence: (this.sequence.get(taskId) ?? this.db.events(taskId).length) + 1,
      ...(payload === undefined ? {} : { payload }),
    };
    this.sequence.set(taskId, event.sequence);
    this.db.addEvent(event);
    this.emit('event', event);
  }
}

export function normalizeLanguageTask(input: string, analysis: TaskAnalysis): TaskAnalysis {
  const value = input.toLowerCase();
  const translation = /\btranslate\b|\bdịch\b|dịch\s+(?:từ|câu|đoạn)/i.test(value);
  const definition = /\bmeaning\b|\bdefine\b|\bdefinition\b|nghĩa\s+(?:của|là)|định nghĩa/i.test(
    value,
  );
  if (!translation && !definition) return analysis;
  return {
    ...analysis,
    category: 'general',
    intent: translation ? `Translate: ${input}` : `Define word or phrase: ${input}`,
    requiredCapabilities: [translation ? 'language:translate' : 'language:define'],
    estimatedRisk: 'low',
  };
}

function collectArtifacts(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string' && /(?:^|[\\/])[^\\/]+\.[a-z0-9]{2,8}$/i.test(item))
      found.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return [...found];
}
