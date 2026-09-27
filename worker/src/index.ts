import { Hono } from 'hono';
import { cors } from 'hono/cors';
import {
  getTask, gradeUntilSettled, renderBriefedPrompt, renderPrompt, seedAndConfirm, tasks,
} from '@cf-bench/tasks';
import { CoastyClient, TERMINAL_EVENTS, sha256Hex, verifySignature } from '@cf-bench/coasty';
import type { CoastyWebhookPayload } from '@cf-bench/coasty';
import { benchConfig, taskContext, type Env } from './env.ts';

interface GradeBody {
  runId?: string;
  actor?: 'human' | 'agent';
  videoUrl?: string;
  notes?: string;
}

interface RunBody {
  actor?: 'human' | 'agent';
  agentKind?: AgentKind;
  videoUrl?: string;
  notes?: string;
}

interface AgentRunBody {
  agent?: AgentKind;
}

/** A missing or malformed JSON body is an empty body, not an error. */
async function readBody<T extends object>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}
import {
  attachCoastyRun, claimWebhookDelivery, createRun, findRunByCoastyId, listRuns,
  markRunError, saveGrade, takeRateLimit, updateCoastyStatus,
} from './db.ts';
import type { AgentKind } from './db.ts';

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

/** Deployment identity the dashboard needs to link out to the real thing. */
app.get('/api/config', (c) =>
  c.json({
    zoneName: c.env.CF_ZONE_NAME,
    dashboardUrl: `https://dash.cloudflare.com/${c.env.CF_ACCOUNT_ID}/${c.env.CF_ZONE_NAME}`,
  }),
);

/**
 * Current state of the task, without recording anything.
 *
 * Grading and recording an attempt are different acts. Checking whether a task
 * is currently broken should not leave a run in the history, or the history
 * stops being a list of attempts.
 */
app.get('/api/tasks/:id/status', async (c) => {
  const task = getTask(c.req.param('id'));
  const result = await task.grade(taskContext(c.env));
  return c.json({ pass: result.pass, checks: result.checks });
});

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
    actor: body.actor ?? 'human',
    status: 'pending',
    agentKind: body.agentKind,
    videoUrl: body.videoUrl,
    notes: body.notes,
  });
  return c.json({ runId });
});

/**
 * Agent runs spend real money - a machine is provisioned and every model step
 * is billed - so this is rate limited before anything is dispatched.
 */
/**
 * Dispatch a Coasty agent run.
 *
 * browser-use is deliberately NOT dispatchable from here: it is a local
 * subprocess and the Workers runtime cannot spawn one. The CLI drives that
 * agent and registers the resulting run through the endpoints above, so it
 * still appears in the dashboard alongside Coasty and human attempts.
 */
