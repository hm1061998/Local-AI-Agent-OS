import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentEvent } from '@local-agent/agent-protocol';
import { api, socket } from './api';
import { useAgentStore } from './store';
const Universe = lazy(() => import('./Universe').then((module) => ({ default: module.Universe })));
const ExecutionInspector = lazy(() =>
  import('./Phase4Panels').then((module) => ({ default: module.ExecutionInspector })),
);
const WorkflowEditor = lazy(() =>
  import('./Phase4Panels').then((module) => ({ default: module.WorkflowEditor })),
);
const Deferred = ({ children }: { children: ReactNode }) => (
  <Suspense
    fallback={
      <main>
        <p>Loading visual tools…</p>
      </main>
    }
  >
    {children}
  </Suspense>
);

function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <header>
        <Link to="/workspace" className="brand">
          Local Agent OS
        </Link>
        <nav>
          <Link to="/workspace">Workspace</Link>
          <Link to="/skills">Skills</Link>
          <Link to="/approvals">Approvals</Link>
          <Link to="/sandbox">Sandbox</Link>
          <Link to="/universe">Universe</Link>
          <Link to="/agents">Agents</Link>
          <Link to="/workflows/new">Workflows</Link>
          <Link to="/settings/models">Models</Link>
        </nav>
      </header>
      {children}
    </div>
  );
}

function Timeline() {
  const events = useAgentStore((state) => state.events);
  return (
    <aside data-testid="execution-trace">
      <h2>Execution trace</h2>
      <ol>
        {events.map((event) => (
          <li key={event.id} className={event.state}>
            <time>{new Date(event.timestamp).toLocaleTimeString()}</time>
            <span>{event.message}</span>
          </li>
        ))}
      </ol>
      {!events.length && <p className="muted">Timeline sẽ xuất hiện tại đây.</p>}
    </aside>
  );
}

function Workspace() {
  const [input, setInput] = useState('');
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 10000,
  });
  const { data: tasks = [] } = useQuery({
    queryKey: ['tasks'],
    queryFn: api.tasks,
    refetchInterval: 3000,
  });
  const active = useAgentStore((state) => state.active);
  const stream = useAgentStore((state) => state.stream);
  const setActive = useAgentStore((state) => state.setActive);
  const addEvent = useAgentStore((state) => state.addEvent);
  useEffect(() => {
    const listener = (event: AgentEvent) => {
      addEvent(event);
      void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    };
    socket.on('task.event', listener);
    return () => {
      socket.off('task.event', listener);
    };
  }, [addEvent, queryClient]);
  const run = async () => {
    if (!input.trim()) return;
    const task = await api.create(input);
    setActive(task);
    navigate(`/tasks/${task.id}`);
  };
  return (
    <Layout>
      <main className="grid">
        <section>
          <div
            data-testid="model-status"
            className={`status ${health?.chatModelAvailable ? 'ok' : 'bad'}`}
          >
            <b>{health?.chatModel ?? 'Ollama'}</b>
            <span>{health?.message ?? 'Đang kiểm tra model...'}</span>
          </div>
          <h1>Giao việc cho agent cục bộ</h1>
          <textarea
            aria-label="Yêu cầu"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="Phân tích source code và tạo báo cáo Markdown"
          />
          <div className="actions">
            <button onClick={() => void run()}>Run</button>
            <button
              className="secondary"
              disabled={!active}
              onClick={() => active && void api.cancel(active.id)}
            >
              Cancel
            </button>
          </div>
          <div className="response">
            <h2>Streaming response</h2>
            <p>{stream || 'Agent đang chờ yêu cầu.'}</p>
          </div>
          <h2>Task gần đây</h2>
          <div className="tasks">
            {tasks.map((task) => (
              <Link to={`/tasks/${task.id}`} key={task.id}>
                <span>{task.title}</span>
                <small>{task.state}</small>
              </Link>
            ))}
          </div>
        </section>
        <Timeline />
      </main>
    </Layout>
  );
}

