import { describe, expect, it, vi } from 'vitest';
import { taskAnalysisSchema, DEFAULT_BUDGET } from '@local-agent/shared-types';
import { skillManifestSchema } from '@local-agent/skill-schema';
import { MockModelProvider } from '@local-agent/test-utils';
import type { StructuredGenerationRequest } from '@local-agent/model-provider';
import { ModelProviderError, OllamaModelProvider, parseStructuredJson } from '@local-agent/model-provider';
import { AgentDatabase } from '../src/database';
import { BudgetGuard, Orchestrator, assertTransition } from '../src/orchestrator';
import { allowedCommands, assertAllowedCommand, createPlan, manifests, routeSkills, safePath, validatePlan } from '../src/skills';

const analysis = taskAnalysisSchema.parse({ title: 'Read', intent: 'read file', category: 'filesystem', objectives: ['read'], requiredCapabilities: ['filesystem:read'], constraints: [], estimatedRisk: 'low' });

describe('schemas', () => {
  it('parses DeepSeek reasoning wrappers', () => expect(parseStructuredJson('<think>hidden</think>```json\n{"ok":true}\n```')).toEqual({ ok: true }));
  it('validates task analysis', () => expect(analysis.title).toBe('Read'));
  it('validates six manifests', () => expect(manifests.map((manifest) => skillManifestSchema.parse(manifest))).toHaveLength(6));
});

describe('routing and planning', () => {
  it('routes capability', () => expect(routeSkills(analysis).selectedSkillIds).toContain('filesystem-reader'));
  it('validates plan', () => expect(validatePlan(createPlan(analysis, routeSkills(analysis)), 8).steps.length).toBeGreaterThan(0));
  it('rejects excess', () => expect(() => validatePlan({ ...createPlan(analysis, routeSkills(analysis)), steps: Array(9).fill(createPlan(analysis, routeSkills(analysis)).steps[0]) }, 8)).toThrow('BUDGET_EXCEEDED'));
});

describe('security and FSM', () => {
  it('blocks traversal', () => expect(() => safePath('C:\\workspace', '..\\secret')).toThrow('WORKSPACE_ACCESS_DENIED'));
  it('allows exact commands only', () => { expect(allowedCommands.size).toBe(4); expect(assertAllowedCommand('yarn test')).toEqual(['yarn', 'test']); expect(() => assertAllowedCommand('yarn test && whoami')).toThrow(); });
  it('blocks invalid transition', () => expect(() => assertTransition('idle', 'completed')).toThrow());
  it('enforces budget', () => { const guard = new BudgetGuard({ ...DEFAULT_BUDGET, maxSteps: 1 }); guard.step(); expect(() => guard.step()).toThrow('BUDGET_EXCEEDED'); });
});

describe('integration', () => {
  it('completes with mock provider', async () => { const db = new AgentDatabase(':memory:'); manifests.forEach(manifest=>db.installSkill(manifest)); const task = db.createTask('make report'); const orchestrator = new Orchestrator(db, new MockModelProvider(), process.cwd()); await orchestrator.run(task.id, task.userInput); expect(db.getTask(task.id)).toMatchObject({ state: 'completed' }); expect(db.events(task.id).at(-1)?.type).toBe('TASK_COMPLETED'); });
  it('persists before emit', async () => { const db = new AgentDatabase(':memory:'); const task = db.createTask('report'); const orchestrator = new Orchestrator(db, new MockModelProvider(), process.cwd()); let persisted = true; orchestrator.on('event', (event) => { persisted &&= db.events(task.id).some((row) => row.id === event.id); }); await orchestrator.run(task.id, task.userInput); expect(persisted).toBe(true); });
  it('cancels an in-flight model call', async () => { const db = new AgentDatabase(':memory:'); const task = db.createTask('slow'); class SlowProvider extends MockModelProvider { override async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> { return new Promise<T>((_, reject) => request.signal?.addEventListener('abort', () => reject(new Error('TASK_CANCELLED')), { once: true })); } } const orchestrator = new Orchestrator(db, new SlowProvider()); const running = orchestrator.run(task.id, task.userInput); await new Promise((resolve) => setTimeout(resolve, 10)); orchestrator.cancel(task.id); await running; expect(db.getTask(task.id)).toMatchObject({ state: 'cancelled', errorCode: 'TASK_CANCELLED' }); });
  it('fails after one structured-output retry', async () => { const db = new AgentDatabase(':memory:'); const task = db.createTask('invalid'); let calls = 0; class InvalidProvider extends MockModelProvider { override async generateStructured<T>(): Promise<T> { calls += 1; throw new Error('invalid json'); } } const orchestrator = new Orchestrator(db, new InvalidProvider()); await orchestrator.run(task.id, task.userInput); expect(calls).toBe(2); expect(db.getTask(task.id)).toMatchObject({ state: 'failed', errorCode: 'STRUCTURED_OUTPUT_INVALID' }); });
  it('normalizes Ollama unavailable', async () => { const db = new AgentDatabase(':memory:'); const task = db.createTask('offline'); class OfflineProvider extends MockModelProvider { override async generateStructured<T>(): Promise<T> { throw new Error('OLLAMA_UNAVAILABLE'); } } await new Orchestrator(db, new OfflineProvider()).run(task.id, task.userInput); expect(db.getTask(task.id)).toMatchObject({ state: 'failed', errorCode: 'OLLAMA_UNAVAILABLE' }); });
  it('reports an unreachable Ollama endpoint', async () => { const provider = new OllamaModelProvider({ baseUrl: 'http://127.0.0.1:1', chatModel: 'deepseek-r1', embedModel: 'nomic-embed-text' }); await expect(provider.healthCheck()).resolves.toMatchObject({ available: false, chatModelAvailable: false }); });
  it('sends the configured CPU fallback to Ollama', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ response: JSON.stringify(analysis) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = new OllamaModelProvider({ baseUrl: 'http://ollama.test', chatModel: 'deepseek-r1', embedModel: 'nomic-embed-text', numGpu: 0 });
      await provider.generateStructured({ prompt: 'analyze', schema: taskAnalysisSchema });
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
      expect(JSON.parse(String(request.body))).toMatchObject({ options: { num_gpu: 0 } });
    } finally { vi.unstubAllGlobals(); }
  });
  it('reports Ollama generation failures separately from connectivity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{"error":"CUDA error"}', { status: 500 })));
    try {
      const provider = new OllamaModelProvider({ baseUrl: 'http://ollama.test', numGpu: 0 });
      await expect(provider.generateStructured({ prompt: 'analyze', schema: taskAnalysisSchema })).rejects.toMatchObject<ModelProviderError>({ code: 'OLLAMA_GENERATION_FAILED' });
    } finally { vi.unstubAllGlobals(); }
  });
});
