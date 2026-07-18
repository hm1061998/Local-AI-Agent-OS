import { useEffect, useState, type ReactNode } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AgentEvent } from '@local-agent/agent-protocol';
import { api, socket } from './api';
import { useAgentStore } from './store';

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

export function App() {
  return (
    <Routes>
      <Route path="/workspace" element={<Workspace />} />
      <Route path="/tasks/:taskId" element={<TaskDetail />} />
      <Route path="/skills" element={<Skills />} />
      <Route path="/skills/:skillId" element={<SkillDetail />} />
      <Route path="/approvals" element={<Approvals />} />
      <Route path="/settings/models" element={<Models />} />
      <Route path="*" element={<Workspace />} />
    </Routes>
  );
}
