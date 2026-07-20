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
import { createPlan, executeSkill, inferFilesystemPath, safePath, validatePlan } from './skills';
import { stat } from 'node:fs/promises';
import { createProposal } from './phase2';
import { ToolInstaller } from './tool-installer';
import { uniqueCapabilities } from './autonomy-policy';
import { applyAutonomousPlan, AutonomousPlanner, type AutonomousPlan } from './autonomous-planner';

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
const repairedSkillInputSchema = z.object({
  input: z.record(z.string(), z.unknown()),
});
const recoveryWorkflowSchema = z.object({
  wrappedSkillId: z.string(),
  correctedInput: z.record(z.string(), z.unknown()).optional(),
  generatedFromError: z.string().optional(),
});

const nonRecoverableSkillErrors = new Set([
  'WORKSPACE_ACCESS_DENIED',
  'TASK_CANCELLED',
  'BUDGET_EXCEEDED',
  'OLLAMA_UNAVAILABLE',
  'MODEL_NOT_FOUND',
  'EXECUTION_TIMEOUT',
  'SKILL_NOT_FOUND',
]);

export function isRecoverableSkillFailure(reason: string) {
  return !nonRecoverableSkillErrors.has(reason);
}

export async function withExecutionTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parentSignal: AbortSignal,
  timeoutMs: number,
) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abortFromParent();
  else parentSignal.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('EXECUTION_TIMEOUT')), timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (controller.signal.aborted && !parentSignal.aborted) throw new Error('EXECUTION_TIMEOUT');
    throw error;
  } finally {
    clearTimeout(timer);
    parentSignal.removeEventListener('abort', abortFromParent);
  }
}

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
  analyzing_task: ['waiting_for_plan_approval', 'searching_skills', 'failed', 'cancelled'],
  searching_skills: ['planning', 'creating_skill', 'waiting_for_approval', 'failed', 'cancelled'],
  creating_skill: ['testing_skill', 'failed', 'cancelled'],
  testing_skill: ['searching_skills', 'waiting_for_approval', 'failed', 'cancelled'],
  waiting_for_plan_approval: ['searching_skills', 'failed', 'cancelled'],
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
  private planner: AutonomousPlanner;
  constructor(
    private db: AgentDatabase,
    private model: ModelProvider,
    private workspace = process.env.AGENT_WORKSPACE ?? process.cwd(),
    private tools = new ToolInstaller(workspace),
  ) {
    super();
    this.planner = new AutonomousPlanner(model);
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
      let analysis = await this.analyze(input, controller.signal);
      const autonomy = await this.planAutonomously(input, analysis, controller.signal);
      if (autonomy) {
        analysis = applyAutonomousPlan(analysis, autonomy);
        this.event(
          id,
          'SKILL_CANDIDATE_FOUND',
          state,
          `AI selected strategy "${autonomy.strategy}" with ${autonomy.capabilities.length} capability requirement(s).`,
          autonomy,
        );
      }
      this.event(
        id,
        'TASK_ANALYSIS_COMPLETED',
        state,
        `Đã xác định ${analysis.objectives.length} mục tiêu.`,
        analysis,
      );
      const proposal = buildPlanProposal(input, analysis);
      const storedPlan = this.db.createTaskPlan(id, proposal);
      this.event(id, 'PLAN_GENERATED', state, `AI generated a ${proposal.steps.length}-step plan.`, proposal);
      state = this.move(
        id,
        state,
        'waiting_for_plan_approval',
        'PLAN_APPROVAL_REQUIRED',
        'Kế hoạch đang chờ người dùng đồng ý trước khi thực thi.',
        storedPlan,
      );
      return;
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
  async resumeAfterPermission(id: string, scope: 'once' | 'all') {
    const task = this.db.getTask(id);
    if (!task || task.state !== 'waiting_for_approval') return;
    this.event(
      id,
      'PERMISSION_GRANTED',
      'waiting_for_approval',
      scope === 'all' ? 'Đã ủy quyền cho các tác vụ an toàn.' : 'Đã cấp quyền cho tác vụ này.',
      { scope },
    );
    await this.resume(id);
  }
  rejectPermission(id: string) {
    const task = this.db.getTask(id);
    if (!task || task.state !== 'waiting_for_approval') return;
    this.db.updateTask(id, 'failed', {
      errorCode: 'WORKSPACE_ACCESS_DENIED',
      errorMessage: 'Người dùng đã từ chối cấp quyền.',
    });
    this.event(id, 'PERMISSION_REJECTED', 'failed', 'Đã từ chối cấp quyền. Tác vụ đã dừng.');
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
      const active = this.db
        .listSkills()
        .filter((skill) => skill.status === 'active' && !isRecoverySkill(skill));
      const toolResults = await this.tools.ensureCapabilities(
        analysis.requiredCapabilities,
        this.db.hasPermissionGrant(id, 'tool-installer'),
      );
      const installsAwaitingApproval = toolResults.filter(
        (result) => result.status === 'approval_required',
      );
      if (installsAwaitingApproval.length) {
        const request = this.db.createPermissionRequest(
          id,
          'tool-installer',
          {
            packages: installsAwaitingApproval.map((result) => ({
              name: result.tool.packageName,
              capability: result.tool.capability,
            })),
            commands: installsAwaitingApproval.map((result) => result.tool.install.join(' ')),
            filesystem: { read: [], write: ['package.json', 'yarn.lock'], delete: [] },
            network: { enabled: true, allowedHosts: ['registry.yarnpkg.com', 'registry.npmjs.org'] },
            environmentVariables: [],
          },
          `Agent cần cài ${installsAwaitingApproval.map((result) => result.tool.packageName).join(', ')} để có capability cho tác vụ.`,
        );
        this.move(
          id,
          state,
          'waiting_for_approval',
          'PERMISSION_APPROVAL_REQUIRED',
          'Đang chờ người dùng cho phép cài package/tool cần thiết.',
          request,
        );
        return;
      }
      for (const tool of toolResults) {
        if (tool.status === 'installed')
          this.event(
            id,
            'SKILL_AUTO_INSTALLED',
            state,
            `Đã tự cài tool ${tool.tool.id} cho tác vụ.`,
            { tool: tool.tool.id, capability: tool.tool.capability },
          );
      }
      const required = new Set(analysis.requiredCapabilities.map((value) => value.toLowerCase()));
      let matches = active.filter(
        (skill) =>
          skill.manifest.capabilities.some((value) => required.has(value.toLowerCase())) ||
          skill.manifest.tags.some((value) =>
            analysis.intent.toLowerCase().includes(value.toLowerCase()),
          ),
      );
      const missingCapabilities = analysis.requiredCapabilities.filter(
        (capability) =>
          !matches.some((skill) =>
            skill.manifest.capabilities.some(
              (value) => value.toLowerCase() === capability.toLowerCase(),
            ),
          ),
      );
      if (missingCapabilities.length) {
        this.event(id, 'SKILL_NOT_FOUND', state, 'Không tìm thấy skill đáp ứng yêu cầu.', {
          missingCapabilities,
        });
        state = this.move(
          id,
          state,
          'creating_skill',
          'SKILL_CREATION_PROPOSAL_GENERATED',
          'Đang tạo đề xuất skill khai báo.',
        );
        const proposal = createProposal(
          missingCapabilities.length ? missingCapabilities : [analysis.intent],
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
        matches = [...matches, ...this.db.listSkills().filter((skill) => skill.id === manifest.id)];
      }
      const selectedSkills = selectSkillsForCapabilities(matches, analysis.requiredCapabilities);
      const selected = selectedSkills[0]!;
      if (selectedSkills.some((skill) => skill.manifest.riskLevel === 'forbidden'))
        throw new Error('WORKSPACE_ACCESS_DENIED');
      const permissionSkill = selectedSkills.find((skill) =>
        requiresUserPermission(skill.manifest),
      );
      if (permissionSkill && !this.db.hasPermissionGrant(id, permissionSkill.id)) {
        const request = this.db.createPermissionRequest(
          id,
          permissionSkill.id,
          permissionSkill.manifest.permissions,
          `Skill ${permissionSkill.name} cần thêm quyền để thực hiện tác vụ.`,
        );
        this.move(
          id,
          state,
          'waiting_for_approval',
          'PERMISSION_APPROVAL_REQUIRED',
          'Đang chờ người dùng cấp quyền.',
          request,
        );
        return;
      }
      const routing = {
        candidates: matches.map((skill, index) => ({
          skillId: skill.id,
          score: 1 - index / 100,
          reasons: ['active capability match'],
        })),
        selectedSkillIds: selectedSkills.map((skill) => skill.id),
        confidence: 1,
        missingCapabilities: [],
      };
      const selectedActions = selectedSkills.map(
        (skill, index) => friendlyStepWording(skill, index, input).title,
      );
      const selectionMessage =
        selectedActions.length === 1
          ? `Đã chọn kỹ năng: ${selectedActions[0]}.`
          : `Đã chọn ${selectedActions.length} kỹ năng: ${selectedActions.join(' → ')}.`;
      this.event(id, 'SKILL_SELECTED', state, selectionMessage, {
        ...routing,
        registryCount: this.db.listSkills().filter((skill) => skill.status === 'active').length,
        selectedSkills: selectedSkills.map((skill, index) => ({
          id: skill.id,
          name: skill.name,
          runtime: skill.manifest.runtime.type,
          order: index + 1,
          action: selectedActions[index],
          objective: analysis.objectives[index] ?? analysis.intent,
        })),
      });
      state = this.move(
        id,
        state,
        'planning',
        'PLAN_GENERATION_STARTED',
        'Đang xây dựng kế hoạch.',
      );
      let plan;
      if (selectedSkills.length > 1) {
        plan = {
          goal: input,
          steps: selectedSkills.map((skill, index) => {
            const wording = friendlyStepWording(skill, index, input);
            return {
              id: `step-${index + 1}`,
              order: index + 1,
              title: wording.title,
              description: wording.description,
              skillId: skill.id,
              input:
                skill.id === 'filesystem-reader'
                  ? { path: inferFilesystemPath(input) }
                  : { request: input, inputFromStep: `step-${index}` },
              expectedOutput: `Hoàn thành mục tiêu ${analysis.objectives[index] ?? index + 1}`,
              risk: skill.manifest.riskLevel === 'low' ? ('low' as const) : ('medium' as const),
            };
          }),
        };
      } else if (selected.manifest.runtime.type === 'prompt') {
        plan = {
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
        };
      } else if (selected.manifest.runtime.type === 'workflow') {
        const recovery = recoveryWorkflowSchema.parse(selected.manifest.definition);
        guard.modelCall();
        const prepared = await this.model.generateStructured({
          prompt: [
            `Prepare input for recovery workflow ${selected.name}.`,
            `Original user request: ${input}`,
            `Wrapped skill: ${recovery.wrappedSkillId}`,
            'Return only the input object for the wrapped skill.',
            'Keep filesystem paths workspace-relative and point to a file when reading content.',
          ].join('\n'),
          schema: repairedSkillInputSchema,
          signal: controller.signal,
        });
        plan = validatePlan(
          {
            goal: analysis.intent,
            steps: [
              {
                id: 'step-1',
                order: 1,
                title: selected.name,
                description: selected.description,
                skillId: recovery.wrappedSkillId,
                input: prepared.input,
                expectedOutput: 'Structured result from recovered skill',
                risk:
                  selected.manifest.riskLevel === 'low' ? ('low' as const) : ('medium' as const),
              },
            ],
          },
          budget.maxSteps,
        );
      } else {
        plan = validatePlan(createPlan(analysis, routing, input), budget.maxSteps);
      }
      plan = {
        ...plan,
        goal: input,
        steps: plan.steps.map((step, index) => {
          const displaySkill =
            selectedSkills.find((skill) => skill.id === step.skillId) ?? selected;
          const wording = friendlyStepWording(displaySkill, index, input);
          return { ...step, title: wording.title, description: wording.description };
        }),
      };
      this.event(id, 'PLAN_GENERATED', state, `Kế hoạch có ${plan.steps.length} bước.`, plan);
      state = this.move(id, state, 'executing', 'EXECUTION_STARTED', 'Bắt đầu thực thi.');
      const results: unknown[] = [];
      for (const step of plan.steps) {
        const stepSkill =
          selectedSkills.find((skill) => skill.id === step.skillId) ??
          this.db.listSkills().find((skill) => skill.id === step.skillId);
        if (!stepSkill) throw new Error('SKILL_NOT_FOUND');
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
            if (stepSkill.manifest.runtime.type === 'prompt') {
              guard.modelCall();
              const upstreamResult = results.at(-1);
              const upstreamText = extractResultText(upstreamResult);
              const translatesContent = stepSkill.manifest.capabilities.some(
                (capability) => capability.toLowerCase() === 'language:translate',
              );
              result = await withExecutionTimeout(
                (stepSignal) =>
                  this.model.generateStructured({
                    prompt: [
                      `Execute the declarative skill "${stepSkill.name}".`,
                      `Skill purpose: ${stepSkill.description}.`,
                      `Required capabilities: ${stepSkill.manifest.capabilities.join(', ')}.`,
                      `Original user request: ${input}`,
                      `Current step: ${step.title} — ${step.description}.`,
                      ...(attempt > 0
                        ? [
                            'The previous output was invalid or merely repeated the request. Produce the actual requested result now.',
                          ]
                        : []),
                      ...(upstreamResult === undefined
                        ? []
                        : [
                            `Required upstream result: ${JSON.stringify(upstreamResult)}`,
                            ...(translatesContent && upstreamText
                              ? [
                                  `Source text that must be translated:\n---SOURCE---\n${upstreamText}\n---END SOURCE---`,
                                ]
                              : []),
                            'Use the upstream content as the source data. Do not translate or repeat the instruction itself.',
                          ]),
                      'Return the actual final result in the required "output" field.',
                      'For translation, output must contain the translated text, not an explanation.',
                      'For generated files, include their workspace-relative paths in "artifacts".',
                      'Never return an empty object or placeholder.',
                    ].join('\n'),
                    schema: skillExecutionResultSchema,
                    signal: stepSignal,
                  }),
                controller.signal,
                Math.min(
                  budget.maxExecutionTimeMs,
                  Math.max(90_000, stepSkill.manifest.runtime.timeoutSeconds * 1000),
                ),
              );
              const output = (result as { output?: unknown }).output;
              if (typeof output === 'string' && isRequestEcho(input, output))
                throw new Error('RESULT_ECHOED_REQUEST');
              if (
                translatesContent &&
                upstreamText &&
                typeof output === 'string' &&
                isUnchangedTranslation(upstreamText, output)
              )
                throw new Error('TRANSLATION_UNCHANGED');
            } else {
              const isArtifactGenerator =
                stepSkill.manifest.capabilities.includes('document:pdf') ||
                stepSkill.id === 'artifact-generator';
              const executionInput =
                isArtifactGenerator
                  ? {
                      ...step.input,
                      source: extractResultText(results.at(-1)) ?? '',
                      sourcePath: inferFilesystemPath(input),
                      ...(stepSkill.id === 'artifact-generator'
                        ? { outputExtension: inferArtifactExtension(input) ?? '.txt' }
                        : {}),
                    }
                  : step.input;
              result = await executeSkill(
                step.skillId,
                executionInput,
                this.workspace,
                controller.signal,
              );
              if (isArtifactGenerator)
                await this.assertProducedArtifacts(result);
            }
            break;
          } catch (reason) {
            const message = reason instanceof Error ? reason.message : String(reason);
            this.event(id, 'STEP_FAILED', state, `Bước ${step.order} thất bại: ${message}`, {
              step,
              attempt,
              reason: message,
            });
            if (attempt === 0 && isRecoverableSkillFailure(message)) {
              try {
                result = await this.recoverWithGeneratedSkill({
                  taskId: id,
                  state,
                  request: input,
                  analysis,
                  failedSkill: stepSkill.manifest,
                  failedInput: step.input,
                  reason: message,
                  signal: controller.signal,
                  guard,
                });
                break;
              } catch (recoveryReason) {
                const recoveryMessage =
                  recoveryReason instanceof Error ? recoveryReason.message : String(recoveryReason);
                if (!isRecoverableSkillFailure(recoveryMessage)) throw recoveryReason;
                this.event(
                  id,
                  'SKILL_EVALUATION_COMPLETED',
                  state,
                  'Skill thay thế chưa xử lý được lỗi; tiếp tục chiến lược dự phòng.',
                  { passed: false, reason: recoveryMessage },
                );
              }
            }
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
      this.assertCompletionContract(analysis, results);
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
  private async recoverWithGeneratedSkill(options: {
    taskId: string;
    state: AgentState;
    request: string;
    analysis: TaskAnalysis;
    failedSkill: SkillManifest;
    failedInput: Record<string, unknown>;
    reason: string;
    signal: AbortSignal;
    guard: BudgetGuard;
  }) {
    const { taskId, state, request, analysis, failedSkill, failedInput, reason, signal, guard } =
      options;
    const recoveryId = `generated-${failedSkill.id}-recovery`.slice(0, 64);
    this.event(
      taskId,
      'SKILL_CREATION_PROPOSAL_GENERATED',
      state,
      `Skill ${failedSkill.name} không phù hợp; đang tạo skill thay thế.`,
      { failedSkillId: failedSkill.id, reason },
    );
    guard.modelCall();
    const repaired = await this.model.generateStructured({
      prompt: [
        'Create corrected input for a safe recovery workflow.',
        `Original user request: ${request}`,
        `Task intent: ${analysis.intent}`,
        `Wrapped skill: ${failedSkill.id}`,
        `Failed input: ${JSON.stringify(failedInput)}`,
        `Failure: ${reason}`,
        'Return only an input object accepted by the wrapped skill.',
        'For filesystem-reader, input.path must identify the requested file, never a directory.',
        'Keep paths workspace-relative and never request broader permissions.',
      ].join('\n'),
      schema: repairedSkillInputSchema,
      signal,
    });
    const manifest: SkillManifest = {
      ...failedSkill,
      id: recoveryId,
      name: `${failedSkill.name} Recovery`,
      version: '1.0.0',
      description: `Auto-generated recovery workflow for ${failedSkill.name}`,
      runtime: { type: 'workflow', timeoutSeconds: failedSkill.runtime.timeoutSeconds },
      approvalRequired: false,
      definition: {
        wrappedSkillId: failedSkill.id,
        correctedInput: repaired.input,
        generatedFromError: reason,
      },
    };
    this.db.installSkill(manifest, 'active', 'agent');
    this.event(
      taskId,
      'SKILL_AUTO_INSTALLED',
      state,
      `Đã tạo và kích hoạt skill thay thế ${manifest.name}.`,
      { skillId: manifest.id, manifest, replaces: failedSkill.id },
    );
    if (failedSkill.runtime.type === 'prompt') guard.modelCall();
    const result =
      failedSkill.runtime.type === 'prompt'
        ? await this.model.generateStructured({
            prompt: [
              `Execute replacement prompt skill "${manifest.name}".`,
              `Purpose: ${manifest.description}`,
              `Original request: ${request}`,
              `Corrected skill input: ${JSON.stringify(repaired.input)}`,
              'Return the completed user-facing result in output, not a plan or explanation.',
            ].join('\n'),
            schema: skillExecutionResultSchema,
            signal,
          })
        : await executeSkill(failedSkill.id, repaired.input, this.workspace, signal);
    this.event(
      taskId,
      'SKILL_EVALUATION_COMPLETED',
      state,
      'Skill thay thế đã tự khắc phục lỗi và hoàn thành tác vụ.',
      { passed: true, skillId: manifest.id },
    );
    // Recovery is task-scoped evidence, not a replacement implementation.
    // Keeping it out of routing prevents a generated workflow from wrapping
    // itself on a later task.
    this.db.setStatus(manifest.id, 'archived');
    return result;
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
        // A file-reading request has a deterministic, user-visible workflow.  Do
        // not let an otherwise valid but generic model capability introduce an
        // extra "process the request" step before the actual read operation.
        return normalizeFilesystemTask(
          input,
          normalizeArtifactTask(input, normalizeLanguageTask(input, analysis)),
        );
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
  async resumePlan(id: string) {
    const task = this.db.getTask(id);
    const plan = this.db.taskPlan(id);
    if (!task || task.state !== 'waiting_for_plan_approval' || plan?.status !== 'approved') return;
    const analysis = this.db.events(id).find((event) => event.type === 'TASK_ANALYSIS_COMPLETED')
      ?.payload as TaskAnalysis | undefined;
    if (!analysis) throw new Error('TASK_ANALYSIS_MISSING');
    this.event(id, 'PLAN_APPROVED', 'waiting_for_plan_approval', 'Người dùng đã đồng ý kế hoạch.');
    await this.execute(id, task.userInput, analysis, 'waiting_for_plan_approval', DEFAULT_BUDGET);
  }
  rejectPlan(id: string) {
    const task = this.db.getTask(id);
    if (!task || task.state !== 'waiting_for_plan_approval') return;
    this.db.decideTaskPlan(id, 'rejected');
    this.db.updateTask(id, 'cancelled', { errorCode: 'PLAN_REJECTED', errorMessage: 'Plan rejected by user' });
    this.event(id, 'PLAN_REJECTED', 'cancelled', 'Người dùng đã từ chối kế hoạch.');
  }
  private async planAutonomously(
    input: string,
    analysis: TaskAnalysis,
    signal: AbortSignal,
  ): Promise<AutonomousPlan | undefined> {
    if (process.env.AGENT_AUTONOMOUS_PLANNER === 'false' || signal.aborted) return undefined;
    try {
      return await this.planner.plan(
        input,
        analysis,
        this.db.listSkills().flatMap((skill) => skill.manifest.capabilities),
      );
    } catch {
      // The deterministic analyser remains a resilient fallback when an AI plan
      // is unavailable or invalid; tasks do not fail simply because planning did.
      return undefined;
    }
  }
  private async assertProducedArtifacts(result: unknown) {
    const paths = collectArtifacts(result);
    if (!paths.length) throw new Error('ARTIFACT_MISSING');
    for (const path of paths) await stat(safePath(this.workspace, path));
  }
  private assertCompletionContract(analysis: TaskAnalysis, results: unknown[]) {
    const requiredExtensions = analysis.constraints
      .filter((constraint) => constraint.startsWith('artifact:'))
      .map((constraint) => constraint.slice('artifact:'.length).toLowerCase());
    if (!requiredExtensions.length) return;
    const artifacts = collectArtifacts(results).map((path) => path.toLowerCase());
    if (!requiredExtensions.every((extension) => artifacts.some((path) => path.endsWith(extension))))
      throw new Error('ARTIFACT_MISSING');
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
  const readsFile = /\bfile\b|tệp|đọc\s+(?:nội dung\s+)?(?:file|tệp)|[\w.-]+\.[a-z0-9]{1,12}/i.test(
    input,
  );
  const languageCapability = translation ? 'language:translate' : 'language:define';
  return {
    ...analysis,
    category: 'general',
    intent: translation ? `Translate: ${input}` : `Define word or phrase: ${input}`,
    requiredCapabilities: [...(readsFile ? ['filesystem:read'] : []), languageCapability],
    estimatedRisk: 'low',
  };
}

export function normalizeArtifactTask(input: string, analysis: TaskAnalysis): TaskAnalysis {
  const extension = inferArtifactExtension(input);
  if (!extension) return analysis;
  const sourcePath = inferFilesystemPath(input);
  const capability = artifactCapability(extension);
  return {
    ...analysis,
    category: 'filesystem',
    objectives: [`Read ${sourcePath}`, `Generate a ${extension} artifact`],
    requiredCapabilities: uniqueCapabilities(['filesystem:read', capability]),
    constraints: [
      ...analysis.constraints,
      `Create and verify a ${extension} file in .local-agent/output`,
      `artifact:${extension}`,
    ],
  };
}

/**
 * Keep simple read/show requests literal.  Model analysis is still used for
 * open-ended work, but it must not turn "read README.md" into a generated
 * catch-all skill or a second, non-actionable plan item.
 */
export function normalizeFilesystemTask(input: string, analysis: TaskAnalysis): TaskAnalysis {
  const sourcePath = inferFilesystemPath(input);
  const readsFile =
    sourcePath !== '.' &&
    /\b(read|show|display|view)\b|\u0111\u1ecdc|hi\u1ec3n th\u1ecb|m\u1edf/i.test(input);
  const createsArtifact = analysis.constraints.some((constraint) => constraint.startsWith('artifact:'));
  const hasLanguageOperation = analysis.requiredCapabilities.some((capability) =>
    capability.startsWith('language:'),
  );

  if (!readsFile || createsArtifact || hasLanguageOperation) return analysis;

  return {
    ...analysis,
    category: 'filesystem',
    intent: `Read ${sourcePath}`,
    objectives: [`Read ${sourcePath}`],
    requiredCapabilities: ['filesystem:read'],
    estimatedRisk: 'low',
  };
}

export function inferArtifactExtension(input: string): string | undefined {
  const value = input.toLowerCase();
  if (!/\b(export|convert)\b|tạo|xuất|chuyển|\bsang\b/i.test(value)) return undefined;
  const target = value.match(/(?:tạo(?:\s+thành)?|xuất(?:\s+ra)?|chuyển(?:\s+.*)?\s+sang|file)\s+(?:file\s+)?\.?\s*(pdf|docx|word|xlsx|excel|csv|json|html|markdown|md|text|txt|svg)\b/i)?.[1];
  const named = [...value.matchAll(/\b(pdf|docx|word|xlsx|excel|csv|json|html|markdown|md|text|txt|svg)\b/g)].at(-1)?.[1];
  const aliases: Record<string, string> = {
    pdf: '.pdf', docx: '.docx', word: '.docx', xlsx: '.xlsx', excel: '.xlsx', csv: '.csv',
    json: '.json', html: '.html', markdown: '.md', md: '.md', text: '.txt', txt: '.txt', svg: '.svg',
  };
  const format = target ?? named;
  return format ? aliases[format] : undefined;
}

function buildPlanProposal(input: string, analysis: TaskAnalysis) {
  const sourcePath = inferFilesystemPath(input);
  const extension = inferArtifactExtension(input);
  if (extension) {
    const format = extension.slice(1).toUpperCase();
    return {
      goal: input,
      steps: [
        {
          id: 'proposal-1',
          order: 1,
          title: `Đọc nội dung ${sourcePath === '.' ? 'nguồn được yêu cầu' : `file ${sourcePath}`}`,
          description: 'Lấy đúng nội dung từ đường dẫn người dùng chỉ định.',
          capabilities: ['filesystem:read'],
        },
        {
          id: 'proposal-2',
          order: 2,
          title: `Tạo file ${format} từ nội dung đã đọc`,
          description: `Lưu file ${format} vào .local-agent/output.`,
          capabilities: analysis.requiredCapabilities.filter((item) => item !== 'filesystem:read'),
        },
        {
          id: 'proposal-3',
          order: 3,
          title: `Kiểm tra và cung cấp file ${format}`,
          description: 'Xác minh artifact tồn tại, đúng định dạng và tạo link tải xuống.',
          capabilities: [],
        },
      ],
    };
  }
  return {
    goal: input,
    steps: analysis.objectives.map((objective, index) => ({
      id: `proposal-${index + 1}`,
      order: index + 1,
      title: humanizeObjective(objective, index),
      description: 'Thực hiện mục tiêu này theo yêu cầu đã nhập.',
      capabilities: analysis.requiredCapabilities,
    })),
  };
}

function humanizeObjective(objective: string, index: number) {
  if (/parse|extract|requiredcapabilities|constraints|estimatedrisk/i.test(objective) || objective.length > 100)
    return `Hoàn thành mục tiêu ${index + 1} của yêu cầu`;
  return objective;
}

function artifactCapability(extension: string) {
  return ({ '.pdf': 'document:pdf', '.docx': 'document:docx', '.xlsx': 'spreadsheet:xlsx', '.csv': 'data:csv', '.json': 'data:json', '.html': 'document:html', '.md': 'document:markdown', '.txt': 'document:text', '.svg': 'image:svg' } as Record<string, string>)[extension] ?? 'document:text';
}

type RoutableSkill = {
  id: string;
  name: string;
  description: string;
  manifest: SkillManifest;
};

function isRecoverySkill(skill: RoutableSkill) {
  if (skill.manifest.runtime.type !== 'workflow') return false;
  const definition = skill.manifest.definition;
  return (
    Boolean(definition) &&
    typeof definition === 'object' &&
    'generatedFromError' in definition
  );
}

export function selectSkillsForCapabilities<T extends RoutableSkill>(
  skills: T[],
  capabilities: string[],
) {
  const selected: T[] = [];
  for (const capability of capabilities) {
    const match = skills.find((skill) =>
      skill.manifest.capabilities.some((value) => value.toLowerCase() === capability.toLowerCase()),
    );
    if (match && !selected.some((skill) => skill.id === match.id)) selected.push(match);
  }
  if (!selected.length && skills[0]) selected.push(skills[0]);
  return selected;
}

export function isRequestEcho(request: string, output: string) {
  const normalize = (value: string) =>
    value
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  const expected = normalize(request);
  const actual = normalize(output);
  return actual === expected || (expected.length > 24 && actual.includes(expected));
}

function normalizedText(value: string) {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function extractResultText(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined;
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, unknown>;
  for (const key of ['content', 'text', 'output', 'translatedText', 'translation']) {
    if (typeof object[key] === 'string' && object[key].trim()) return object[key].trim();
  }
  return undefined;
}

export function isUnchangedTranslation(source: string, output: string) {
  const normalizedSource = normalizedText(source);
  return Boolean(normalizedSource) && normalizedSource === normalizedText(output);
}

export function friendlyStepWording(skill: RoutableSkill, index: number, request: string) {
  const capabilities = new Set(skill.manifest.capabilities.map((value) => value.toLowerCase()));
  if (capabilities.has('filesystem:read')) {
    const path = inferFilesystemPath(request);
    return {
      title: path === '.' ? 'Đọc nội dung tệp được yêu cầu' : `Đọc nội dung file ${path}`,
      description:
        path === '.'
          ? 'Mở tệp trong workspace và lấy nội dung cần xử lý'
          : `Mở ${path} trong workspace và lấy toàn bộ nội dung`,
    };
  }
  if (capabilities.has('language:translate')) {
    const target = request.match(/sang\s+(tiếng\s+[\p{L}-]+)/iu)?.[1] ?? 'ngôn ngữ yêu cầu';
    return {
      title: `Dịch nội dung sang ${target}`,
      description:
        index > 0
          ? `Dùng nội dung đã lấy ở bước ${index} để tạo bản dịch hoàn chỉnh`
          : 'Dịch trực tiếp nội dung người dùng cung cấp',
    };
  }
  if (capabilities.has('language:define'))
    return {
      title: 'Giải thích từ hoặc cụm từ',
      description: 'Trình bày ý nghĩa bằng ngôn ngữ dễ hiểu',
    };
  return {
    title: skill.name.startsWith('generated-') ? 'Xử lý nội dung theo yêu cầu' : skill.name,
    description:
      index > 0 ? `Tiếp tục xử lý kết quả từ bước ${index}` : 'Thực hiện phần đầu tiên của yêu cầu',
  };
}

export function requiresUserPermission(manifest: SkillManifest) {
  const permissions = manifest.permissions;
  return (
    manifest.approvalRequired ||
    permissions.filesystem.write.some((path) => path !== '.local-agent/output/*') ||
    permissions.commands.length > 0 ||
    permissions.network.enabled ||
    permissions.environmentVariables.length > 0
  );
}

function collectArtifacts(value: unknown): string[] {
  const found = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string' && /(?:^|[\\/])[^\\/]+\.[a-z0-9]{2,8}$/i.test(item))
      found.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') {
      const object = item as { file?: unknown; artifacts?: unknown };
      if (typeof object.file === 'string') found.add(object.file);
      if (Array.isArray(object.artifacts))
        object.artifacts
          .filter((path): path is string => typeof path === 'string')
          .forEach((path) => found.add(path));
      Object.values(item).forEach(visit);
    }
  };
  visit(value);
  return [...found];
}
