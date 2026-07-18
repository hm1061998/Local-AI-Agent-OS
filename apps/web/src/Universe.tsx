import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line, OrbitControls, Sparkles } from '@react-three/drei';
import type { AgentEvent } from '@local-agent/agent-protocol';
import { Link } from 'react-router-dom';
import { api, socket } from './api';
import {
  clampNodeSize,
  graphFromSkills,
  prefersReducedMotion,
  reduceUniverse,
  supportsWebGL,
  type SkillGraphNode,
  type UniverseState,
} from './universe-state';
function Node3D({
  node,
  selected,
  onSelect,
  reduced,
}: {
  node: SkillGraphNode;
  selected: boolean;
  onSelect(): void;
  reduced: boolean;
}) {
  const ref = useRef<any>(null);
  useFrame(({ clock }) => {
    if (ref.current && node.active && !reduced)
      ref.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 4) * 0.08);
  });
  const color =
    node.visualState === 'failed'
      ? '#ff705f'
      : node.visualState === 'approval'
        ? '#ffd166'
        : node.kind === 'agent'
          ? '#ffb36b'
          : node.status === 'disabled'
            ? '#51676b'
            : node.runtimeType === 'workflow'
              ? '#d56cff'
              : node.runtimeType === 'prompt'
                ? '#63ffe0'
                : '#79b8ff';
  const radius = node.kind === 'agent' ? 0.46 : 0.08 + clampNodeSize(node.usageCount) * 0.035;
  return (
    <group position={node.position}>
      <pointLight
        color={color}
        intensity={node.kind === 'agent' ? 8 : selected ? 4 : 1.2}
        distance={node.kind === 'agent' ? 8 : 3}
      />
      <mesh ref={ref} onClick={onSelect}>
        <sphereGeometry args={[radius, 20, 20]} />
        <meshStandardMaterial
          color={color}
          emissive={color}
          emissiveIntensity={node.kind === 'agent' ? 4 : selected ? 5 : 2.4}
          transparent
          opacity={node.status === 'disabled' ? 0.35 : 1}
        />
      </mesh>
      <mesh scale={node.kind === 'agent' ? 3.6 : selected ? 4.2 : 3.2}>
        <sphereGeometry args={[radius, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={selected ? 0.16 : 0.08}
          depthWrite={false}
        />
      </mesh>
      <Html
        position={[0, radius + (node.kind === 'agent' ? 0.42 : 0.24), 0]}
        center
        distanceFactor={10}
      >
        <button className={`node-label ${selected ? 'selected' : ''}`} onClick={onSelect}>
          {node.label.length > 28 ? `${node.label.slice(0, 26)}…` : node.label}
        </button>
      </Html>
    </group>
  );
}
function Scene({
  graph,
  selected,
  onSelect,
  reduced,
  quality,
}: {
  graph: UniverseState;
  selected?: string | undefined;
  onSelect(id: string): void;
  reduced: boolean;
  quality: string;
}) {
  const map = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.position])),
    [graph.nodes],
  );
  return (
    <>
      <color attach="background" args={['#030713']} />
      <fog attach="fog" args={['#030713', 11, 28]} />
      <ambientLight intensity={0.12} />
      <Sparkles
        count={quality === 'low' ? 180 : quality === 'high' ? 700 : 420}
        scale={[22, 13, 18]}
        size={quality === 'high' ? 2.2 : 1.5}
        speed={reduced ? 0 : 0.12}
        opacity={0.75}
        color="#8fffea"
        noise={1.5}
      />
      <Sparkles
        count={quality === 'high' ? 160 : 80}
        scale={[18, 10, 15]}
        size={3}
        speed={reduced ? 0 : 0.08}
        opacity={0.5}
        color="#c76dff"
        noise={2}
      />
      {[
        { position: [-5, 2, -2] as [number, number, number], color: '#c8eaff', size: 2.8 },
        { position: [4, -2, -3] as [number, number, number], color: '#d9b8ff', size: 2.4 },
        { position: [1, 3, -5] as [number, number, number], color: '#ffe0c2', size: 3.2 },
        { position: [-2, -3, -4] as [number, number, number], color: '#91fff0', size: 2.1 },
      ].map((nebula, index) => (
        <group key={index} position={nebula.position}>
          <pointLight color={nebula.color} intensity={1.4} distance={8} />
          <mesh scale={nebula.size}>
            <sphereGeometry args={[1, 20, 20]} />
            <meshBasicMaterial
              color={nebula.color}
              transparent
              opacity={0.012}
              depthWrite={false}
            />
          </mesh>
          <mesh scale={nebula.size * 0.52}>
            <sphereGeometry args={[1, 20, 20]} />
            <meshBasicMaterial
              color={nebula.color}
              transparent
              opacity={0.025}
              depthWrite={false}
            />
          </mesh>
        </group>
      ))}
      {graph.edges.map((edge) => {
        const a = map.get(edge.source),
          b = map.get(edge.target);
        return a && b ? (
          <Line
            key={edge.id}
            points={[a, b]}
            color={edge.active ? '#70ffe0' : edge.type === 'generated_from' ? '#b66cff' : '#2c817b'}
            lineWidth={edge.active ? 1.6 : 0.65}
            dashed={edge.type === 'generated_from'}
          />
        ) : null;
      })}
      {graph.nodes.map((node) => (
        <Node3D
          key={node.id}
          node={node}
          selected={selected === node.id}
          onSelect={() => onSelect(node.id)}
          reduced={reduced}
        />
      ))}
      <OrbitControls
        enableDamping={!reduced}
        autoRotate={!reduced}
        autoRotateSpeed={0.12}
        minDistance={6}
        maxDistance={22}
      />
    </>
  );
}
function Graph2D({
  graph,
  selected,
  onSelect,
}: {
  graph: UniverseState;
  selected?: string | undefined;
  onSelect(id: string): void;
}) {
  return (
    <div
      className="graph-2d"
      role="img"
      aria-label={`Skill graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges`}
    >
      {graph.nodes.map((node) => (
        <button
          key={node.id}
          className={`graph-node ${node.active ? 'active' : ''} ${selected === node.id ? 'selected' : ''}`}
          onClick={() => onSelect(node.id)}
        >
          <b>
            {node.kind === 'agent' ? '◆' : '●'} {node.label}
          </b>
          <small>
            {node.runtimeType} · {node.status}
          </small>
        </button>
      ))}
    </div>
  );
}
function traceTone(event: AgentEvent) {
  if (event.type.includes('FAILED') || event.type.includes('REJECTED')) return 'trace-error';
  if (
    event.type.includes('COMPLETED') ||
    event.type.includes('VALIDATED') ||
    event.type === 'SKILL_AUTO_INSTALLED'
  )
    return 'trace-success';
  if (event.type.includes('STARTED') || event.type.includes('SEARCH')) return 'trace-running';
  return 'trace-info';
}
function tracePrefix(event: AgentEvent) {
  if (event.type.includes('FAILED') || event.type.includes('REJECTED')) return '[!]';
  if (event.type.includes('COMPLETED') || event.type.includes('VALIDATED')) return '[✓]';
  if (event.type === 'SKILL_AUTO_INSTALLED') return '[+]';
  if (event.type.includes('STARTED') || event.type.includes('SEARCH')) return '[~]';
  return '[>]';
}
function eventDetails(event: AgentEvent) {
  const payload = event.payload as any;
  if (!payload || typeof payload !== 'object') return null;
  if (event.type === 'SKILL_SELECTED')
    return (
      <small className="trace-detail">
        Registry: {payload.registryCount ?? '?'} skill · Match:{' '}
        {payload.selectedSkill?.name ?? payload.selectedSkillIds?.[0]}
      </small>
    );
  if (event.type === 'STEP_STARTED')
    return <small className="trace-detail">Params: {JSON.stringify(payload.input ?? {})}</small>;
  if (event.type === 'STEP_RETRYING')
    return (
      <small className="trace-detail">
        Reason: {payload.reason} · Change: {payload.changed}
      </small>
    );
  if (event.type === 'STEP_COMPLETED' && payload.result !== undefined)
    return <small className="trace-detail">Result: {JSON.stringify(payload.result)}</small>;
  return null;
}
function collectArtifactPaths(value: unknown) {
  const paths = new Set<string>();
  const visit = (item: unknown) => {
    if (typeof item === 'string' && /(?:^|[\\/])[^\\/]+\.[a-z0-9]{2,8}$/i.test(item))
      paths.add(item);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (item && typeof item === 'object') Object.values(item).forEach(visit);
  };
  visit(value);
  return [...paths];
}
function outputFromEvent(event: AgentEvent | undefined) {
  if (!event) return undefined;
  const payload = event.payload as any;
  if (event.type === 'STEP_COMPLETED') return payload?.result?.output ?? payload?.result;
  const result = payload?.results?.at?.(-1);
  return result?.output ?? result ?? payload;
}
function FriendlyOutput({ value }: { value: unknown }) {
  const [copied, setCopied] = useState(false);
  const object =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const preferredKey = object
    ? ['translation', 'translatedText', 'text', 'content', 'message', 'summary'].find(
        (key) => typeof object[key] === 'string' && String(object[key]).trim(),
      )
    : undefined;
  const primary = preferredKey ? object?.[preferredKey] : value;
  const metadata = object
    ? Object.entries(object).filter(([key]) => key !== preferredKey && key !== 'artifacts')
    : [];
  const copyValue = typeof primary === 'string' ? primary : JSON.stringify(value, null, 2);
  return (
    <div className="friendly-output" data-testid="universe-output">
      <div className="result-heading">
        <span>
          <i>✓</i> Kết quả
        </span>
        <button
          className="secondary copy-result"
          onClick={() =>
            void navigator.clipboard.writeText(copyValue).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? 'Đã sao chép' : 'Sao chép'}
        </button>
      </div>
      {typeof primary === 'string' ? (
        <div className="result-text">{primary}</div>
      ) : Array.isArray(primary) ? (
        <ul className="result-list">
          {primary.map((item, index) => (
            <li key={index}>{typeof item === 'string' ? item : JSON.stringify(item)}</li>
          ))}
        </ul>
      ) : (
        <div className="result-text">{String(primary ?? '')}</div>
      )}
      {metadata.length > 0 && (
        <dl className="result-metadata">
          {metadata.map(([key, item]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>{typeof item === 'string' ? item : JSON.stringify(item)}</dd>
            </div>
          ))}
        </dl>
      )}
      {typeof value === 'object' && (
        <details className="raw-result">
          <summary>Xem dữ liệu JSON</summary>
          <pre>{JSON.stringify(value, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}
function AgentComposer({
  running,
  canCancel,
  onRun,
  onCancel,
}: {
  running: boolean;
  canCancel: boolean;
  onRun(request: string): Promise<void>;
  onCancel(): void;
}) {
  const [draft, setDraft] = useState('');
  const submit = async () => {
    const request = draft.trim();
    if (!request || running) return;
    setDraft('');
    await onRun(request);
  };
  return (
    <section className="universe-composer">
      <textarea
        aria-label="Universe prompt"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="Nhập yêu cầu cho agents…"
      />
      <div className="actions">
        <button disabled={running || !draft.trim()} onClick={() => void submit()}>
          {running ? 'Agents đang chạy…' : 'Gửi yêu cầu'}
        </button>
        {canCancel && running && (
          <button className="secondary" onClick={onCancel}>
            Dừng
          </button>
        )}
      </div>
    </section>
  );
}
export function mergePersistedEvents(current: UniverseState, events: AgentEvent[]) {
  const known = new Set(current.events.map((event) => event.id));
  return events.filter((event) => !known.has(event.id)).reduce(reduceUniverse, current);
}
export function Universe() {
  const [skills, setSkills] = useState<any[]>([]),
    [graph, setGraph] = useState<UniverseState>(() => graphFromSkills([])),
    [selected, setSelected] = useState<string>(),
    [search, setSearch] = useState(''),
    [quality, setQuality] = useState('medium'),
    [force2D, setForce2D] = useState(false),
    [telemetry, setTelemetry] = useState<any>(),
    [activeTaskId, setActiveTaskId] = useState<string>(),
    [output, setOutput] = useState<unknown>(),
    [running, setRunning] = useState(false),
    [paused, setPaused] = useState(false),
    [error, setError] = useState('');
  const reduced = prefersReducedMotion(),
    webgl = typeof document !== 'undefined' && supportsWebGL();
  useEffect(() => {
    void api.skills().then((value) => {
      setSkills(value);
      setGraph(graphFromSkills(value));
    });
    void api.telemetry().then(setTelemetry);
    const queue: AgentEvent[] = [];
    let frame = 0;
    const flush = () => {
      setGraph((current) => queue.splice(0).reduce(reduceUniverse, current));
      frame = 0;
    };
    const listener = (event: AgentEvent) => {
      if (paused) return;
      queue.push(event);
      if (!frame) frame = requestAnimationFrame(flush);
      if (event.taskId === activeTaskId) {
        if (
          event.payload &&
          ['STEP_COMPLETED', 'RESULT_VALIDATION_COMPLETED', 'TASK_COMPLETED'].includes(event.type)
        )
          setOutput(outputFromEvent(event));
        if (['TASK_COMPLETED', 'TASK_FAILED', 'EXECUTION_CANCELLED'].includes(event.type))
          setRunning(false);
      }
      if (event.type === 'SKILL_AUTO_INSTALLED')
        void api.skills().then((value) => {
          setSkills(value);
          setGraph((current) => ({
            ...graphFromSkills(value),
            events: current.events,
            ...(current.currentTaskId ? { currentTaskId: current.currentTaskId } : {}),
          }));
        });
    };
    socket.on('task.event', listener);
    return () => {
      socket.off('task.event', listener);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [paused, activeTaskId]);
  useEffect(() => {
    if (!activeTaskId) return;
    let disposed = false;
    const hydrate = async () => {
      try {
        const events = await api.events(activeTaskId);
        if (disposed) return;
        setGraph((current) => mergePersistedEvents(current, events));
        const latestOutput = events
          .filter(
            (event) =>
              event.payload &&
              ['STEP_COMPLETED', 'RESULT_VALIDATION_COMPLETED', 'TASK_COMPLETED'].includes(
                event.type,
              ),
          )
          .at(-1);
        if (latestOutput) setOutput(outputFromEvent(latestOutput));
        if (
          events.some((event) =>
            ['TASK_COMPLETED', 'TASK_FAILED', 'EXECUTION_CANCELLED'].includes(event.type),
          )
        )
          setRunning(false);
      } catch (reason) {
        if (!disposed) setError(reason instanceof Error ? reason.message : String(reason));
      }
    };
    void hydrate();
    const timer = running ? window.setInterval(() => void hydrate(), 1000) : undefined;
    return () => {
      disposed = true;
      if (timer) window.clearInterval(timer);
    };
  }, [activeTaskId, running]);
  const node = graph.nodes.find((item) => item.id === selected),
    visible = graph.nodes.filter((item) => item.label.toLowerCase().includes(search.toLowerCase())),
    taskEvents = graph.events.filter((event) => !activeTaskId || event.taskId === activeTaskId),
    plan = taskEvents.filter((event) => event.type === 'PLAN_GENERATED').at(-1)?.payload as any,
    completedSteps = new Set(
      taskEvents
        .filter((event) => event.type === 'STEP_COMPLETED')
        .map((event) => (event.payload as any)?.step?.id),
    ),
    artifactPaths = collectArtifactPaths(output);
  const run = useCallback(async (request: string) => {
    try {
      setError('');
      setOutput(undefined);
      setRunning(true);
      const task = await api.create(request);
      setActiveTaskId(task.id);
      setGraph((current) => ({ ...current, currentTaskId: task.id }));
      const persisted = await api.events(task.id);
      setGraph((current) => mergePersistedEvents(current, persisted));
    } catch (reason) {
      setRunning(false);
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  }, []);
  return (
    <main className="universe-page">
      <section className="universe-top">
        <b>Model: {telemetry?.ollama ? 'local Ollama' : 'checking'}</b>
        <span>Task: {graph.currentTaskId ?? 'idle'}</span>
        <span>
          CPU {telemetry?.cpu?.load?.toFixed?.(1) ?? 'N/A'} · RAM{' '}
          {telemetry ? Math.round((telemetry.ram.used / telemetry.ram.total) * 100) : 'N/A'}% · GPU{' '}
          {telemetry?.gpu?.available ? 'available' : 'Not available'}
        </span>
        <input
          aria-label="Search skill"
          placeholder="Search skill"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <select
          aria-label="Quality"
          value={quality}
          onChange={(event) => setQuality(event.target.value)}
        >
          <option>low</option>
          <option>medium</option>
          <option>high</option>
        </select>
        <button className="secondary" onClick={() => setForce2D((value) => !value)}>
          {force2D ? 'Use 3D' : 'Use 2D'}
        </button>
      </section>
      <section className="universe-main">
        <div className="scene" aria-label="3D Skill Universe">
          {webgl && !force2D ? (
            <Canvas
              camera={{ position: [0, 7, 12], fov: 55 }}
              dpr={quality === 'low' ? 1 : quality === 'high' ? [1, 2] : [1, 1.5]}
            >
              <Scene
                graph={{
                  ...graph,
                  nodes: graph.nodes.filter((item) => visible.some((v) => v.id === item.id)),
                }}
                selected={selected}
                onSelect={setSelected}
                reduced={reduced}
                quality={quality}
              />
            </Canvas>
          ) : (
            <Graph2D
              graph={{ ...graph, nodes: visible }}
              selected={selected}
              onSelect={setSelected}
            />
          )}
          <p className="sr-only">
            There are {graph.nodes.length} nodes. Use the accessible skill list to inspect each
            skill.
          </p>
        </div>
        <aside className="inspector">
          {plan?.steps?.length > 0 && (
            <details
              className="execution-plan"
              open={!taskEvents.some((event) => event.type === 'TASK_COMPLETED')}
            >
              <summary>
                <span>KẾ HOẠCH · TỰ ĐỘNG THỰC THI</span>
                <b>{plan.steps.length} bước</b>
              </summary>
              <p>{plan.goal}</p>
              <ol>
                {plan.steps.map((step: any) => (
                  <li key={step.id} className={completedSteps.has(step.id) ? 'done' : ''}>
                    <span>{completedSteps.has(step.id) ? '✓' : step.order}</span>
                    <span>
                      <b>{step.title}</b>
                      <small>{step.description}</small>
                    </span>
                  </li>
                ))}
              </ol>
            </details>
          )}
          <div className="trace-panel">
            <div className="console-title">
              <span>AGENT TRACE</span>
              <span className={running ? 'live-dot active' : 'live-dot'}>
                {running ? 'LIVE' : 'IDLE'}
              </span>
            </div>
            <ol className="console-log">
              {graph.events.slice(-50).map((event) => (
                <li key={event.id} className={traceTone(event)}>
                  <time>{String(event.sequence).padStart(2, '0')}</time>
                  <span>
                    <b>{tracePrefix(event)}</b> {event.message}
                    {eventDetails(event)}
                  </span>
                </li>
              ))}
            </ol>
          </div>
          {output !== undefined && (
            <section className="universe-output">
              <FriendlyOutput value={output} />
              {artifactPaths.length > 0 && (
                <div className="artifact-list">
                  {artifactPaths.map((path) => (
                    <a key={path} href={api.artifactUrl(path)} download>
                      <span>FILE</span>
                      <b>{path.split(/[\\/]/).pop()}</b>
                      <small>{path}</small>
                    </a>
                  ))}
                </div>
              )}
            </section>
          )}
          {error && <pre className="error">{error}</pre>}
          <AgentComposer
            running={running}
            canCancel={Boolean(activeTaskId)}
            onRun={run}
            onCancel={() => {
              if (activeTaskId) void api.cancel(activeTaskId);
            }}
          />
        </aside>
        {node && (
          <aside className="skill-drawer">
            <button aria-label="Close details" onClick={() => setSelected(undefined)}>
              ×
            </button>
            <h2>{node.label}</h2>
            <p>
              {node.runtimeType} · {node.status} · risk {node.riskLevel}
            </p>
            <p>
              Success {Math.round(node.successRate * 100)}% · Uses {node.usageCount}
            </p>
            {node.kind === 'skill' && (
              <>
                <button
                  onClick={() =>
                    void api.disable(node.id).then(() =>
                      setGraph((current) => ({
                        ...current,
                        nodes: current.nodes.map((item) =>
                          item.id === node.id ? { ...item, status: 'disabled' } : item,
                        ),
                      })),
                    )
                  }
                >
                  Disable
                </button>
                <Link to={`/skills/${node.id}`}>Open Skill Studio</Link>
              </>
            )}
          </aside>
        )}
      </section>
      <details>
        <summary>Accessible skill table ({visible.length})</summary>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Runtime</th>
              <th>Status</th>
              <th>Risk</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((item) => (
              <tr key={item.id} tabIndex={0} onClick={() => setSelected(item.id)}>
                <td>{item.label}</td>
                <td>{item.runtimeType}</td>
                <td>{item.status}</td>
                <td>{item.riskLevel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <section className="universe-bottom">
        <button className="secondary" onClick={() => setPaused((value) => !value)}>
          {paused ? 'Resume visual updates' : 'Pause visual updates'}
        </button>
      </section>
    </main>
  );
}
