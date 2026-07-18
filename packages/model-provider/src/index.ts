import { z } from 'zod';
import type { ModelHealth } from '@local-agent/agent-protocol';

export interface ModelChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}
export interface ModelStreamEvent { type: 'token' | 'done'; content: string }
export interface StructuredGenerationRequest<T> { prompt: string; schema: z.ZodType<T>; signal?: AbortSignal }
export interface ModelProvider {
  streamChat(request: ModelChatRequest): AsyncIterable<ModelStreamEvent>;
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<ModelHealth>;
}

export interface OllamaProviderConfig {
  baseUrl?: string;
  chatModel?: string;
  embedModel?: string;
  numGpu?: number;
}

type OllamaErrorCode = 'OLLAMA_UNAVAILABLE' | 'MODEL_NOT_FOUND' | 'OLLAMA_GENERATION_FAILED';

export class ModelProviderError extends Error {
  constructor(readonly code: OllamaErrorCode, readonly technicalMessage?: string) {
    super(code);
    this.name = 'ModelProviderError';
  }
}

function parseNumGpu(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export class OllamaModelProvider implements ModelProvider {
  private readonly config: Required<OllamaProviderConfig>;

  constructor(config: OllamaProviderConfig = {}) {
    this.config = {
      baseUrl: config.baseUrl ?? process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434',
      chatModel: config.chatModel ?? process.env.OLLAMA_CHAT_MODEL ?? 'deepseek-r1',
      embedModel: config.embedModel ?? process.env.OLLAMA_EMBED_MODEL ?? 'nomic-embed-text',
      numGpu: config.numGpu ?? parseNumGpu(process.env.OLLAMA_NUM_GPU),
    };
  }

  async healthCheck(): Promise<ModelHealth> {
    try {
      const response = await fetch(`${this.config.baseUrl}/api/tags`);
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json() as { models?: Array<{ name: string }> };
      const names = (data.models ?? []).map((model) => model.name.split(':')[0]);
      const chat = names.includes(this.config.chatModel.split(':')[0] ?? '');
      const embed = names.includes(this.config.embedModel.split(':')[0] ?? '');
      return {
        available: true,
        baseUrl: this.config.baseUrl,
        chatModel: this.config.chatModel,
        chatModelAvailable: chat,
        embedModel: this.config.embedModel,
        embedModelAvailable: embed,
        message: chat ? `Ollama và chat model đã sẵn sàng (GPU layers: ${this.config.numGpu}).` : `Model ${this.config.chatModel} chưa được pull.`,
      };
    } catch {
      return { available: false, baseUrl: this.config.baseUrl, chatModel: this.config.chatModel, chatModelAvailable: false, embedModel: this.config.embedModel, embedModelAvailable: false, message: 'Không thể kết nối Ollama.' };
    }
  }

  async *streamChat(request: ModelChatRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.post('/api/chat', { model: this.config.chatModel, messages: request.messages, stream: false, options: { num_gpu: this.config.numGpu } }, request.signal);
    const data = await response.json() as { message: { content: string } };
    yield { type: 'token', content: data.message.content };
    yield { type: 'done', content: '' };
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const response = await this.post('/api/generate', { model: this.config.chatModel, prompt: request.prompt, format: 'json', stream: false, options: { num_gpu: this.config.numGpu } }, request.signal);
    const data = await response.json() as { response: string };
    return request.schema.parse(JSON.parse(data.response));
  }

  async embed(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map(async (prompt) => {
      const response = await this.post('/api/embeddings', { model: this.config.embedModel, prompt, options: { num_gpu: this.config.numGpu } });
      return ((await response.json()) as { embedding: number[] }).embedding;
    }));
  }

  private async post(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ?? null });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelProviderError('OLLAMA_UNAVAILABLE', error instanceof Error ? error.message : String(error));
    }
    if (response.ok) return response;
    const technicalMessage = await response.text();
    if (response.status === 404 || technicalMessage.toLowerCase().includes('model') && technicalMessage.toLowerCase().includes('not found')) {
      throw new ModelProviderError('MODEL_NOT_FOUND', technicalMessage);
    }
    throw new ModelProviderError('OLLAMA_GENERATION_FAILED', technicalMessage);
  }
}
