import { describe, expect, it, vi } from 'vitest';
import { taskAnalysisSchema, DEFAULT_BUDGET } from '@local-agent/shared-types';
import { skillManifestSchema } from '@local-agent/skill-schema';
import { MockModelProvider } from '@local-agent/test-utils';
import type { StructuredGenerationRequest } from '@local-agent/model-provider';
import {
  ModelProviderError,
  OllamaModelProvider,
  parseStructuredJson,
} from '@local-agent/model-provider';
import { AgentDatabase } from '../src/database';
import {
  BudgetGuard,
  Orchestrator,
  assertTransition,
  normalizeLanguageTask,
  isRecoverableSkillFailure,
  isRequestEcho,
  isUnchangedTranslation,
  extractResultText,
  friendlyStepWording,
  requiresUserPermission,
  selectSkillsForCapabilities,
  withExecutionTimeout,
} from '../src/orchestrator';
import {
  allowedCommands,
  assertAllowedCommand,
  createPlan,
  inferFilesystemPath,
  manifests,
  routeSkills,
  safePath,
  validatePlan,
} from '../src/skills';

const analysis = taskAnalysisSchema.parse({
  title: 'Read',
  intent: 'read file',
  category: 'filesystem',
  objectives: ['read'],
  requiredCapabilities: ['filesystem:read'],
  constraints: [],
  estimatedRisk: 'low',
});

describe('language task normalization', () => {
  it('routes word meanings away from code analysis', () => {
    const normalized = normalizeLanguageTask('ý nghĩa của "good" là gì', {
      ...analysis,
      category: 'code_analysis',
      requiredCapabilities: ['code:analyze'],
    });
    expect(normalized.category).toBe('general');
    expect(normalized.requiredCapabilities).toEqual(['language:define']);
  });
  it('preserves file reading as a dependency of translation', () => {
    const normalized = normalizeLanguageTask('đọc file README.md và dịch sang tiếng Việt', {
      ...analysis,
      objectives: ['read file', 'translate content'],
    });
    expect(normalized.requiredCapabilities).toEqual(['filesystem:read', 'language:translate']);
  });
});

describe('multi-objective planning', () => {
  const translation = skillManifestSchema.parse({
    ...manifests[0],
    id: 'language-translate',
    name: 'Language Translate',
    runtime: { type: 'prompt', timeoutSeconds: 30 },
    capabilities: ['language:translate'],
  });
  const records = [
    { id: manifests[0]!.id, name: manifests[0]!.name, description: '', manifest: manifests[0]! },
    { id: translation.id, name: translation.name, description: '', manifest: translation },
  ];
  it('selects one skill for every required capability in dependency order', () => {
    expect(
      selectSkillsForCapabilities(records, ['filesystem:read', 'language:translate']).map(
        (skill) => skill.id,
      ),
    ).toEqual(['filesystem-reader', 'language-translate']);
  });
  it('rejects output that merely repeats the user request', () => {
    const request = 'đọc file README.md và dịch nội dung sang tiếng Việt';
    expect(isRequestEcho(request, request)).toBe(true);
    expect(isRequestEcho(request, 'Đây là nội dung README đã được dịch.')).toBe(false);
  });
  it('rejects a translation that is identical to the source step', () => {
    const source = { content: 'Local-first AI agent with a React web interface' };
    expect(extractResultText(source)).toBe(source.content);
    expect(isUnchangedTranslation(extractResultText(source)!, source.content)).toBe(true);
    expect(
      isUnchangedTranslation(
        source.content,
        'Tác nhân AI ưu tiên chạy cục bộ với giao diện web React',
      ),
    ).toBe(false);
  });
  it('describes technical skills in user-friendly language', () => {
    const request = 'đọc file README.md và dịch nội dung sang tiếng Việt';
    expect(friendlyStepWording(records[0]!, 0, request)).toMatchObject({
      title: 'Đọc nội dung file README.md',
    });
    expect(friendlyStepWording(records[1]!, 1, request)).toEqual({
      title: 'Dịch nội dung sang tiếng Việt',
      description: 'Dùng nội dung đã lấy ở bước 1 để tạo bản dịch hoàn chỉnh',
    });
  });
});

