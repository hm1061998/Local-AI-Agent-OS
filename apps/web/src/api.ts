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
  skills: () => json<any[]>('/skills'),
  skill: (id: string) => json<any>(`/skills/${id}`),
  versions: (id: string) => json<any[]>(`/skills/${id}/versions`),
  disable: (id: string) => json(`/skills/${id}/disable`, { method: 'POST' }),
  approvals: () => json<any[]>('/approvals'),
  approval: (id: string) => json<any>(`/approvals/${id}`),
  approve: (id: string, scope = 'version') =>
    json(`/approvals/${id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope }),
    }),
  reject: (id: string) => json(`/approvals/${id}/reject`, { method: 'POST' }),
  proposal: (missingCapabilities: string[], runtimeType: 'prompt' | 'workflow') =>
    json('/skills/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ missingCapabilities, runtimeType }),
    }),
  sandboxExecutions: () => json<any[]>('/sandbox/executions'),
  sandboxScan: (body: unknown) =>
    json<any>('/sandbox/scan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  sandboxGenerate: (description: string, runtime: 'typescript' | 'python') =>
    json<any>('/sandbox/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description, runtime }),
    }),
  sandboxApprove: (id: string) => json(`/sandbox/executions/${id}/approve`, { method: 'POST' }),
  sandboxReject: (id: string) => json(`/sandbox/executions/${id}/reject`, { method: 'POST' }),
  sandboxRun: (id: string, input: unknown) =>
    json(`/sandbox/executions/${id}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input }),
    }),
  sandboxKill: (id: string) => json(`/sandbox/executions/${id}/kill`, { method: 'POST' }),
  sandboxApply: (id: string) => json(`/sandbox/executions/${id}/apply`, { method: 'POST' }),
  sandboxRollback: (id: string) => json(`/sandbox/executions/${id}/rollback`, { method: 'POST' }),
  telemetry: () => json<any>('/telemetry'),
  saveWorkflow: (definition: unknown) =>
    json<any>('/workflows', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
    }),
  agentRuns: () => json<any[]>('/agents'),
  taskAgents: (id: string) => json<any>(`/tasks/${id}/agents`),
  agentSettings: () => json<any>('/agent-settings'),
  setAgentMode: (mode: 'automatic' | 'single' | 'multi') =>
    json<any>('/agent-settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    }),
  benchmark: () => json<any>('/benchmarks/multi-agent'),
};
export const socket = io('/agent', { path: '/socket.io' });
