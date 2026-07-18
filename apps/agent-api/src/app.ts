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
  Res,
} from '@nestjs/common';
import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';
import type { Response } from 'express';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { OllamaModelProvider } from '@local-agent/model-provider';
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
} from '@local-agent/agent-protocol';
import { AgentDatabase } from './database';
import { manifests } from './skills';
import { Orchestrator } from './orchestrator';
import {
  assertSafeArchivePaths,
  createProposal,
  DefaultSkillRankingStrategy,
  nextVersion,
} from './phase2';
@Injectable()
export class RuntimeService {
  readonly db = new AgentDatabase();
  readonly model = new OllamaModelProvider();
  readonly orchestrator = new Orchestrator(this.db, this.model);
  readonly sandbox = new DockerSandboxRunner();
  constructor() {
    manifests.forEach((m) => this.db.installSkill(m));
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
  @Post('tasks') create(@Body() b: { input?: string }) {
    if (!b.input?.trim()) throw new HttpException('input is required', 400);
    const t = this.r.db.createTask(b.input.trim());
    void this.r.orchestrator.run(t.id, t.userInput);
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
}
@Module({ providers: [RuntimeService, AgentGateway], controllers: [ApiController] })
export class TaskModule {}
@Module({ imports: [TaskModule] })
export class AppModule {}
