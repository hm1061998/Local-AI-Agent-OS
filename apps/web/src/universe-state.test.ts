import { describe, expect, it } from 'vitest';
import {
  clampNodeSize,
  graphFromSkills,
  radialPosition,
  reduceUniverse,
  replayReducer,
  resetUniverseExecution,
  validateWorkflowDraft,
} from './universe-state';
import { mergePersistedEvents } from './Universe';
const event = (type: any, payload?: unknown) =>
  ({
    id: crypto.randomUUID(),
    taskId: 't',
    type,
    state: 'searching_skills',
    message: type,
    timestamp: new Date().toISOString(),
    sequence: 1,
    payload,
  }) as any;
describe('universe state', () => {
  it('hydrates persisted events without duplicating websocket events', () => {
    const initial = graphFromSkills([]);
    const event = {
      id: 'event-1',
      taskId: 'task-1',
      type: 'TASK_RECEIVED' as const,
      state: 'idle' as const,
      message: 'received',
      timestamp: new Date().toISOString(),
      sequence: 1,
    };
    const once = mergePersistedEvents(initial, [event]);
    const twice = mergePersistedEvents(once, [event]);
    expect(twice.events).toHaveLength(1);
  });
  it('sorts late persisted events back into sequence order', () => {
    const base = graphFromSkills([]);
    const makeEvent = (id: string, sequence: number) => ({
      id,
      taskId: 'task-1',
      type: 'TASK_ANALYSIS_STARTED' as const,
      state: 'analyzing_task' as const,
      message: id,
      timestamp: new Date().toISOString(),
      sequence,
    });
    const late = mergePersistedEvents(base, [makeEvent('event-15', 15)]);
    const hydrated = mergePersistedEvents(late, [makeEvent('event-3', 3)]);
    expect(hydrated.events.map((item) => item.sequence)).toEqual([3, 15]);
  });
  it('resets task execution state while preserving the skill constellation', () => {
    let state = graphFromSkills([
      {
        id: 'skill-a',
        name: 'Skill A',
        status: 'active',
        manifest: { runtime: { type: 'prompt' }, riskLevel: 'low' },
      },
    ]);
    state = reduceUniverse(state, event('TASK_RECEIVED'));
    state.nodes = state.nodes.map((node) => ({ ...node, active: true, visualState: 'success' }));
    const reset = resetUniverseExecution(state);
    expect(reset.events).toHaveLength(0);
    expect(reset.nodes.some((node) => node.kind === 'task')).toBe(false);
    expect(reset.nodes.find((node) => node.id === 'skill-a')?.active).toBe(false);
    expect(reset.nodes.find((node) => node.id === 'skill-a')?.visualState).toBeUndefined();
  });
  it('clamps node size', () => {
    expect(clampNodeSize(0)).toBe(0.55);
    expect(clampNodeSize(1e9)).toBe(1.8);
  });
  it('uses stable radial layout', () =>
    expect(radialPosition(1, 10)).toEqual(radialPosition(1, 10)));
  it('places skill nodes on a spherical shell', () =>
    expect(Math.hypot(...radialPosition(4, 12, 6))).toBeCloseTo(6, 5));
  it('maps skill edges', () =>
    expect(
      graphFromSkills([
        {
          id: 'a',
          name: 'A',
          status: 'active',
          usageCount: 2,
          successRate: 1,
          createdBy: 'system',
          manifest: { runtime: { type: 'prompt' }, riskLevel: 'low' },
        },
      ]).edges[0]?.target,
    ).toBe('a'));
  it('maps events without raw reasoning', () => {
    let state = graphFromSkills([]);
    state = reduceUniverse(state, event('TASK_RECEIVED'));
    expect(state.nodes.some((node) => node.kind === 'task')).toBe(true);
    expect(JSON.stringify(state)).not.toContain('reasoning');
  });
  it('replays forward and backward', () => {
    expect(replayReducer({ index: 0, playing: false, speed: 1 }, { type: 'next' }, 3).index).toBe(
      1,
    );
    expect(
      replayReducer({ index: 1, playing: false, speed: 1 }, { type: 'previous' }, 3).index,
    ).toBe(0);
  });
  it('rejects workflow cycles', () =>
    expect(() =>
      validateWorkflowDraft([
        { id: 'a', skillId: 'x', dependsOn: ['b'] },
        { id: 'b', skillId: 'y', dependsOn: ['a'] },
      ]),
    ).toThrow('CIRCULAR_DEPENDENCY'));
  it('reduces 1000 events with bounded history', () => {
    let state = graphFromSkills(
      Array.from({ length: 100 }, (_, i) => ({
        id: `s${i}`,
        name: `S${i}`,
        status: 'active',
        usageCount: i,
        successRate: 1,
        createdBy: 'system',
        manifest: { runtime: { type: 'prompt' }, riskLevel: 'low' },
      })),
    );
    for (let i = 0; i < 1000; i++) state = reduceUniverse(state, event('STEP_COMPLETED'));
    expect(state.events).toHaveLength(1000);
    expect(state.nodes).toHaveLength(101);
  });
});