describe('task permission gate', () => {
  it('requires approval for write, command, network and environment permissions', () => {
    const manifest = skillManifestSchema.parse({
      id: 'writer',
      name: 'Writer',
      version: '1.0.0',
      description: 'writes output',
      tags: [],
      triggers: [],
      runtime: { type: 'prompt', timeoutSeconds: 30 },
      inputSchema: {},
      outputSchema: {},
      permissions: {
        filesystem: { read: [], write: ['Uploads/**'], delete: [] },
        commands: [],
        network: { enabled: false, allowedHosts: [] },
        environmentVariables: [],
      },
      riskLevel: 'medium',
      approvalRequired: false,
      capabilities: ['file:write'],
    });
    expect(requiresUserPermission(manifest)).toBe(true);
  });
});

describe('adaptive skill recovery', () => {
  it('recovers ordinary skill compatibility failures', () => {
    expect(isRecoverableSkillFailure('EISDIR: illegal operation on a directory')).toBe(true);
    expect(isRecoverableSkillFailure('ENOENT: file not found')).toBe(true);
  });
  it('never bypasses security, cancellation or budget failures', () => {
    expect(isRecoverableSkillFailure('WORKSPACE_ACCESS_DENIED')).toBe(false);
    expect(isRecoverableSkillFailure('TASK_CANCELLED')).toBe(false);
    expect(isRecoverableSkillFailure('BUDGET_EXCEEDED')).toBe(false);
    expect(isRecoverableSkillFailure('EXECUTION_TIMEOUT')).toBe(false);
  });
  it('aborts a model operation that exceeds its deadline', async () => {
    await expect(
      withExecutionTimeout(
        (signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
          ),
        new AbortController().signal,
        5,
      ),
    ).rejects.toThrow('EXECUTION_TIMEOUT');
  });
});

describe('schemas', () => {
  it('parses DeepSeek reasoning wrappers', () =>
    expect(parseStructuredJson('<think>hidden</think>```json\n{"ok":true}\n```')).toEqual({
      ok: true,
    }));
  it('validates task analysis', () => expect(analysis.title).toBe('Read'));
  it('validates six manifests', () =>
    expect(manifests.map((manifest) => skillManifestSchema.parse(manifest))).toHaveLength(6));
});

describe('routing and planning', () => {
  it('routes capability', () =>
    expect(routeSkills(analysis).selectedSkillIds).toContain('filesystem-reader'));
  it('validates plan', () =>
    expect(
      validatePlan(createPlan(analysis, routeSkills(analysis)), 8).steps.length,
    ).toBeGreaterThan(0));
  it('passes the requested file to filesystem reader', () => {
    const request = 'đọc nội dung file README.md trong thư mục local-ai-agent-os';
    expect(inferFilesystemPath(request)).toBe('README.md');
    expect(createPlan(analysis, routeSkills(analysis), request).steps[0]?.input).toEqual({
      path: 'README.md',
    });
  });
  it('rejects excess', () =>
    expect(() =>
      validatePlan(
        {
          ...createPlan(analysis, routeSkills(analysis)),
          steps: Array(9).fill(createPlan(analysis, routeSkills(analysis)).steps[0]),
        },
        8,
      ),
    ).toThrow('BUDGET_EXCEEDED'));
});

describe('security and FSM', () => {
  it('blocks traversal', () =>
    expect(() => safePath('C:\\workspace', '..\\secret')).toThrow('WORKSPACE_ACCESS_DENIED'));
  it('allows exact commands only', () => {
    expect(allowedCommands.size).toBe(4);
    expect(assertAllowedCommand('yarn test')).toEqual(['yarn', 'test']);
    expect(() => assertAllowedCommand('yarn test && whoami')).toThrow();
  });
  it('blocks invalid transition', () =>
    expect(() => assertTransition('idle', 'completed')).toThrow());
  it('enforces budget', () => {
    const guard = new BudgetGuard({ ...DEFAULT_BUDGET, maxSteps: 1 });
    guard.step();
    expect(() => guard.step()).toThrow('BUDGET_EXCEEDED');
  });
});