function TaskDetail() {
  const { taskId = '' } = useParams();
  const setActive = useAgentStore((state) => state.setActive);
  const setEvents = useAgentStore((state) => state.setEvents);
  const { data: task } = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.task(taskId),
    refetchInterval: 1500,
  });
  useEffect(() => {
    if (task) setActive(task);
  }, [task, setActive]);
  useEffect(() => {
    void api.events(taskId).then(setEvents);
  }, [taskId, setEvents]);
  useEffect(() => {
    const listener = (event: AgentEvent) => {
      if (event.taskId === taskId) useAgentStore.getState().addEvent(event);
    };
    socket.on('task.event', listener);
    return () => {
      socket.off('task.event', listener);
    };
  }, [taskId]);
  return (
    <Layout>
      <main className="grid">
        <section>
          <Link to="/workspace">← Workspace</Link>
          <h1>{task?.title ?? 'Đang tải...'}</h1>
          <p data-testid="task-state" className="pill">
            {task?.state}
          </p>
          <p>{task?.resultSummary || task?.errorMessage || task?.userInput}</p>
          <p>
            <Link to={`/tasks/${taskId}/agents`}>Open agent flow →</Link>
          </p>
          {task?.state === 'waiting_for_approval' && (
            <p>
              <Link to="/approvals">Review skill proposal to continue this task →</Link>
            </p>
          )}
          <button
            className="secondary"
            disabled={!task || ['completed', 'failed', 'cancelled'].includes(task.state)}
            onClick={() => void api.cancel(taskId)}
          >
            Cancel task
          </button>
        </section>
        <Timeline />
      </main>
    </Layout>
  );
}

function AgentFlow({ taskOnly = false }: { taskOnly?: boolean }) {
  const { taskId = '' } = useParams();
  const queryClient = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ['agent-settings'], queryFn: api.agentSettings });
  const { data } = useQuery({
    queryKey: ['agent-flow', taskId],
    queryFn: () => (taskOnly ? api.taskAgents(taskId) : api.agentRuns()),
    refetchInterval: 1500,
  });
  const runs = taskOnly ? (data ? [data] : []) : (data ?? []);
  return (
    <Layout>
      <main>
        <h1>Multi-agent control plane</h1>
        <section className="card">
          <h2>Operating mode</h2>
          <select
            aria-label="Agent mode"
            value={settings?.mode ?? 'automatic'}
            onChange={(event) =>
              void api
                .setAgentMode(event.target.value as 'automatic' | 'single' | 'multi')
                .then(() => queryClient.invalidateQueries({ queryKey: ['agent-settings'] }))
            }
          >
            <option value="automatic">Automatic</option>
            <option value="single">Single-agent</option>
            <option value="multi">Multi-agent</option>
          </select>
          <p className="muted">
            Automatic uses risk, missing skills, step count, file changes and command execution.
          </p>
        </section>
        {runs.map((run: any) => (
          <section className="card agent-flow" key={run.taskId}>
            <h2>
              <Link to={`/tasks/${run.taskId}/agents`}>{run.taskId.slice(0, 8)}</Link> · {run.state}
            </h2>
            <p>
              Owner: {run.currentOwner ?? 'none'} · Messages {run.usage.messages}/
              {run.budget.maxTotalMessages} · Delegations {run.usage.delegations}/
              {run.budget.maxDelegations}
            </p>
            <div className="agent-cluster">
              {[
                'supervisor',
                'planner',
                'skill_builder',
                'security_reviewer',
                'executor',
                'result_judge',
              ].map((role) => (
                <span
                  className={
                    run.assignments.some((item: any) => item.role === role)
                      ? 'agent-node active'
                      : 'agent-node'
                  }
                  key={role}
                >
                  {role.replace('_', ' ')}
                </span>
              ))}
            </div>
            <ol className="message-flow">
              {run.messages.map((message: any) => (
                <li key={message.id}>
                  <b>
                    {message.sequence}. {message.from} → {message.to}
                  </b>
                  <span>{message.type}</span>
                </li>
              ))}
            </ol>
            {run.assignments.map((item: any) => (
              <p key={item.id}>
                <b>{item.role}:</b> {item.summary}
              </p>
            ))}
          </section>
        ))}
        {!runs.length && (
          <p className="muted">
            No multi-agent run has been recorded yet. Single-agent tasks remain available.
          </p>
        )}
      </main>
    </Layout>
  );
}

function Models() {
  const { data } = useQuery({ queryKey: ['health'], queryFn: api.health });
  return (
    <Layout>
      <main>
        <h1>Model settings</h1>
        <div className="card">
          <h2>{data?.chatModel}</h2>
          <p>{data?.message}</p>
          <code>{data?.baseUrl}</code>
          {data && !data.chatModelAvailable && <pre>ollama pull {data.chatModel}</pre>}
        </div>
      </main>
    </Layout>
  );
}

