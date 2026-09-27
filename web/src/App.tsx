import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import type { Config, Status } from './api.ts';
import type { Check, Run, Task } from './types.ts';

export function App(): JSX.Element {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [config, setConfig] = useState<Config | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setRuns(await api.runs());
  }, []);

  useEffect(() => {
    void (async (): Promise<void> => {
      try {
        const [t, c] = await Promise.all([api.tasks(), api.config()]);
        setTasks(t);
        setConfig(c);
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, [refresh]);

  return (
    <div className="wrap">
      <header>
        <h1>CF-Bench</h1>
        <p>{config === null ? ' ' : config.zoneName}</p>
      </header>

      {error !== null && <div className="notice err">{error}</div>}

      {tasks.map((task) => (
        <TaskCard
          key={task.id}
          task={task}
          config={config}
          runs={runs.filter((r) => r.task_id === task.id)}
          expanded={open === task.id}
          onToggle={() => { setOpen(open === task.id ? null : task.id); }}
          onChanged={refresh}
        />
      ))}
    </div>
  );
}

type Phase = 'idle' | 'checking' | 'resetting' | 'grading';

interface TaskCardProps {
  task: Task;
  config: Config | null;
  runs: Run[];
  expanded: boolean;
  onToggle: () => void;
  onChanged: () => Promise<void>;
}

function TaskCard({ task, config, runs, expanded, onToggle, onChanged }: TaskCardProps): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<string | null>(null);

  const check = useCallback(async (): Promise<void> => {
    setPhase('checking');
    setFailure(null);
    try {
      setStatus(await api.status(task.id));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  }, [task.id]);

  useEffect(() => {
    if (expanded && status === null && phase === 'idle') void check();
  }, [expanded, status, phase, check]);

  const busy = phase !== 'idle';

  const reset = async (): Promise<void> => {
    setPhase('resetting');
    setFailure(null);
    try {
      await api.reset(task.id);
      setStatus(await api.status(task.id));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  };

  const grade = async (): Promise<void> => {
    setPhase('grading');
    setFailure(null);
    try {
      await api.grade(task.id, { actor: 'human' });
      setStatus(await api.status(task.id));
      await onChanged();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
    } finally {
      setPhase('idle');
    }
  };

  return (
    <section className="task">
      <div className="task-head" onClick={onToggle}>
        <span className="chev">{expanded ? '▾' : '▸'}</span>
        <h2>{task.title}</h2>
        <span className="id">{task.id}</span>
        <span className={`badge ${task.difficulty}`}>{task.difficulty}</span>
        <StatusDot status={status} phase={phase} expanded={expanded} />
      </div>

      {expanded && (
        <div className="task-body">
          <pre className="ticket">{task.prompt}</pre>

          <ol className="steps">
            <li>
              <button disabled={busy} onClick={() => { void reset(); }}>
                {phase === 'resetting' ? 'Resetting…' : 'Reset'}
              </button>
            </li>
            <li>
              {config === null ? (
                <button disabled>Cloudflare</button>
              ) : (
                <a className="btn" href={config.dashboardUrl} target="_blank" rel="noreferrer">
                  Cloudflare &#8599;
                </a>
              )}
            </li>
            <li>
              <button className="primary" disabled={busy} onClick={() => { void grade(); }}>
                {phase === 'grading' ? 'Grading…' : 'Grade'}
              </button>
            </li>
          </ol>

          {failure !== null && <div className="notice err">{failure}</div>}

          {status !== null && <CheckList checks={status.checks} />}

          <div className="runs-head">
            <h3>Attempts</h3>
            <span className="kind">{runs.length}</span>
          </div>
          {runs.length === 0 ? (
            <p className="empty">None yet</p>
          ) : (
            runs.map((r) => <RunRow key={r.id} run={r} />)
          )}
        </div>
      )}
    </section>
  );
}

function StatusDot({
  status, phase, expanded,
}: { status: Status | null; phase: Phase; expanded: boolean }): JSX.Element {
  if (phase === 'checking' || phase === 'resetting' || phase === 'grading') {
    return <span className="state working">checking</span>;
  }
  if (status === null) return <span className="state unknown">{expanded ? '' : ''}</span>;
  return (
    <span className={`state ${status.pass ? 'fixed' : 'broken'}`}>
      {status.pass ? 'fixed' : 'broken'}
    </span>
  );
}

function CheckList({ checks }: { checks: Check[] }): JSX.Element {
  return (
    <div className="checks">
      {checks.map((c) => (
        <div className="check" key={c.name}>
          <span className={`mark ${c.pass ? 'pass' : 'fail'}`}>{c.pass ? 'PASS' : 'FAIL'}</span>
          <span className="check-name">{c.name}</span>
          <span className="check-detail">{c.detail}</span>
        </div>
      ))}
    </div>
  );
}

/** Drop the vendor prefix; the agent_kind chip already says where it ran. */
function shortModel(model: string): string {
  const slash = model.indexOf('/');
  return slash === -1 ? model : model.slice(slash + 1);
}

function RunRow({ run }: { run: Run }): JSX.Element {
  const [open, setOpen] = useState(false);
  const passed = run.checks.filter((c) => c.pass).length;
  const who = run.agent_kind ?? run.actor;

  return (
    <div className="run">
      <div className="run-head" onClick={() => { setOpen(!open); }}>
        <span className="chev">{open ? '▾' : '▸'}</span>
        <span className="actor">{who}</span>
        {run.model !== null && <span className="model">{shortModel(run.model)}</span>}
        <time>{new Date(run.created_at).toLocaleString()}</time>
        <span className="spacer" />
        {run.steps !== null && <span className="kind">{run.steps} steps</span>}
        {run.duration_seconds !== null && (
          <span className="kind">{Math.round(run.duration_seconds)}s</span>
        )}
        {run.checks.length > 0 && (
          <span className="kind">{passed}/{run.checks.length}</span>
        )}
        {run.passed === null ? (
          <span className="verdict pending">{run.status}</span>
        ) : (
          <span className={`verdict ${run.passed === 1 ? 'pass' : 'fail'}`}>
            {run.passed === 1 ? 'PASS' : 'FAIL'}
          </span>
        )}
      </div>
      {open && (
        <div className="run-body">
          {run.error !== null && <div className="notice err">{run.error}</div>}
          {run.checks.length === 0 ? (
            <p className="empty">Not graded</p>
          ) : (
            <CheckList checks={run.checks} />
          )}
        </div>
      )}
    </div>
  );
}
