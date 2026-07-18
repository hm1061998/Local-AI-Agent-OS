import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Html, Line, OrbitControls } from '@react-three/drei';
import type { AgentEvent } from '@local-agent/agent-protocol';
import { Link, useNavigate } from 'react-router-dom';
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
          ? '#73f2c2'
          : node.status === 'disabled'
            ? '#51676b'
            : '#60a5fa';
  return (
    <group position={node.position}>
      <mesh ref={ref} onClick={onSelect} scale={clampNodeSize(node.usageCount)}>
        <icosahedronGeometry
          args={[node.kind === 'agent' ? 1.1 : 0.65, node.visualState === 'creating' ? 1 : 2]}
        />
        <meshStandardMaterial
          color={color}
          wireframe={node.visualState === 'creating'}
          transparent
          opacity={node.status === 'disabled' ? 0.35 : 1}
        />
      </mesh>
      <Html center distanceFactor={10}>
        <button className={`node-label ${selected ? 'selected' : ''}`} onClick={onSelect}>
          {node.kind === 'agent' ? '◆' : '●'} {node.label}
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
      <ambientLight intensity={quality === 'low' ? 1.2 : 0.8} />
      <pointLight position={[5, 8, 5]} intensity={quality === 'high' ? 40 : 20} />
      {graph.edges.map((edge) => {
        const a = map.get(edge.source),
          b = map.get(edge.target);
        return a && b ? (
          <Line
            key={edge.id}
            points={[a, b]}
            color={edge.active ? '#ffd166' : '#31565d'}
            lineWidth={Math.min(4, Math.max(1, edge.weight))}
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
      <OrbitControls enableDamping={!reduced} />
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
export function Universe() {
  const [skills, setSkills] = useState<any[]>([]),
    [graph, setGraph] = useState<UniverseState>(() => graphFromSkills([])),
    [selected, setSelected] = useState<string>(),
    [search, setSearch] = useState(''),
    [quality, setQuality] = useState('medium'),
    [force2D, setForce2D] = useState(false),
    [telemetry, setTelemetry] = useState<any>(),
    [input, setInput] = useState(''),
    [paused, setPaused] = useState(false),
    navigate = useNavigate();
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
    };
    socket.on('task.event', listener);
    return () => {
      socket.off('task.event', listener);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [paused]);
  const node = graph.nodes.find((item) => item.id === selected),
    visible = graph.nodes.filter((item) => item.label.toLowerCase().includes(search.toLowerCase()));
  const run = async () => {
    if (!input.trim()) return;
    const task = await api.create(input);
    navigate(`/tasks/${task.id}/inspect`);
  };
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
          <h2>Execution trace</h2>
          <ol>
            {graph.events.slice(-50).map((event) => (
              <li key={event.id}>
                <time>{event.sequence}</time>
                <span>{event.message}</span>
              </li>
            ))}
          </ol>
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
        <input
          aria-label="Universe prompt"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="Give the agent a task"
        />
        <button onClick={() => void run()}>Run</button>
        <button className="secondary" onClick={() => setPaused((value) => !value)}>
          {paused ? 'Resume visual updates' : 'Pause visual updates'}
        </button>
        {graph.currentTaskId && (
          <button className="secondary" onClick={() => void api.cancel(graph.currentTaskId!)}>
            Cancel
          </button>
        )}
      </section>
    </main>
  );
}
