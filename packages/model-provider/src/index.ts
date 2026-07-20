import { z } from 'zod';
import type { ModelHealth } from '@local-agent/agent-protocol';

export interface ModelChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  signal?: AbortSignal;
}
export interface ModelStreamEvent {
  type: 'token' | 'done';
  content: string;
}
export interface StructuredGenerationRequest<T> {
  prompt: string;
  schema: z.ZodType<T>;
  signal?: AbortSignal;
}
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

/** Configuration for OpenAI and other OpenAI-compatible paid endpoints. */
export interface OpenAICompatibleProviderConfig {
  baseUrl?: string;
  apiKey?: string;
  chatModel?: string;
  embedModel?: string;
  providerName?: string;
}

type OllamaErrorCode =
  | 'OLLAMA_UNAVAILABLE'
  | 'MODEL_NOT_FOUND'
  | 'OLLAMA_GENERATION_FAILED'
  | 'PAID_MODEL_UNAVAILABLE'
  | 'PAID_MODEL_FAILED';

export class ModelProviderError extends Error {
  constructor(
    readonly code: OllamaErrorCode,
    readonly technicalMessage?: string,
  ) {
    super(code);
    this.name = 'ModelProviderError';
  }
}

export function parseStructuredJson(value: string): unknown {
  const cleaned = value
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* Try the first balanced JSON object below. */
  }
  const start = cleaned.indexOf('{');
  if (start < 0) throw new SyntaxError('No JSON object found in model response');
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let index = start; index < cleaned.length; index++) {
    const char = cleaned[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return JSON.parse(cleaned.slice(start, index + 1));
  }
  throw new SyntaxError('Incomplete JSON object in model response');
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
      const data = (await response.json()) as { models?: Array<{ name: string }> };
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
        message: chat
          ? `Ollama và chat model đã sẵn sàng (GPU layers: ${this.config.numGpu}).`
          : `Model ${this.config.chatModel} chưa được pull.`,
      };
    } catch {
      return {
        available: false,
        baseUrl: this.config.baseUrl,
        chatModel: this.config.chatModel,
        chatModelAvailable: false,
        embedModel: this.config.embedModel,
        embedModelAvailable: false,
        message: 'Không thể kết nối Ollama.',
      };
    }
  }

  async *streamChat(request: ModelChatRequest): AsyncIterable<ModelStreamEvent> {
    const response = await this.post(
      '/api/chat',
      {
        model: this.config.chatModel,
        messages: request.messages,
        stream: false,
        options: { num_gpu: this.config.numGpu },
      },
      request.signal,
    );
    const data = (await response.json()) as { message: { content: string } };
    yield { type: 'token', content: data.message.content };
    yield { type: 'done', content: '' };
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const jsonSchema =
      'toJSONSchema' in request.schema
        ? (request.schema as unknown as { toJSONSchema(): unknown }).toJSONSchema()
        : undefined;
    const prompt = `${request.prompt}\nReturn exactly one JSON object. Do not include markdown or reasoning.${jsonSchema ? `\nRequired JSON Schema:\n${JSON.stringify(jsonSchema)}` : ''}`;
    const response = await this.post(
      '/api/generate',
      {
        model: this.config.chatModel,
        prompt,
        format: jsonSchema ?? 'json',
        stream: false,
        think: false,
        options: { num_gpu: this.config.numGpu, temperature: 0 },
      },
      request.signal,
    );
    const data = (await response.json()) as { response: string };
    return request.schema.parse(parseStructuredJson(data.response));
  }

  async embed(texts: string[]): Promise<number[][]> {
    return Promise.all(
      texts.map(async (prompt) => {
        const response = await this.post('/api/embeddings', {
          model: this.config.embedModel,
          prompt,
          options: { num_gpu: this.config.numGpu },
        });
        return ((await response.json()) as { embedding: number[] }).embedding;
      }),
    );
  }

  private async post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new ModelProviderError(
        'OLLAMA_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (response.ok) return response;
    const technicalMessage = await response.text();
    if (
      response.status === 404 ||
      (technicalMessage.toLowerCase().includes('model') &&
        technicalMessage.toLowerCase().includes('not found'))
    ) {
      throw new ModelProviderError('MODEL_NOT_FOUND', technicalMessage);
    }
    throw new ModelProviderError('OLLAMA_GENERATION_FAILED', technicalMessage);
  }
}

/**
 * Uses the standard /v1/chat/completions API, so it works with OpenAI and
 * compatible hosted providers without adding an SDK (or leaking a key to the UI).
 */
