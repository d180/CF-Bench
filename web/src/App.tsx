import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Check, Run, Task } from './types.ts';

type Busy = Record<string, string | undefined>;

export function App(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>({});
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setRuns(await api.runs());
  }, []);

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        setTasks(await api.tasks());
        await refresh();
      } catch (error) {
        setMessage({ text: error instanceof Error ? error.message : String(error), ok: false });
      }
    })();
  }, [refresh]);

  const run = async (taskId: string, label: string, action: () => Promise<string>): Promise<void> => {
    setBusy((b) => ({ ...b, [taskId]: label }));
    setMessage(null);
    try {
      setMessage({ text: await action(), ok: true });
      await refresh();
    } catch (error) {
      setMessage({ text: error instanceof Error ? error.message : String(error), ok: false });
    } finally {
      setBusy((b) => ({ ...b, [taskId]: undefined }));
    }
  };

  return (
    <div className="wrap">
      <header>
        <h1>CF-Bench</h1>
        <p>
          Realistic Cloudflare admin tasks, reset to an identical starting state and graded on the
          end result — the live configuration and what the site actually does.
        </p>
      </header>

      {message !== null && (
        <div className={`notice ${message.ok ? 'ok' : 'err'}`}>{message.text}</div>
      )}

      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          runs={runs.filter((r) => r.task_id === task.id)}
          expanded={open === task.id}
          busy={busy[task.id]}
          onToggle={() => { setOpen(open === task.id ? null : task.id); }}
          onRun={run}
        />
      ))}

      {tasks.length === 0 && message === null && <p className="empty">Loading tasks…</p>}
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  runs: Run[];
  expanded: boolean;
  busy: string | undefined;
  onToggle: () => void;
  onRun: (taskId: string, label: string, action: () => Promise<string>) => Promise<void>;
}

function TaskCard({ task, runs, expanded, busy, onToggle, onRun }: TaskCardProps): JSX.Element {
  const [videoUrl, setVideoUrl] = useState('');
  const latest = runs[0];

  return (
    <section className="task">
      <div className="task-head" onClick={onToggle}>
        <span className="id">{task.id}</span>
        <h2>{task.title}</h2>
        {latest !== undefined && <Verdict run={latest} />}
        <span className={`badge ${task.difficulty}`}>{task.difficulty}</span>
      </div>

      {expanded && (
        <div className="task-body">
          <pre className="ticket">{task.prompt}</pre>

          <div className="actions">
            <button
              disabled={busy !== undefined}
              onClick={() => {
                void onRun(task.id, 'reset', async () => (await api.reset(task.id)).message);
              }}
            >
              {busy === 'reset' ? 'Resetting…' : 'Reset'}
            </button>

            <button
              className="primary"
              disabled={busy !== undefined}
              onClick={() => {
                void onRun(task.id, 'grade', async () => {
                  const result = await api.grade(task.id, {
                    actor: 'human',
                    videoUrl: videoUrl === '' ? undefined : videoUrl,
                  });
                  return `Graded: ${result.pass ? 'PASS' : 'FAIL'}`;
                });
              }}
            >
              {busy === 'grade' ? 'Grading…' : 'Grade'}
            </button>

            <button
              disabled={busy !== undefined}
              onClick={() => {
                void onRun(task.id, 'agent', async () => {
                  const result = await api.agentRun(task.id);
                  return result.error ?? 'Agent run started.';
                });
              }}
            >
              {busy === 'agent' ? 'Starting…' : 'Run agent'}
            </button>
          </div>

          <div className="actions">
            <input
              type="url"
              placeholder="Screen recording URL (attached to the next human grade)"
              value={videoUrl}
              onChange={(e) => { setVideoUrl(e.target.value); }}
            />
          </div>

          <h3>Run history</h3>
          {runs.length === 0 ? (
            <p className="empty">No attempts yet.</p>
          ) : (
            runs.map((r) => <RunRow key={r.id} run={r} />)
          )}
        </div>
      )}
    </section>
  );
}

function Verdict({ run }: { run: Run }): JSX.Element {
  if (run.passed === null) return <span className="verdict pending">{run.status}</span>;
  return (
    <span className={`verdict ${run.passed === 1 ? 'pass' : 'fail'}`}>
      {run.passed === 1 ? 'PASS' : 'FAIL'}
    </span>
  );
}

function RunRow({ run }: { run: Run }): JSX.Element {
  const [open, setOpen] = useState(false);
  const passed = run.checks.filter((c) => c.pass).length;

  return (
    <div className="run">
      <div className="run-head" onClick={() => { setOpen(!open); }}>
        <time>{new Date(run.created_at).toLocaleString()}</time>
        <span className="actor">{run.agent_kind ?? run.actor}</span>
        <Verdict run={run} />
        {run.checks.length > 0 && (
          <span className="kind">
            {passed}/{run.checks.length} checks
          </span>
        )}
        <span className="spacer" />
        {run.video_url !== null && (
          <a href={run.video_url} target="_blank" rel="noreferrer" onClick={(e) => { e.stopPropagation(); }}>
            recording
          </a>
        )}
        {run.coasty_run_id !== null && <span className="kind">coasty {run.coasty_run_id.slice(0, 12)}</span>}
      </div>

      {open && (
        <div className="checks">
          {run.error !== null && <div className="notice err">{run.error}</div>}
          {run.checks.length === 0 && <p className="empty">Not graded yet.</p>}
          {run.checks.map((c) => <CheckRow key={c.name} check={c} />)}
          {run.notes !== null && run.notes !== '' && <p className="empty">Notes: {run.notes}</p>}
        </div>
      )}
    </div>
  );
}

function CheckRow({ check }: { check: Check }): JSX.Element {
  return (
    <div className="check">
      <span className={`mark ${check.pass ? 'pass' : 'fail'}`}>{check.pass ? 'PASS' : 'FAIL'}</span>
      <span className="check-name">{check.name}</span>
      <span className="kind">{check.kind}</span>
      <span className="check-detail">{check.detail}</span>
    </div>
  );
}
