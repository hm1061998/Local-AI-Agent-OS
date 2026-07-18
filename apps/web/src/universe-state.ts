import type { AgentEvent, SkillStatus } from '@local-agent/agent-protocol';
export type GraphNodeKind = 'agent' | 'skill' | 'task' | 'sandbox';
export interface SkillGraphNode {
  id: string;
  label: string;
  kind: GraphNodeKind;
  runtimeType: string;
  status: SkillStatus | string;
  riskLevel: string;
  usageCount: number;
  successRate: number;
  active: boolean;
  generatedByAgent: boolean;
  position: [number, number, number];
  visualState?: 'candidate' | 'selected' | 'creating' | 'approval' | 'success' | 'failed';
}
export interface SkillGraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'dependency' | 'workflow' | 'usage' | 'generated_from' | 'active_execution';
  weight: number;
  active?: boolean;
}
export interface UniverseState {
  nodes: SkillGraphNode[];
  edges: SkillGraphEdge[];
  events: AgentEvent[];
  currentTaskId?: string;
  selectedNodeId?: string;
}
export const clampNodeSize = (usage: number) =>
  Math.max(0.55, Math.min(1.8, 0.55 + Math.log2(usage + 1) * 0.18));
export function radialPosition(index: number, total: number, radius = 6): [number, number, number] {
  if (total <= 1) return [0, radius, 0];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  const y = 1 - (index / (total - 1)) * 2;
  const ringRadius = Math.sqrt(Math.max(0, 1 - y * y));
  const angle = index * goldenAngle;
  return [Math.cos(angle) * ringRadius * radius, y * radius, Math.sin(angle) * ringRadius * radius];
}
export function graphFromSkills(skills: any[]): UniverseState {
  const agent: SkillGraphNode = {
    id: 'agent-core',
    label: 'Agent Core',
    kind: 'agent',
    runtimeType: 'model',
    status: 'active',
    riskLevel: 'low',
    usageCount: 0,
    successRate: 1,
    active: false,
    generatedByAgent: false,
    position: [0, 0, 0],
  };
  const nodes = [
    agent,
    ...skills.map((skill, index): SkillGraphNode => ({
      id: skill.id,
      label: skill.name,
      kind: 'skill',
      runtimeType: skill.manifest.runtime.type,
      status: skill.status,
      riskLevel: skill.manifest.riskLevel,
      usageCount: skill.usageCount ?? 0,
      successRate: skill.successRate ?? 0,
      active: false,
      generatedByAgent: skill.createdBy === 'agent',
      position: radialPosition(index, skills.length),
    })),
  ];
  const coreStride = Math.max(1, Math.ceil(skills.length / 4));
  const coreEdges = skills
    .filter((_, index) => index % coreStride === 0)
    .map((skill): SkillGraphEdge => ({
      id: `agent-${skill.id}`,
      source: 'agent-core',
      target: skill.id,
      type: skill.createdBy === 'agent' ? 'generated_from' : 'usage',
      weight: Math.max(1, skill.usageCount ?? 1),
    }));
  const constellationEdges = skills.flatMap((skill, index): SkillGraphEdge[] => {
    if (skills.length < 2) return [];
    const next = skills[(index + 1) % skills.length];
    const edges: SkillGraphEdge[] = [
      {
        id: `constellation-${skill.id}-${next.id}`,
        source: skill.id,
        target: next.id,
        type: 'workflow',
        weight: 1,
      },
    ];
    if (skills.length > 5 && index % 3 === 0) {
      const chord = skills[(index + 3) % skills.length];
      edges.push({
        id: `chord-${skill.id}-${chord.id}`,
        source: skill.id,
        target: chord.id,
        type: 'dependency',
        weight: 1,
      });
    }
    return edges;
  });
  const edges = [...coreEdges, ...constellationEdges];
  return { nodes, edges, events: [] };
}
function patchNode(nodes: SkillGraphNode[], id: string, patch: Partial<SkillGraphNode>) {
  return nodes.map((node) => (node.id === id ? { ...node, ...patch } : node));
}
export function reduceUniverse(state: UniverseState, event: AgentEvent): UniverseState {
  let nodes = state.nodes,
    edges = state.edges,
    currentTaskId = state.currentTaskId;
  if (event.type === 'TASK_RECEIVED') {
    currentTaskId = event.taskId;
    nodes = [
      ...nodes.filter((node) => node.id !== `task-${event.taskId}`),
      {
        id: `task-${event.taskId}`,
        label: 'Current task',
        kind: 'task',
        runtimeType: 'task',
        status: event.state,
        riskLevel: 'low',
        usageCount: 0,
        successRate: 0,
        active: true,
        generatedByAgent: false,
        position: [0, 3, 0],
      },
    ];
  }
  if (
    event.type === 'SKILL_CANDIDATE_FOUND' &&
    event.payload &&
    typeof event.payload === 'object' &&
    'skillId' in event.payload
  )
    nodes = patchNode(nodes, String((event.payload as any).skillId), { visualState: 'candidate' });
  if (event.type === 'SKILL_SELECTED' && event.payload && typeof event.payload === 'object') {
    const ids = (event.payload as any).selectedSkillIds ?? [];
    for (const id of ids) {
      nodes = patchNode(nodes, id, { active: true, visualState: 'selected' });
      edges = [
        ...edges.filter((edge) => edge.id !== `active-${event.taskId}-${id}`),
        {
          id: `active-${event.taskId}-${id}`,
          source: `task-${event.taskId}`,
          target: id,
          type: 'active_execution',
          weight: 2,
          active: true,
        },
      ];
    }
  }
  if (event.type === 'SKILL_CREATION_PROPOSAL_GENERATED')
    nodes = [
      ...nodes,
      {
        id: `creating-${event.taskId}`,
        label: 'Creating skill',
        kind: 'skill',
        runtimeType: 'declarative',
        status: 'draft',
        riskLevel: 'low',
        usageCount: 0,
        successRate: 0,
        active: true,
        generatedByAgent: true,
        visualState: 'creating',
        position: [3, 2, 0],
      },
    ];
  if (event.type === 'SKILL_APPROVAL_REQUIRED')
    nodes = nodes.map((node) => (node.active ? { ...node, visualState: 'approval' } : node));
  if (event.type === 'STEP_COMPLETED')
    nodes = nodes.map((node) => (node.active ? { ...node, visualState: 'success' } : node));
  if (event.type === 'STEP_FAILED' || event.type === 'TASK_FAILED')
    nodes = nodes.map((node) => (node.active ? { ...node, visualState: 'failed' } : node));
  if (event.type === 'TASK_COMPLETED')
    nodes = nodes.map((node) =>
      node.active
        ? { ...node, active: false, visualState: 'success' as const }
        : { ...node, active: false },
    );
  return {
    ...state,
    nodes,
    edges,
    events: [...state.events, event].slice(-1000),
    ...(currentTaskId ? { currentTaskId } : {}),
  };
}
export function resetUniverseExecution(state: UniverseState): UniverseState {
  const nodes = state.nodes
    .filter((node) => node.kind !== 'task' && node.kind !== 'sandbox')
    .map(({ visualState: _visualState, ...node }) => ({ ...node, active: false }));
  return {
    nodes,
    edges: state.edges.filter((edge) => edge.type !== 'active_execution'),
    events: [],
  };
}
export interface ReplayState {
  index: number;
  playing: boolean;
  speed: 0.5 | 1 | 2 | 4;
}
export const replayReducer = (
  state: ReplayState,
  action: { type: 'play' | 'pause' | 'next' | 'previous' | 'jump' | 'speed'; value?: number },
  length: number,
): ReplayState =>
  action.type === 'play'
    ? { ...state, playing: true }
    : action.type === 'pause'
      ? { ...state, playing: false }
      : action.type === 'next'
        ? { ...state, index: Math.min(length - 1, state.index + 1) }
        : action.type === 'previous'
          ? { ...state, index: Math.max(-1, state.index - 1) }
          : action.type === 'jump'
            ? { ...state, index: Math.max(-1, Math.min(length - 1, action.value ?? -1)) }
            : action.type === 'speed'
              ? {
                  ...state,
                  speed: ([0.5, 1, 2, 4].includes(action.value ?? 1)
                    ? action.value
                    : 1) as ReplayState['speed'],
                }
              : state;
export function supportsWebGL() {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
export const prefersReducedMotion = () =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export function validateWorkflowDraft(
  steps: Array<{ id: string; skillId: string; dependsOn: string[] }>,
) {
  const ids = new Set(steps.map((step) => step.id));
  if (ids.size !== steps.length) throw new Error('DUPLICATE_STEP');
  for (const step of steps)
    if (step.dependsOn.some((id) => !ids.has(id))) throw new Error('DEPENDENCY_MISSING');
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('CIRCULAR_DEPENDENCY');
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of steps.find((step) => step.id === id)?.dependsOn ?? [])
      visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  steps.forEach((step) => visit(step.id));
  return true;
}