export class OpenAICompatibleModelProvider implements ModelProvider {
  private readonly config: Required<OpenAICompatibleProviderConfig>;
  constructor(config: OpenAICompatibleProviderConfig = {}) {
    this.config = {
      baseUrl: (
        config.baseUrl ??
        process.env.OPENAI_BASE_URL ??
        'https://api.openai.com/v1'
      ).replace(/\/$/, ''),
      apiKey: config.apiKey ?? process.env.OPENAI_API_KEY ?? '',
      chatModel: config.chatModel ?? process.env.OPENAI_CHAT_MODEL ?? 'gpt-4.1-mini',
      embedModel: config.embedModel ?? process.env.OPENAI_EMBED_MODEL ?? 'text-embedding-3-small',
      providerName: config.providerName ?? process.env.PAID_PROVIDER_NAME ?? 'OpenAI-compatible',
    };
  }
  async healthCheck(): Promise<ModelHealth> {
    const configured = Boolean(this.config.apiKey);
    return {
      available: configured,
      baseUrl: this.config.baseUrl,
      chatModel: this.config.chatModel,
      chatModelAvailable: configured,
      embedModel: this.config.embedModel,
      embedModelAvailable: configured,
      message: configured
        ? `${this.config.providerName} is configured.`
        : 'Set OPENAI_API_KEY to enable a paid model.',
    };
  }
  async *streamChat(request: ModelChatRequest): AsyncIterable<ModelStreamEvent> {
    const data = (await this.post(
      '/chat/completions',
      { model: this.config.chatModel, messages: request.messages },
      request.signal,
    )) as { choices?: Array<{ message?: { content?: string } }> };
    yield { type: 'token', content: data.choices?.[0]?.message?.content ?? '' };
    yield { type: 'done', content: '' };
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<T> {
    const jsonSchema =
      'toJSONSchema' in request.schema
        ? (request.schema as unknown as { toJSONSchema(): unknown }).toJSONSchema()
        : undefined;
    const data = (await this.post(
      '/chat/completions',
      {
        model: this.config.chatModel,
        messages: [
          {
            role: 'user',
            content: `${request.prompt}\nReturn exactly one JSON object.${jsonSchema ? `\nRequired JSON Schema:\n${JSON.stringify(jsonSchema)}` : ''}`,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      },
      request.signal,
    )) as { choices?: Array<{ message?: { content?: string } }> };
    return request.schema.parse(parseStructuredJson(data.choices?.[0]?.message?.content ?? ''));
  }
  async embed(texts: string[]): Promise<number[][]> {
    const data = (await this.post('/embeddings', {
      model: this.config.embedModel,
      input: texts,
    })) as { data?: Array<{ embedding: number[] }> };
    return (data.data ?? []).map((item) => item.embedding);
  }
  private async post(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.config.apiKey)
      throw new ModelProviderError('PAID_MODEL_UNAVAILABLE', 'OPENAI_API_KEY is not configured');
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    } catch (error) {
      throw new ModelProviderError(
        'PAID_MODEL_UNAVAILABLE',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!response.ok) throw new ModelProviderError('PAID_MODEL_FAILED', await response.text());
    return response.json();
  }
}

/** Local-first router: only falls back to paid inference when local inference is unavailable. */
export class FallbackModelProvider implements ModelProvider {
  constructor(
    private readonly primary: ModelProvider,
    private readonly fallback?: ModelProvider,
  ) {}
  async healthCheck() {
    const local = await this.primary.healthCheck();
    return local.available || !this.fallback ? local : this.fallback.healthCheck();
  }
  async *streamChat(request: ModelChatRequest) {
    try {
      yield* this.primary.streamChat(request);
    } catch (error) {
      if (!this.fallback || request.signal?.aborted) throw error;
      yield* this.fallback.streamChat(request);
    }
  }
  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    try {
      return await this.primary.generateStructured(request);
    } catch (error) {
      if (!this.fallback || request.signal?.aborted) throw error;
      return this.fallback.generateStructured(request);
    }
  }
  async embed(texts: string[]) {
    try {
      return await this.primary.embed(texts);
    } catch (error) {
      if (!this.fallback) throw error;
      return this.fallback.embed(texts);
    }
  }
}

export function createModelProvider(mode = process.env.AI_PROVIDER ?? 'auto'): ModelProvider {
  const local = new OllamaModelProvider();
  const paid = process.env.OPENAI_API_KEY ? new OpenAICompatibleModelProvider() : undefined;
  if (mode === 'paid') return paid ?? local;
  if (mode === 'local') return local;
  return new FallbackModelProvider(local, paid);
}
