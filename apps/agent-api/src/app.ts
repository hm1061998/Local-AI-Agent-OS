import {
  Body,
  Controller,
  Get,
  HttpException,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import type { Response } from 'express';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { cpus, freemem, totalmem, loadavg } from 'node:os';
import { z } from 'zod';
import { createModelProvider } from '@local-agent/model-provider';
import {
  DockerSandboxRunner,
  materializePackage,
  packageHash,
  previewStagedChanges,
  applyStagedChanges,
  rollbackStagedChanges,
  validateJsonOutput,
  validatePackage,
  compilerFindings,
  type PackageSpec,
} from '@local-agent/sandbox-runner';
import {
  skillManifestSchema,
  type SkillCreationProposal,
  type SkillManifest,
  defaultMultiAgentBudget,
} from '@local-agent/agent-protocol';
import { AgentDatabase } from './database';
import { manifests } from './skills';
import { Orchestrator } from './orchestrator';
import {
  assertSafeArchivePaths,
  createProposal,
  DefaultSkillRankingStrategy,
  nextVersion,
  validateWorkflow,
  aggregatePermissions,
} from './phase2';
import {
  BudgetGuard,
  MessageBus,
  decideAgentMode,
  inferTaskSignals,
  runLocalBenchmark,
  type AgentMode,
} from './multi-agent';
import { ToolInstaller, managedTools } from './tool-installer';
@Injectable()
export class RuntimeService {
  readonly db = new AgentDatabase();
  readonly model = createModelProvider();
  readonly orchestrator = new Orchestrator(this.db, this.model);
  readonly sandbox = new DockerSandboxRunner();
  readonly tools = new ToolInstaller();
  constructor() {
    manifests.forEach((m) => this.db.installSkill(m));
  }
  startTask(taskId: string, input: string, requestedMode?: AgentMode) {
    const configured = this.db.setting<AgentMode>('agentMode', 'automatic');
    const signals = inferTaskSignals(input);
    const mode = decideAgentMode(requestedMode ?? configured, signals);
    if (mode === 'single') {
      void this.orchestrator.run(taskId, input);
      return mode;
    }
    const guard = new BudgetGuard();
    const bus = new MessageBus(this.db, guard, taskId);
    this.db.createAgentRun(taskId, mode, 'TASK_RECEIVED', guard.limits, signals);
    const assign = (role: string, summary: string) =>
      this.db.addAssignment(taskId, role, 'completed', summary);
    try {
      this.db.updateAgentRun(taskId, 'SUPERVISOR_ANALYSIS', 'supervisor', guard.usage);
      guard.consume('delegations');
      assign('supervisor', 'Selected multi-agent mode using deterministic task signals.');
      const request = bus.send('supervisor', 'planner', 'PLAN_REQUESTED', {
        summary: input,
        signals,
      });
      assign(
        'planner',
        `Prepared a bounded plan with ${signals.estimatedSteps} estimated step(s).`,
      );
      const plan = bus.send(
        'planner',
        'supervisor',
        'PLAN_READY',
        {
          objectives: [input],
          requiredSkills: [],
          missingCapabilities: signals.missingExecutableSkill ? ['executable-skill'] : [],
          risks: [signals.risk],
          approvalPoints: signals.missingExecutableSkill ? ['install executable skill'] : [],
        },
        request.id,
      );
      if (signals.missingExecutableSkill) {
        guard.consume('delegations');
        bus.send('supervisor', 'skill_builder', 'SKILL_BUILD_ASSIGNED', {
          capability: 'executable-skill',
          policy: 'auto-install-safe-only',
        });
        assign(
          'skill_builder',
          'Delegated safe skill creation to the runtime; forbidden findings still stop execution.',
        );
        bus.send('skill_builder', 'supervisor', 'SKILL_BUILD_READY', { autoInstall: true });
      }
      guard.consume('delegations');
      bus.send('supervisor', 'executor', 'EXECUTION_ASSIGNED', { approvedPlan: true }, plan.id);
      assign('executor', 'Delegated execution to the stable single-agent runtime.');
      this.db.updateAgentRun(taskId, 'EXECUTION_RUNNING', 'executor', guard.usage);
      void this.orchestrator
        .run(taskId, input)
        .then(() => {
          const task = this.db.getTask(taskId);
          bus.send('executor', 'supervisor', 'EXECUTION_FINISHED', { state: task?.state });
          guard.consume('delegations');
          bus.send('supervisor', 'result_judge', 'RESULT_REVIEW_REQUESTED', { state: task?.state });
          assign('result_judge', 'Applied rule-based terminal-state validation.');
          bus.send('result_judge', 'supervisor', 'RESULT_VALIDATED', {
            passed: task?.state === 'completed',
            score: task?.state === 'completed' ? 1 : 0,
            checks: [
              {
                name: 'terminal state',
                passed: task?.state === 'completed',
                evidence: task?.state ?? 'missing',
              },
            ],
            retryRecommended: false,
          });
          this.db.updateAgentRun(
            taskId,
            task?.state === 'completed' ? 'TASK_COMPLETED' : 'TASK_FAILED',
            null,
            guard.usage,
            true,
          );
        })
        .catch((error) =>
          this.db.updateAgentRun(
            taskId,
            error?.message === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'TASK_FAILED',
            null,
            guard.usage,
            true,
          ),
        );
    } catch (error) {
      this.db.updateAgentRun(
        taskId,
        error instanceof Error && error.message === 'BUDGET_EXCEEDED'
          ? 'BUDGET_EXCEEDED'
          : 'AGENT_FAILED',
        null,
        guard.usage,
        true,
      );
      if (!signals.missingExecutableSkill) void this.orchestrator.run(taskId, input);
    }
    return mode;
  }
}
@WebSocketGateway({ namespace: '/agent', cors: { origin: '*' } })
export class AgentGateway {
  @WebSocketServer() server!: Server;
  constructor(@Inject(RuntimeService) r: RuntimeService) {
    r.orchestrator.on('event', (e) => {
      this.server?.emit('task.event', e);
      this.server?.emit(
        e.type === 'TASK_COMPLETED'
          ? 'task.completed'
          : e.type === 'TASK_FAILED'
            ? 'task.failed'
            : 'task.updated',
        e,
      );
    });
  }
}
@Controller()
export class ApiController {
  constructor(@Inject(RuntimeService) private r: RuntimeService) {}
  @Get('health') health() {
    return { status: 'ok', service: 'local-agent-api' };
  }
  @Get('models/health') modelHealth() {
    return this.r.model.healthCheck();
  }
  @Get('tools') tools() {
    return Promise.all(
      managedTools.map(async (tool) => ({
        ...tool,
        install: undefined,
        status: await this.r.tools.status(tool),
      })),
    );
  }
  @Post('tools/ensure') ensureTools(@Body() body: { capabilities?: string[] }) {
    return this.r.tools.ensureCapabilities(body.capabilities ?? []);
  }
  @Get('skills') skills() {
    return this.r.db.listSkills();
  }
  @Get('skills/:id') skill(@Param('id') id: string) {
    const s = this.r.db.listSkills().find((x) => x.id === id);
    if (!s) throw new NotFoundException();
    return s;
  }
  @Get('skills/:id/versions') skillVersions(@Param('id') id: string) {
    return this.r.db.versions(id);
  }
  @Post('skills/rank') async rank(
    @Body() body: { query: string; input?: Record<string, unknown>; preferredSkillIds?: string[] },
  ) {
    const skills = this.r.db.listSkills().filter((s) => s.status === 'active');
    let warning: string | undefined;
    try {
      const vectors = await this.r.model.embed([
        body.query,
        ...skills.map(
          (s) =>
            `${s.name} ${s.description} ${s.manifest.tags.join(' ')} ${s.manifest.triggers.join(' ')} ${s.manifest.capabilities.join(' ')}`,
        ),
      ]);
      skills.forEach((s, i) => {
        const vector = vectors[i + 1];
        if (vector) s.embedding = vector;
      });
      return {
        candidates: new DefaultSkillRankingStrategy().rank(skills, {
          queryEmbedding: vectors[0],
          terms: body.query.toLowerCase().split(/\W+/),
          input: body.input ?? {},
          preferredSkillIds: body.preferredSkillIds,
        }),
        semantic: true,
      };
    } catch {
      warning = 'Embedding unavailable; keyword ranking fallback used.';
      return {
        candidates: new DefaultSkillRankingStrategy().rank(skills, {
          terms: body.query.toLowerCase().split(/\W+/),
          input: body.input ?? {},
          preferredSkillIds: body.preferredSkillIds,
        }),
        semantic: false,
        warning,
      };
    }
  }
  @Post('skills/proposals') proposal(
    @Body() body: { missingCapabilities?: string[]; runtimeType?: 'prompt' | 'workflow' },
  ) {
    return this.r.db.createApproval(
      createProposal(body.missingCapabilities ?? ['general'], body.runtimeType),
    );
  }
  @Post('skills/:id/disable') disable(@Param('id') id: string) {
    this.r.db.setStatus(id, 'disabled');
    return { ok: true };
  }
  @Post('skills/:id/rollback/:version') rollback(
    @Param('id') id: string,
    @Param('version') version: string,
  ) {
    const v = this.r.db.versions(id).find((x) => x.version === version);
    if (!v) throw new NotFoundException();
    const manifest = {
      ...v.manifest,
      version: nextVersion(this.r.db.listSkills().find((s) => s.id === id)?.version ?? version),
    };
    this.r.db.installSkill(manifest, 'active', 'user');
    return manifest;
  }
  @Get('skills/:id/compare/:from/:to') compare(
    @Param('id') id: string,
    @Param('from') from: string,
    @Param('to') to: string,
  ) {
    const versions = this.r.db.versions(id),
      a = versions.find((v) => v.version === from),
      b = versions.find((v) => v.version === to);
    if (!a || !b) throw new NotFoundException();
    return { from: a, to: b, changed: JSON.stringify(a.manifest) !== JSON.stringify(b.manifest) };
  }
  @Get('skills/:id/export') exportSkill(@Param('id') id: string, @Res() res: Response) {
    const skill = this.r.db.listSkills().find((s) => s.id === id);
    if (!skill) throw new NotFoundException();
    const zip = zipSync({
      'skill.json': strToU8(JSON.stringify(skill.manifest, null, 2)),
      'README.md': strToU8(`# ${skill.name}\n`),
    });
    res.type('application/zip').attachment(`${id}-${skill.version}.zip`).send(Buffer.from(zip));
  }
  @Post('skills/import/preview') importPreview(@Body() body: { archiveBase64: string }) {
    const files = unzipSync(Buffer.from(body.archiveBase64, 'base64'));
    assertSafeArchivePaths(Object.keys(files));
    const raw = files['skill.json'];
    if (!raw) throw new HttpException('skill.json missing', 400);
    const manifest = skillManifestSchema.parse(JSON.parse(Buffer.from(raw).toString('utf8')));
    if (['typescript', 'python'].includes(manifest.runtime.type))
      throw new HttpException('Executable skills forbidden in Phase 2', 400);
    return {
      manifest,
      files: Object.keys(files),
      installable: !this.r.db.versions(manifest.id).some((v) => v.version === manifest.version),
    };
  }
  @Post('skills/import/install') importInstall(@Body() body: { manifest: SkillManifest }) {
    const manifest = skillManifestSchema.parse(body.manifest);
    if (['typescript', 'python'].includes(manifest.runtime.type))
      throw new HttpException('Executable skills forbidden', 400);
    this.r.db.installSkill(manifest, 'waiting_for_approval', 'user');
    return this.r.db.createApproval({
      name: manifest.name,
      description: manifest.description,
      runtimeType: manifest.runtime.type as 'prompt' | 'workflow',
      reason: 'Imported declarative skill',
      missingCapabilities: manifest.capabilities,
      permissions: manifest.permissions,
      riskLevel: manifest.riskLevel === 'forbidden' ? 'high' : manifest.riskLevel,
      testCases: [
        { name: 'schema validation', input: {}, expectedAssertions: ['output matches schema'] },
      ],
    });
  }
  @Get('approvals') approvals() {
    return this.r.db.approvals();
  }
  @Get('approvals/:id') approval(@Param('id') id: string) {
    const a = this.r.db.approvals().find((x) => x.id === id);
    if (!a) throw new NotFoundException();
    return a;
  }
  @Post('approvals/:id/approve') approve(
    @Param('id') id: string,
    @Body() body: { scope?: string },
  ) {
    const a = this.r.db.decideApproval(id, 'approved', body.scope ?? 'version');
    if (!a) throw new NotFoundException();
    const p = a.proposal as SkillCreationProposal;
    const manifest: SkillManifest = {
      id: p.name,
      name: p.name,
      version: '1.0.0',
      description: p.description,
      tags: p.missingCapabilities,
      triggers: p.missingCapabilities,
      runtime: { type: p.runtimeType, timeoutSeconds: 30 },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissions: p.permissions,
      riskLevel: p.riskLevel,
      approvalRequired: false,
      capabilities: p.missingCapabilities,
    };
    this.r.db.installSkill(manifest, 'active', 'agent');
    if (a.taskId) void this.r.orchestrator.resume(a.taskId);
    return { approval: a, skill: manifest, resumedTaskId: a.taskId };
  }
  @Post('approvals/:id/reject') reject(@Param('id') id: string) {
    const a = this.r.db.decideApproval(id, 'rejected');
    if (!a) throw new NotFoundException();
    if (a.taskId)
      this.r.db.updateTask(a.taskId, 'failed', {
        errorCode: 'SKILL_NOT_FOUND',
        errorMessage: 'Skill proposal rejected',
      });
    return a;
  }
  @Post('sandbox/scan') scanExecutable(
    @Body() body: { skillId?: string; taskId?: string; package?: PackageSpec },
  ) {
    if (!body.skillId || !body.package)
      throw new HttpException('skillId and package are required', 400);
    const findings = [...validatePackage(body.package), ...compilerFindings(body.package)],
      blocked = findings.some((item) => item.severity === 'forbidden');
    const execution = this.r.db.createSandboxExecution({
      skillId: body.skillId,
      runtime: body.package.runtime,
      findings,
      package: body.package,
      ...(body.taskId ? { taskId: body.taskId } : {}),
    });
    if (blocked) this.r.db.setSandboxStatus(execution.id, 'rejected');
    return { ...execution, findings, approvable: !blocked };
  }
  @Post('sandbox/generate') async generateExecutable(
    @Body() body: { description?: string; runtime?: 'typescript' | 'python' },
  ) {
    if (!body.description?.trim()) throw new HttpException('description is required', 400);
    const runtime = body.runtime ?? 'typescript';
    const generated = await this.r.model.generateStructured({
      prompt: `Generate a minimal ${runtime} executable skill for: ${body.description}. It must export a single run(input) function, return a JSON object, use no filesystem, process, environment, network, subprocess, eval, dependency, markdown, or explanation. Return skillId and source.`,
      schema: z.object({ skillId: z.string().regex(/^[a-z0-9-]+$/), source: z.string().min(1) }),
    });
    const file = runtime === 'typescript' ? 'dist/index.js' : 'src/skill.py',
      checksum = createHash('sha256').update(generated.source).digest('hex');
    const packageSpec: PackageSpec = {
      runtime,
      files: { [file]: generated.source },
      dependencies: {},
      lockfile: '# locked by Local Agent OS',
      checksums: { [file]: checksum },
      outputSchema: { type: 'object' },
    };
    this.r.db.audit('GENERATING_SOURCE', 'skill', generated.skillId, {
      runtime,
      model: process.env.OLLAMA_CHAT_MODEL ?? 'deepseek-r1',
      sourceHash: packageHash(packageSpec),
    });
    return this.scanExecutable({ skillId: generated.skillId, package: packageSpec });
  }
  @Get('sandbox/executions') sandboxExecutions() {
    return this.r.db.sandboxExecutions();
  }
  @Post('sandbox/executions/:id/approve') approveSandbox(@Param('id') id: string) {
    const execution = this.r.db.sandboxExecutions().find((item) => item.id === id);
    if (!execution) throw new NotFoundException();
    if (execution.findings.some((item: { severity: string }) => item.severity === 'forbidden'))
      throw new HttpException('Forbidden findings cannot be approved', 400);
    this.r.db.setSandboxStatus(id, 'approved');
    return { accepted: true, id };
  }
  @Post('sandbox/executions/:id/reject') rejectSandbox(@Param('id') id: string) {
    this.r.db.setSandboxStatus(id, 'rejected');
    return { accepted: true, id };
  }
  @Post('sandbox/executions/:id/run') async runSandbox(
    @Param('id') id: string,
    @Body() body: { input?: unknown },
  ) {
    const execution = this.r.db.sandboxExecutions().find((item) => item.id === id);
    if (!execution) throw new NotFoundException();
    if (execution.status !== 'approved' || !execution.package)
      throw new HttpException('Execution must be approved first', 400);
    const request = await materializePackage(
      resolve('data', 'sandbox'),
      id,
      execution.package as PackageSpec,
      body.input ?? {},
    );
    this.r.db.setSandboxStatus(id, 'running');
    try {
      const result = await this.r.sandbox.execute(request);
      let output: unknown;
      try {
        output = JSON.parse(await readFile(resolve(request.outputDir, 'output.json'), 'utf8'));
      } catch {
        output = undefined;
      }
      const status =
        result.code === 0 &&
        output !== undefined &&
        validateJsonOutput((execution.package as PackageSpec).outputSchema, output)
          ? 'completed'
          : 'failed';
      this.r.db.setSandboxStatus(id, status, {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(output === undefined ? {} : { output }),
        resources: {
          exitCode: result.code,
          sourceHash: packageHash(execution.package as PackageSpec),
        },
      });
      if (
        status === 'completed' &&
        output &&
        typeof output === 'object' &&
        !Array.isArray(output) &&
        'files' in output &&
        typeof (output as { files?: unknown }).files === 'object' &&
        (output as { files?: unknown }).files !== null
      ) {
        const staged = await previewStagedChanges(
          process.env.AGENT_WORKSPACE ?? process.cwd(),
          (output as { files: Record<string, string> }).files,
        );
        this.r.db.setSandboxStatus(id, 'waiting_for_changes_approval', { staged });
        return { status: 'waiting_for_changes_approval', output, staged, ...result };
      }
      return { status, output, ...result };
    } catch (error) {
      this.r.db.setSandboxStatus(id, 'failed', {
        stderr: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  @Post('sandbox/executions/:id/apply') async applySandboxChanges(@Param('id') id: string) {
    const execution = this.r.db.sandboxExecutions().find((item) => item.id === id);
    if (!execution || execution.status !== 'waiting_for_changes_approval' || !execution.staged)
      throw new HttpException('No staged changes awaiting approval', 400);
    const applied = await applyStagedChanges(
      process.env.AGENT_WORKSPACE ?? process.cwd(),
      execution.staged,
    );
    this.r.db.setSandboxStatus(id, 'changes_applied', { applied });
    return { applied };
  }
  @Post('sandbox/executions/:id/rollback') async rollbackSandboxChanges(@Param('id') id: string) {
    const execution = this.r.db.sandboxExecutions().find((item) => item.id === id);
    if (!execution?.applied) throw new HttpException('No applied changes to rollback', 400);
    await rollbackStagedChanges(process.env.AGENT_WORKSPACE ?? process.cwd(), execution.applied);
    this.r.db.setSandboxStatus(id, 'changes_rolled_back');
    return { rolledBack: true };
  }
  @Post('sandbox/executions/:id/kill') async killSandbox(@Param('id') id: string) {
    await this.r.sandbox.kill(id);
    this.r.db.setSandboxStatus(id, 'killed');
    return { accepted: true, id };
  }
  @Get('audit-logs') auditLogs() {
    return this.r.db.auditLogs();
  }
  @Get('artifacts') artifact(@Query('path') path: string, @Res() res: Response) {
    if (!path) throw new HttpException('path is required', 400);
    const workspace = resolve(process.env.AGENT_WORKSPACE ?? process.cwd());
    const target = resolve(workspace, path);
    const allowedRoots = [resolve(workspace, '.local-agent/output'), resolve(workspace, 'Uploads')];
    if (!allowedRoots.some((root) => target === root || target.startsWith(`${root}\\`)))
      throw new HttpException('Artifact path is outside allowed output directories', 403);
    return res.download(target);
  }
  @Get('telemetry') async telemetry() {
    const active = this.r.db.sandboxExecutions().filter((item) => item.status === 'running').length;
    return {
      cpu: { cores: cpus().length, load: loadavg()[0] ?? 0 },
      ram: { used: totalmem() - freemem(), total: totalmem() },
      gpu: { available: false, message: 'Not available' },
      activeExecutions: active,
      queueLength: this.r.db
        .listTasks()
        .filter((task) => !['completed', 'failed', 'cancelled'].includes(task.state)).length,
      ollama: await this.r.model.healthCheck(),
    };
  }
  @Post('workflows') saveWorkflow(@Body() body: { definition?: any }) {
    if (!body.definition) throw new HttpException('definition is required', 400);
    const active = new Set(
      this.r.db
        .listSkills()
        .filter((skill) => skill.status === 'active')
        .map((skill) => skill.id),
    );
    validateWorkflow(body.definition, active);
    const manifest: SkillManifest = {
      id: body.definition.id,
      name: body.definition.name,
      version: '1.0.0',
      description: body.definition.description,
      tags: ['workflow'],
      triggers: ['workflow'],
      runtime: { type: 'workflow', timeoutSeconds: 60 },
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      permissions: aggregatePermissions(
        body.definition.steps
          .map(
            (step: any) =>
              this.r.db.listSkills().find((skill) => skill.id === step.skillId)?.manifest,
          )
          .filter(Boolean),
      ),
      riskLevel: 'low',
      approvalRequired: false,
      capabilities: ['workflow:execute'],
      definition: body.definition,
    };
    this.r.db.installSkill(manifest, 'active', 'user');
    return manifest;
  }
  @Post('tasks') create(@Body() b: { input?: string; mode?: AgentMode }) {
    if (!b.input?.trim()) throw new HttpException('input is required', 400);
    const t = this.r.db.createTask(b.input.trim());
    this.r.startTask(t.id, t.userInput, b.mode);
    return t;
  }
  @Get('tasks') tasks() {
    return this.r.db.listTasks();
  }
  @Get('tasks/:id') task(@Param('id') id: string) {
    const t = this.r.db.getTask(id);
    if (!t) throw new NotFoundException();
    return t;
  }
  @Post('tasks/:id/cancel') cancel(@Param('id') id: string) {
    this.r.orchestrator.cancel(id);
    return { accepted: true };
  }
  @Get('tasks/:id/events') events(@Param('id') id: string) {
    return this.r.db.events(id);
  }
  @Get('tasks/:id/permissions') taskPermissions(@Param('id') id: string) {
    return this.r.db.permissionRequest(id) ?? { status: 'none' };
  }
  @Post('permission-requests/:id/approve') approvePermission(
    @Param('id') id: string,
    @Body() body: { scope?: 'once' | 'all' },
  ) {
    const scope = body.scope === 'all' ? 'all' : 'once';
    const request = this.r.db.decidePermission(id, 'approved', scope);
    if (!request) throw new NotFoundException();
    void this.r.orchestrator.resumeAfterPermission(request.taskId, scope);
    return request;
  }
  @Post('permission-requests/:id/reject') rejectPermission(@Param('id') id: string) {
    const request = this.r.db.decidePermission(id, 'rejected', 'once');
    if (!request) throw new NotFoundException();
    this.r.orchestrator.rejectPermission(request.taskId);
    return request;
  }
  @Get('agents') agentRuns() {
    return this.r.db.agentFlow();
  }
  @Get('tasks/:id/agents') taskAgents(@Param('id') id: string) {
    return this.r.db.agentFlow(id)[0] ?? null;
  }
  @Get('agent-settings') agentSettings() {
    return {
      mode: this.r.db.setting<AgentMode>('agentMode', 'automatic'),
      budget: defaultMultiAgentBudget,
    };
  }
  @Post('agent-settings') setAgentSettings(@Body() body: { mode?: AgentMode }) {
    if (!body.mode || !['automatic', 'single', 'multi'].includes(body.mode))
      throw new HttpException('invalid agent mode', 400);
    this.r.db.setSetting('agentMode', body.mode);
    return { mode: body.mode, budget: defaultMultiAgentBudget };
  }
  @Get('benchmarks/multi-agent') benchmark() {
    return runLocalBenchmark();
  }
}
@Module({ providers: [RuntimeService, AgentGateway], controllers: [ApiController] })
export class TaskModule {}
@Module({ imports: [TaskModule] })
export class AppModule {}
