import type {
  ModelProvider,
  StructuredGenerationRequest,
  ModelChatRequest,
  ModelStreamEvent,
} from '@local-agent/model-provider';
import type { ModelHealth, TaskAnalysis } from '@local-agent/agent-protocol';
export class MockModelProvider implements ModelProvider {
  private structuredCalls = 0;
  constructor(
    private readonly analysis: TaskAnalysis = {
      title: 'Mock task',
      intent: 'test',
      category: 'general',
      objectives: ['Complete task'],
      requiredCapabilities: ['reporting'],
      constraints: [],
      estimatedRisk: 'low',
    },
  ) {}
  async healthCheck(): Promise<ModelHealth> {
    return {
      available: true,
      baseUrl: 'mock',
      chatModel: 'mock',
      chatModelAvailable: true,
      embedModel: 'mock',
      embedModelAvailable: true,
      message: 'ready',
    };
  }
  async *streamChat(_request: ModelChatRequest): AsyncIterable<ModelStreamEvent> {
    yield { type: 'token', content: 'mock' };
    yield { type: 'done', content: '' };
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    this.structuredCalls += 1;
    if (this.structuredCalls === 1) return request.schema.parse(this.analysis);
    try {
      return request.schema.parse(this.analysis);
    } catch {
      return request.schema.parse({ output: 'mock output', summary: 'Mock execution completed.' });
    }
  }
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map(() => [1]);
  }
}
