import { io } from 'socket.io-client';
import type { AgentEvent, ModelHealth, TaskRecord } from '@local-agent/agent-protocol';
async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${url}`, init);
  if (!response.ok) throw new Error(await response.text());
  return response.json() as Promise<T>;
}
export const api = {
  health: () => json<ModelHealth>('/models/health'),
  tasks: () => json<TaskRecord[]>('/tasks'),
  task: (id: string) => json<TaskRecord>(`/tasks/${id}`),
  events: (id: string) => json<AgentEvent[]>(`/tasks/${id}/events`),
  create: (input: string) =>
    json<TaskRecord>('/tasks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }),
  cancel: (id: string) => json<{ accepted: boolean }>(`/tasks/${id}/cancel`, { method: 'POST' }),
};
export const socket = io('/agent', { path: '/socket.io' });
