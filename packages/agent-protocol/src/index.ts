export * from '@local-agent/shared-types';
export * from '@local-agent/event-schema';
export * from '@local-agent/skill-schema';
export interface CreateTaskRequest {
  input: string;
}
export interface ModelHealth {
  available: boolean;
  baseUrl: string;
  chatModel: string;
  chatModelAvailable: boolean;
  embedModel: string;
  embedModelAvailable: boolean;
  message: string;
}
export interface ModelProvider {
  streamChat(request: any): AsyncIterable<any>;
  generateStructured<T>(request: any): Promise<T>;
  embed(texts: string[]): Promise<number[][]>;
  healthCheck(): Promise<ModelHealth>;
}