function Skills() {
  const { data = [] } = useQuery({ queryKey: ['skills'], queryFn: api.skills });
  return (
    <Layout>
      <main>
        <h1>Skill Studio</h1>
        <div className="tasks">
          {data.map((skill) => (
            <Link key={skill.id} to={`/skills/${skill.id}`}>
              <span>
                <b>{skill.name}</b>
                <br />
                <small>
                  {skill.manifest.runtime.type} · v{skill.version}
                </small>
              </span>
              <span className="pill">{skill.status}</span>
            </Link>
          ))}
        </div>
      </main>
    </Layout>
  );
}
function SkillDetail() {
  const { skillId = '' } = useParams();
  const { data } = useQuery({ queryKey: ['skill', skillId], queryFn: () => api.skill(skillId) });
  const { data: versions = [] } = useQuery({
    queryKey: ['versions', skillId],
    queryFn: () => api.versions(skillId),
  });
  return (
    <Layout>
      <main>
        <Link to="/skills">← Skill Studio</Link>
        <h1>{data?.name}</h1>
        <div className="card">
          <p>{data?.description}</p>
          <p>
            Success rate: {Math.round((data?.successRate ?? 0) * 100)}% · Uses:{' '}
            {data?.usageCount ?? 0}
          </p>
          <h2>Permissions</h2>
          <pre>{JSON.stringify(data?.manifest?.permissions, null, 2)}</pre>
          <button className="secondary" onClick={() => void api.disable(skillId)}>
            Disable
          </button>
        </div>
        <h2>Versions</h2>
        <div className="tasks">
          {versions.map((v) => (
            <div className="card" key={v.version}>
              v{v.version} · {v.createdAt}
            </div>
          ))}
        </div>
      </main>
    </Layout>
  );
}
function Approvals() {
  const { data = [], refetch } = useQuery({ queryKey: ['approvals'], queryFn: api.approvals });
  return (
    <Layout>
      <main>
        <h1>Approval Center</h1>
        <div className="tasks">
          {data.map((a) => (
            <div className="card" key={a.id}>
              <h2>{a.proposal.name}</h2>
              <p>{a.proposal.reason}</p>
              <p>
                <span className="pill">{a.status}</span> · {a.proposal.runtimeType} · risk{' '}
                {a.proposal.riskLevel}
              </p>
              <pre>{JSON.stringify(a.proposal.permissions, null, 2)}</pre>
              {a.status === 'pending' && (
                <div className="actions">
                  <button onClick={() => void api.approve(a.id).then(() => refetch())}>
                    Approve version
                  </button>
                  <button
                    className="secondary"
                    onClick={() => void api.reject(a.id).then(() => refetch())}
                  >
                    Reject
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </main>
    </Layout>
  );
}

function Sandbox() {
  const [runtime, setRuntime] = useState<'typescript' | 'python'>('typescript');
  const [skillId, setSkillId] = useState('hello-sandbox');
  const [input, setInput] = useState('{"name":"Minh"}');
  const [source, setSource] = useState(
    "exports.run = async (input) => ({ message: `Hello ${input.name ?? 'world'}`, input });",
  );
  const [error, setError] = useState('');
  const [description, setDescription] = useState('Create a structured greeting from input.name');
  const { data = [], refetch } = useQuery({
    queryKey: ['sandbox-executions'],
    queryFn: api.sandboxExecutions,
    refetchInterval: 2000,
  });
  const changeRuntime = (value: 'typescript' | 'python') => {
    setRuntime(value);
    setSource(
      value === 'typescript'
        ? "exports.run = async (input) => ({ message: `Hello ${input.name ?? 'world'}`, input });"
        : "def run(input):\n    return {'message': f\"Hello {input.get('name', 'world')}\", 'input': input}",
    );
  };
  const scan = async () => {
    try {
      setError('');
      const file = runtime === 'typescript' ? 'dist/index.js' : 'src/skill.py';
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
      const checksum = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
      await api.sandboxScan({
        skillId,
        package: {
          runtime,
          files: { [file]: source },
          dependencies: {},
          lockfile: '# locked by Local Agent OS',
          checksums: { [file]: checksum },
          outputSchema: { type: 'object', required: ['message'] },
        },
      });
      await refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  const parsedInput = () => {
    try {
      return JSON.parse(input);
    } catch {
      throw new Error('Input phải là JSON hợp lệ');
    }
  };
  const generate = async () => {
    try {
      setError('');
      await api.sandboxGenerate(description, runtime);
      await refetch();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  return (
    <Layout>
      <main>
        <h1>Executable Sandbox</h1>
        <p className="muted">
          Network is disabled by default. Source and findings must be approved before container
          execution.
        </p>
        <section className="card sandbox-builder">
          <h2>Test an executable skill</h2>
          <label>
            AI generation request
            <input value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <button className="secondary" onClick={() => void generate()}>
            Generate and scan with AI
          </button>
          <label>
            Skill ID
            <input value={skillId} onChange={(event) => setSkillId(event.target.value)} />
          </label>
          <label>
            Runtime
            <select
              value={runtime}
              onChange={(event) => changeRuntime(event.target.value as 'typescript' | 'python')}
            >
              <option value="typescript">TypeScript / JavaScript</option>
              <option value="python">Python</option>
            </select>
          </label>
          <label>
            Skill source
            <textarea
              aria-label="Skill source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <label>
            Input JSON
            <textarea
              aria-label="Sandbox input"
              value={input}
              onChange={(event) => setInput(event.target.value)}
            />
          </label>
          {error && <pre className="error">{error}</pre>}
          <button onClick={() => void scan()}>Scan package</button>
        </section>
        <div className="tasks">
          {data.map((item) => (
            <div className="card" key={item.id}>
              <h2>{item.skillId}</h2>
              <p>
                <span className="pill">{item.status}</span> · {item.runtime}
              </p>
              <h3>Static analysis findings</h3>
              <pre>{JSON.stringify(item.findings, null, 2)}</pre>
              <div className="actions">
                {item.status === 'waiting_for_approval' && (
                  <>
                    <button onClick={() => void api.sandboxApprove(item.id).then(() => refetch())}>
                      Approve version
                    </button>
                    <button
                      className="secondary"
                      onClick={() => void api.sandboxReject(item.id).then(() => refetch())}
                    >
                      Reject
                    </button>
                  </>
                )}
                {item.status === 'approved' && (
                  <button
                    onClick={() => {
                      try {
                        void api
                          .sandboxRun(item.id, parsedInput())
                          .then(() => refetch())
                          .catch((reason) => setError(String(reason)));
                      } catch (reason) {
                        setError(reason instanceof Error ? reason.message : String(reason));
                      }
                    }}
                  >
                    Run sandbox
                  </button>
                )}
                {item.status === 'running' && (
                  <button
                    className="secondary"
                    onClick={() => void api.sandboxKill(item.id).then(() => refetch())}
                  >
                    Kill sandbox
                  </button>
                )}
              </div>
              {item.output !== undefined && (
                <>
                  <h3>Output</h3>
                  <pre data-testid="sandbox-output">{JSON.stringify(item.output, null, 2)}</pre>
                </>
              )}
              {item.staged && (
                <>
                  <h3>Staged diff</h3>
                  {item.staged.map((change: any) => (
                    <div className="diff" key={change.path}>
                      <b>
                        {change.kind}: {change.path}
                      </b>
                      <pre>
                        - {change.before ?? '(new file)'}
                        {`\n`}+ {change.after}
                      </pre>
                    </div>
                  ))}
                  {item.status === 'waiting_for_changes_approval' && (
                    <button onClick={() => void api.sandboxApply(item.id).then(() => refetch())}>
                      Apply approved changes
                    </button>
                  )}
                </>
              )}
              {item.status === 'changes_applied' && (
                <button
                  className="secondary"
                  onClick={() => void api.sandboxRollback(item.id).then(() => refetch())}
                >
                  Rollback changes
                </button>
              )}
              {item.stdout && (
                <>
                  <h3>stdout</h3>
                  <pre>{item.stdout}</pre>
                </>
              )}
              {item.stderr && (
                <>
                  <h3>stderr</h3>
                  <pre>{item.stderr}</pre>
                </>
              )}
            </div>
          ))}
        </div>
      </main>
    </Layout>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/workspace" element={<Workspace />} />
      <Route path="/tasks/:taskId" element={<TaskDetail />} />
      <Route path="/agents" element={<AgentFlow />} />
      <Route path="/tasks/:taskId/agents" element={<AgentFlow taskOnly />} />
      <Route path="/skills" element={<Skills />} />
      <Route path="/skills/:skillId" element={<SkillDetail />} />
      <Route path="/approvals" element={<Approvals />} />
      <Route path="/sandbox" element={<Sandbox />} />
      <Route
        path="/universe"
        element={
          <Layout>
            <Deferred>
              <Universe />
            </Deferred>
          </Layout>
        }
      />
      <Route
        path="/tasks/:taskId/inspect"
        element={
          <Layout>
            <Deferred>
              <ExecutionInspector />
            </Deferred>
          </Layout>
        }
      />
      <Route
        path="/workflows/new"
        element={
          <Layout>
            <Deferred>
              <WorkflowEditor />
            </Deferred>
          </Layout>
        }
      />
      <Route
        path="/workflows/:workflowId"
        element={
          <Layout>
            <Deferred>
              <WorkflowEditor />
            </Deferred>
          </Layout>
        }
      />
      <Route path="/settings/models" element={<Models />} />
      <Route path="*" element={<Workspace />} />
    </Routes>
  );
}