app.post('/api/tasks/:id/agent-run', async (c) => {
  const task = getTask(c.req.param('id'));
  const body = await readBody<AgentRunBody>(c.req.raw);
  const agent: AgentKind = body.agent ?? 'coasty';

  if (agent === 'browser-use') {
    return c.json(
      {
        error:
          'browser-use runs locally and cannot be dispatched from the Worker. ' +
          `Run: npm run cf-bench -- agent-run ${task.id} --agent browser-use`,
      },
      400,
    );
  }

  if (!(await takeRateLimit(c.env, 'agent_run', 5, 3600))) {
    return c.json({ error: 'Rate limit reached: at most 5 agent runs per hour.' }, 429);
  }
  if (c.env.COASTY_API_KEY === undefined || c.env.COASTY_API_KEY === '') {
    return c.json({ error: 'COASTY_API_KEY is not configured.' }, 503);
  }

  const ctx = taskContext(c.env);

  // Reset first, and wait until the breakage is actually observable. Handing
  // an agent a task that is not yet broken would let it score a pass for
  // doing nothing.
  const seeded = await seedAndConfirm(task, ctx, { settleMs: 45_000 });
  if (!seeded.confirmed) {
    return c.json({ error: 'Refusing to dispatch: the task still grades as PASS after reset.' }, 409);
  }

  const runId = await createRun(c.env, {
    taskId: task.id, actor: 'agent', status: 'pending', agentKind: 'coasty',
  });
  const coasty = new CoastyClient({
    apiKey: c.env.COASTY_API_KEY,
    baseUrl: c.env.COASTY_BASE_URL,
  });

  try {
    // Idempotency keys are global across endpoints for one credential, so the
    // machine and the run need distinct keys derived from our own run id -
    // stable across retries of this attempt, distinct from each other.
    const provisioned = await coasty.createMachine(
      {
        display_name: `cf-bench ${task.id}`,
        os_type: 'linux',
        desktop_enabled: true,
        // Bounds the cost of a webhook that never arrives.
        ttl_minutes: 60,
      },
      `${runId}:machine`,
    );

    const run = await coasty.createRun(
      {
        machine_id: provisioned.machine.id,
        task: renderBriefedPrompt(task, benchConfig(c.env)),
        max_steps: 60,
        deadline_seconds: 1800,
        // Nobody is watching to take over, so pausing would burn the machine's
        // TTL waiting for a person who never arrives.
        on_awaiting_human: 'fail',
        webhook_url: new URL('/api/webhooks/coasty', c.req.url).toString(),
        metadata: { cfbench_run_id: runId, cfbench_task_id: task.id },
      },
      `${runId}:run`,
    );

    await attachCoastyRun(c.env, runId, {
      id: run.id,
      machineId: provisioned.machine.id,
      status: run.status,
      webhookSecret: run.webhook_secret ?? null,
    });

    return c.json({
      runId,
      coastyRunId: run.id,
      machineId: provisioned.machine.id,
      status: run.status,
      testKey: coasty.isTestKey,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markRunError(c.env, runId, message);
    return c.json({ runId, error: message }, 502);
  }
});

/**
 * Coasty delivers terminal run outcomes here.
 *
 * Exempt from Cloudflare Access - Coasty cannot authenticate through an
 * identity provider - so the HMAC signature is the only thing standing
 * between this route and the open internet. Verify before trusting anything
 * in the body, including the run id used to look the secret up.
 */
app.post('/api/webhooks/coasty', async (c) => {
  const rawBody = await c.req.text();

  let payload: CoastyWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as CoastyWebhookPayload;
  } catch {
    return c.json({ error: 'Malformed JSON.' }, 400);
  }

  const run = await findRunByCoastyId(c.env, payload.run_id);
  // Same response whether the run is unknown or the signature is wrong, so
  // this endpoint cannot be used to enumerate valid run ids.
  if (run === null || run.webhook_secret === null) {
    return c.json({ error: 'Invalid signature.' }, 401);
  }

  const header = c.req.header('Coasty-Signature');
  if (header === undefined || !(await verifySignature(rawBody, header, run.webhook_secret))) {
    return c.json({ error: 'Invalid signature.' }, 401);
  }

  const timestamp = Number((header.split(',')[0] ?? 't=0').slice(2));
  const fresh = await claimWebhookDelivery(
    c.env, payload.run_id, payload.event, await sha256Hex(rawBody), timestamp,
  );
  if (!fresh) return c.json({ ok: true, duplicate: true });

  await updateCoastyStatus(c.env, run.id, payload.status ?? payload.event, null, null);

  if (!TERMINAL_EVENTS.has(payload.event)) {
    return c.json({ ok: true, graded: false });
  }

  // We provisioned the machine, so we own its bill. Do this before grading:
  // grading can take half a minute and the machine is billing throughout.
  if (run.coasty_machine_id !== null && c.env.COASTY_API_KEY !== undefined) {
    try {
      await new CoastyClient({
        apiKey: c.env.COASTY_API_KEY,
        baseUrl: c.env.COASTY_BASE_URL,
      }).deleteMachine(run.coasty_machine_id);
    } catch {
      // The machine's TTL is the backstop; a failed terminate must not stop
      // the run being graded and recorded.
    }
  }

  // Grade regardless of what Coasty says the agent achieved. A run that
  // reports failure may still have fixed the zone, and one that reports
  // success may not have - the zone is the authority, not the agent.
  try {
    const task = getTask(run.task_id);
    const result = await gradeUntilSettled(task, taskContext(c.env), { settleMs: 30_000 });
    await saveGrade(c.env, run.id, result);
    return c.json({ ok: true, graded: true, pass: result.pass });
  } catch (error) {
    await markRunError(c.env, run.id, error instanceof Error ? error.message : String(error));
    return c.json({ ok: true, graded: false }, 200);
  }
});

app.get('/api/health', (c) => c.json({ ok: true, tasks: tasks.length }));

export default app;
