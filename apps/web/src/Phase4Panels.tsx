import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import {
  graphFromSkills,
  reduceUniverse,
  replayReducer,
  type ReplayState,
  validateWorkflowDraft,
} from './universe-state';
export function ExecutionInspector() {
  const { taskId = '' } = useParams();
  const { data: task } = useQuery({ queryKey: ['task', taskId], queryFn: () => api.task(taskId) }),
    { data: events = [] } = useQuery({
      queryKey: ['events', taskId],
      queryFn: () => api.events(taskId),
    }),
    { data: executions = [] } = useQuery({
      queryKey: ['sandbox-executions'],
      queryFn: api.sandboxExecutions,
    });
  const [replay, setReplay] = useState<ReplayState>({ index: -1, playing: false, speed: 1 });
  useEffect(() => {
    if (!replay.playing) return;
    const timer = setInterval(
      () =>
        setReplay((current) => {
          const next = replayReducer(current, { type: 'next' }, events.length);
          return next.index === events.length - 1 ? { ...next, playing: false } : next;
        }),
      500 / replay.speed,
    );
    return () => clearInterval(timer);
  }, [replay.playing, replay.speed, events.length]);
  const visible = events.slice(0, replay.index + 1),
    graph = visible.reduce(reduceUniverse, graphFromSkills([]));
  const analysis = events.find((event: any) => event.type === 'TASK_ANALYSIS_COMPLETED')?.payload,
    plan = events.find((event: any) => event.type === 'PLAN_GENERATED')?.payload,
    related = executions.filter((item: any) => item.taskId === taskId);
  return (
    <main>
      <Link to="/universe">← Universe</Link>
      <h1>Execution Inspector</h1>
      <div className="card">
        <h2>{task?.title}</h2>
        <p>
          <span className="pill">{task?.state}</span> · {task?.resultSummary ?? task?.errorMessage}
        </p>
      </div>
      <section className="replay-controls">
        <button
          onClick={() =>
            setReplay((value) =>
              replayReducer(value, { type: value.playing ? 'pause' : 'play' }, events.length),
            )
          }
        >
          {replay.playing ? 'Pause' : 'Play'}
        </button>
        <button
          onClick={() =>
            setReplay((value) => replayReducer(value, { type: 'previous' }, events.length))
          }
        >
          Step backward
        </button>
        <button
          onClick={() =>
            setReplay((value) => replayReducer(value, { type: 'next' }, events.length))
          }
        >
          Step forward
        </button>
        <select
          aria-label="Replay speed"
          value={replay.speed}
          onChange={(event) =>
            setReplay((value) =>
              replayReducer(
                value,
                { type: 'speed', value: Number(event.target.value) },
                events.length,
              ),
            )
          }
        >
          {[0.5, 1, 2, 4].map((speed) => (
            <option key={speed} value={speed}>
              {speed}x
            </option>
          ))}
        </select>
        <input
          aria-label="Jump to event"
          type="range"
          min={-1}
          max={Math.max(-1, events.length - 1)}
          value={replay.index}
          onChange={(event) =>
            setReplay((value) =>
              replayReducer(
                value,
                { type: 'jump', value: Number(event.target.value) },
                events.length,
              ),
            )
          }
        />
      </section>
      <div className="inspect-grid">
        <section>
          <h2>Structured analysis</h2>
          <pre>{JSON.stringify(analysis ?? {}, null, 2)}</pre>
          <h2>Plan</h2>
          <pre>{JSON.stringify(plan ?? {}, null, 2)}</pre>
          <h2>Sandbox / resources</h2>
          <pre>
            {JSON.stringify(
              related.map(({ package: _package, ...item }: any) => item),
              null,
              2,
            )}
          </pre>
        </section>
        <section>
          <h2>Replay state</h2>
          <p>
            {graph.nodes.length} nodes · {graph.edges.length} edges
          </p>
          <ol>
            {visible.map((event: any) => (
              <li key={event.id}>
                <time>{event.sequence}</time>
                <span>
                  <b>{event.type}</b>
                  <br />
                  {event.message}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </main>
  );
}
type Step = {
  id: string;
  skillId: string;
  dependsOn: string[];
  inputMapping: Record<string, string>;
  outputAlias: string;
};
export function WorkflowEditor() {
  const { workflowId } = useParams();
  const { data: skills = [] } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  const [name, setName] = useState(workflowId ?? 'new-workflow'),
    [steps, setSteps] = useState<Step[]>([]),
    [message, setMessage] = useState('');
  const add = (skillId: string) =>
    setSteps((current) => [
      ...current,
      {
        id: `step-${current.length + 1}`,
        skillId,
        dependsOn: current.length ? [current.at(-1)!.id] : [],
        inputMapping: {},
        outputAlias: `output${current.length + 1}`,
      },
    ]);
  const definition = useMemo(
    () => ({
      id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name,
      description: `Workflow ${name}`,
      inputs: {},
      steps,
      outputMapping: steps.length ? { result: steps.at(-1)!.outputAlias } : {},
    }),
    [name, steps],
  );
  const validate = () => {
    try {
      validateWorkflowDraft(steps);
      setMessage(`Valid workflow · ${steps.length} steps · dry run passed`);
      return true;
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return false;
    }
  };
  const save = async () => {
    if (validate()) {
      await api.saveWorkflow(definition);
      setMessage('Workflow saved as active declarative skill');
    }
  };
  return (
    <main>
      <Link to="/universe">← Universe</Link>
      <h1>Visual Workflow Editor</h1>
      <label>
        Workflow name
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <div className="workflow-editor">
        <aside>
          <h2>Skill library</h2>
          {skills
            .filter((skill: any) => skill.status === 'active')
            .map((skill: any) => (
              <button
                draggable
                key={skill.id}
                onDragStart={(event) => event.dataTransfer.setData('skillId', skill.id)}
                onClick={() => add(skill.id)}
              >
                {skill.name}
              </button>
            ))}
        </aside>
        <section
          className="workflow-canvas"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => add(event.dataTransfer.getData('skillId'))}
        >
          <h2>Canvas</h2>
          {steps.map((step, index) => (
            <div className="workflow-step" key={step.id}>
              <b>
                {index + 1}. {step.skillId}
              </b>
              <label>
                Depends on
                <input
                  value={step.dependsOn.join(',')}
                  onChange={(event) =>
                    setSteps((current) =>
                      current.map((item) =>
                        item.id === step.id
                          ? {
                              ...item,
                              dependsOn: event.target.value
                                .split(',')
                                .map((value) => value.trim())
                                .filter(Boolean),
                            }
                          : item,
                      ),
                    )
                  }
                />
              </label>
              <button
                className="secondary"
                onClick={() => setSteps((current) => current.filter((item) => item.id !== step.id))}
              >
                Remove
              </button>
            </div>
          ))}
          {!steps.length && <p className="muted">Drag or click a skill to add it.</p>}
        </section>
      </div>
      <div className="actions">
        <button onClick={validate}>Dry run</button>
        <button onClick={() => void save()}>Save workflow</button>
      </div>
      <p>{message}</p>
      <pre>{JSON.stringify(definition, null, 2)}</pre>
    </main>
  );
}