describe('integration', () => {
  it('completes with mock provider', async () => {
    const db = new AgentDatabase(':memory:');
    manifests.forEach((manifest) => db.installSkill(manifest));
    const task = db.createTask('make report');
    const orchestrator = new Orchestrator(db, new MockModelProvider(), process.cwd());
    await orchestrator.run(task.id, task.userInput);
    expect(db.getTask(task.id)).toMatchObject({ state: 'completed' });
    expect(db.events(task.id).at(-1)?.type).toBe('TASK_COMPLETED');
  });
  it('persists before emit', async () => {
    const db = new AgentDatabase(':memory:');
    const task = db.createTask('report');
    const orchestrator = new Orchestrator(db, new MockModelProvider(), process.cwd());
    let persisted = true;
    orchestrator.on('event', (event) => {
      persisted &&= db.events(task.id).some((row) => row.id === event.id);
    });
    await orchestrator.run(task.id, task.userInput);
    expect(persisted).toBe(true);
  });
  it('cancels an in-flight model call', async () => {
    const db = new AgentDatabase(':memory:');
    const task = db.createTask('slow');
    class SlowProvider extends MockModelProvider {
      override async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
        return new Promise<T>((_, reject) =>
          request.signal?.addEventListener('abort', () => reject(new Error('TASK_CANCELLED')), {
            once: true,
          }),
        );
      }
    }
    const orchestrator = new Orchestrator(db, new SlowProvider());
    const running = orchestrator.run(task.id, task.userInput);
    await new Promise((resolve) => setTimeout(resolve, 10));
    orchestrator.cancel(task.id);
    await running;
    expect(db.getTask(task.id)).toMatchObject({ state: 'cancelled', errorCode: 'TASK_CANCELLED' });
  });
  it('fails after one structured-output retry', async () => {
    const db = new AgentDatabase(':memory:');
    const task = db.createTask('invalid');
    let calls = 0;
    class InvalidProvider extends MockModelProvider {
      override async generateStructured<T>(): Promise<T> {
        calls += 1;
        throw new Error('invalid json');
      }
    }
    const orchestrator = new Orchestrator(db, new InvalidProvider());
    await orchestrator.run(task.id, task.userInput);
    expect(calls).toBe(2);
    expect(db.getTask(task.id)).toMatchObject({
      state: 'failed',
      errorCode: 'STRUCTURED_OUTPUT_INVALID',
    });
  });
  it('normalizes Ollama unavailable', async () => {
    const db = new AgentDatabase(':memory:');
    const task = db.createTask('offline');
    class OfflineProvider extends MockModelProvider {
      override async generateStructured<T>(): Promise<T> {
        throw new Error('OLLAMA_UNAVAILABLE');
      }
    }
    await new Orchestrator(db, new OfflineProvider()).run(task.id, task.userInput);
    expect(db.getTask(task.id)).toMatchObject({ state: 'failed', errorCode: 'OLLAMA_UNAVAILABLE' });
  });
  it('reports an unreachable Ollama endpoint', async () => {
    const provider = new OllamaModelProvider({
      baseUrl: 'http://127.0.0.1:1',
      chatModel: 'deepseek-r1',
      embedModel: 'nomic-embed-text',
    });
    await expect(provider.healthCheck()).resolves.toMatchObject({
      available: false,
      chatModelAvailable: false,
    });
  });
  it('sends the configured CPU fallback to Ollama', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ response: JSON.stringify(analysis) }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new OllamaModelProvider({
        baseUrl: 'http://ollama.test',
        chatModel: 'deepseek-r1',
        embedModel: 'nomic-embed-text',
        numGpu: 0,
      });
      await provider.generateStructured({ prompt: 'analyze', schema: taskAnalysisSchema });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({ options: { num_gpu: 0 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('reports Ollama generation failures separately from connectivity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"CUDA error"}', { status: 500 })),
    );
    try {
      const provider = new OllamaModelProvider({ baseUrl: 'http://ollama.test', numGpu: 0 });
      await expect(
        provider.generateStructured({ prompt: 'analyze', schema: taskAnalysisSchema }),
      ).rejects.toMatchObject<ModelProviderError>({ code: 'OLLAMA_GENERATION_FAILED' });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
