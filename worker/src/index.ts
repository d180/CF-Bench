import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { getTask, gradeUntilSettled, renderPrompt, seedAndConfirm, tasks } from '@cf-bench/tasks';
import { benchConfig, taskContext, type Env } from './env.ts';

interface GradeBody {
  runId?: string;
  actor?: 'human' | 'agent';
  videoUrl?: string;
  notes?: string;
}

interface RunBody {
  videoUrl?: string;
  notes?: string;
}

/** A missing or malformed JSON body is an empty body, not an error. */
async function readBody<T extends object>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
import { createRun, listRuns, markRunError, saveGrade, takeRateLimit } from './db.ts';

const app = new Hono<{ Bindings: Env }>();

app.use('/api/*', cors());

/**
 * Cloudflare Access sits in front of this Worker in production and injects a
 * signed assertion header on every request it lets through. Its absence means
 * the request did not come through Access.
 *
 * The webhook route is deliberately NOT behind Access - Coasty cannot
 * authenticate through an identity provider - so it authenticates itself with
 * an HMAC signature instead.
 */
app.use('/api/*', async (c, next) => {
  if (c.req.path.startsWith('/api/webhooks/')) return next();
  if (c.req.method === 'GET') return next();

  if (c.env.DEV_ALLOW_UNAUTHENTICATED === '1') return next();
  if (c.req.header('Cf-Access-Jwt-Assertion') === undefined) {
    return c.json({ error: 'Not authenticated. Mutating endpoints require Cloudflare Access.' }, 401);
  }
  return next();
});

app.get('/api/tasks', (c) => {
  const config = benchConfig(c.env);
  return c.json(
    tasks.map((task) => ({
      id: task.id,
      title: task.title,
      difficulty: task.difficulty,
      prompt: renderPrompt(task, config),
    })),
  );
});

app.get('/api/runs', async (c) => c.json(await listRuns(c.env)));

app.get('/api/tasks/:id/runs', async (c) => c.json(await listRuns(c.env, c.req.param('id'))));

/** Reset a task to its starting state, waiting until the breakage is live. */
app.post('/api/tasks/:id/reset', async (c) => {
  const task = getTask(c.req.param('id'));
  const outcome = await seedAndConfirm(task, taskContext(c.env), { settleMs: 45_000 });
  return c.json({
    ok: outcome.confirmed,
    confirmed: outcome.confirmed,
    checks: outcome.observed.checks,
    message: outcome.confirmed
      ? 'Task reset; the broken starting state is live.'
      : 'Reset was written but the task still grades as PASS. The starting state is not live yet.',
  });
});

/** Grade the current zone state and record the outcome against a run. */
app.post('/api/tasks/:id/grade', async (c) => {
  const task = getTask(c.req.param('id'));
  const body = await readBody<GradeBody>(c.req.raw);

  const runId =
    body.runId ??
    (await createRun(c.env, {
      taskId: task.id,
      actor: body.actor ?? 'human',
      status: 'grading',
      videoUrl: body.videoUrl,
      notes: body.notes,
    }));

  try {
    const result = await gradeUntilSettled(task, taskContext(c.env), { settleMs: 20_000 });
    await saveGrade(c.env, runId, result);
    return c.json({ runId, pass: result.pass, checks: result.checks });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunError(c.env, runId, message);
    return c.json({ runId, error: message }, 500);
  }
});

/** Record a human attempt (optionally with a link to a screen recording). */
app.post('/api/tasks/:id/runs', async (c) => {
  const task = getTask(c.req.param('id'));
  const body = await readBody<RunBody>(c.req.raw);
  const runId = await createRun(c.env, {
    taskId: task.id,
    actor: 'human',
    status: 'pending',
    videoUrl: body.videoUrl,
    notes: body.notes,
  });
  return c.json({ runId });
});

/**
 * Agent runs spend real money - a machine is provisioned and every model step
 * is billed - so this is rate limited before anything is dispatched.
 */
app.post('/api/tasks/:id/agent-run', async (c) => {
  const task = getTask(c.req.param('id'));
  const allowed = await takeRateLimit(c.env, 'agent_run', 5, 3600);
  if (!allowed) {
    return c.json({ error: 'Rate limit reached: at most 5 agent runs per hour.' }, 429);
  }
  if (c.env.COASTY_API_KEY === undefined || c.env.COASTY_API_KEY === '') {
    return c.json({ error: 'COASTY_API_KEY is not configured.' }, 503);
  }
  return c.json({ error: 'Not implemented yet.', taskId: task.id }, 501);
});

app.get('/api/health', (c) => c.json({ ok: true, tasks: tasks.length }));

export default app;
