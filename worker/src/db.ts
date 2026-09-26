import type { Check, GradeResult } from '@cf-bench/tasks';
import type { Env } from './env.ts';

export type Actor = 'human' | 'agent';

export interface RunRow {
  id: string;
  task_id: string;
  actor: Actor;
  status: string;
  passed: number | null;
  created_at: string;
  finished_at: string | null;
  graded_at: string | null;
  coasty_run_id: string | null;
  coasty_status: string | null;
  coasty_steps: number | null;
  coasty_cost_cents: number | null;
  video_url: string | null;
  notes: string | null;
  error: string | null;
}

/** What the API returns. Note `webhook_secret` is absent by construction. */
export interface RunView extends RunRow {
  checks: Check[];
}

export async function createRun(
  env: Env,
  input: { taskId: string; actor: Actor; status: string; videoUrl?: string; notes?: string },
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO runs (id, task_id, actor, status, created_at, video_url, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.taskId,
      input.actor,
      input.status,
      new Date().toISOString(),
      input.videoUrl ?? null,
      input.notes ?? null,
    )
    .run();
  return id;
}

export async function saveGrade(env: Env, runId: string, result: GradeResult): Promise<void> {
  const now = new Date().toISOString();
  const statements = [
    env.DB.prepare(
      `UPDATE runs SET status = 'graded', passed = ?, graded_at = ?, finished_at = COALESCE(finished_at, ?)
       WHERE id = ?`,
    ).bind(result.pass ? 1 : 0, now, now, runId),
    env.DB.prepare(`DELETE FROM checks WHERE run_id = ?`).bind(runId),
    ...result.checks.map((check, index) =>
      env.DB.prepare(
        `INSERT INTO checks (run_id, ord, name, pass, kind, detail) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(runId, index, check.name, check.pass ? 1 : 0, check.kind, check.detail),
    ),
  ];
  // Batched so a run is never left marked graded with a half-written set of
  // checks, which would misreport why it passed or failed.
  await env.DB.batch(statements);
}

export async function markRunError(env: Env, runId: string, message: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE runs SET status = 'error', error = ?, finished_at = ? WHERE id = ?`,
  )
    .bind(message.slice(0, 2000), new Date().toISOString(), runId)
    .run();
}

export async function listRuns(env: Env, taskId?: string): Promise<RunView[]> {
  const runs = taskId === undefined
    ? await env.DB.prepare(
        `SELECT * FROM runs ORDER BY created_at DESC LIMIT 200`,
      ).all<RunRow>()
    : await env.DB.prepare(
        `SELECT * FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 200`,
      ).bind(taskId).all<RunRow>();

  const rows = runs.results;
  if (rows.length === 0) return [];

  const checks = await env.DB.prepare(
    `SELECT run_id, name, pass, kind, detail FROM checks ORDER BY run_id, ord`,
  ).all<{ run_id: string; name: string; pass: number; kind: string; detail: string | null }>();

  const byRun = new Map<string, Check[]>();
  for (const row of checks.results) {
    const list = byRun.get(row.run_id) ?? [];
    list.push({
      name: row.name,
      pass: row.pass === 1,
      kind: row.kind === 'config' ? 'config' : 'http',
      detail: row.detail ?? '',
    });
    byRun.set(row.run_id, list);
  }

  // Strip webhook_secret explicitly rather than relying on SELECT * ordering -
  // a future column must not leak by accident.
  return rows.map((row) => {
    const { ...rest } = row as RunRow & { webhook_secret?: string };
    delete (rest as { webhook_secret?: string }).webhook_secret;
    return { ...rest, checks: byRun.get(row.id) ?? [] };
  });
}

/**
 * Fixed-window counter in D1.
 *
 * Guards the expensive, outward-facing actions - an agent run provisions a
 * real machine and spends real money, so the button must not be spammable.
 */
export async function takeRateLimit(
  env: Env,
  bucket: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);

  await env.DB.prepare(
    `INSERT INTO rate_limit (bucket, window_start, count) VALUES (?, ?, 0)
     ON CONFLICT(bucket) DO UPDATE SET
       window_start = CASE WHEN rate_limit.window_start < ? THEN ? ELSE rate_limit.window_start END,
       count        = CASE WHEN rate_limit.window_start < ? THEN 0 ELSE rate_limit.count END`,
  )
    .bind(bucket, windowStart, windowStart, windowStart, windowStart)
    .run();

  const row = await env.DB.prepare(`SELECT count FROM rate_limit WHERE bucket = ?`)
    .bind(bucket)
    .first<{ count: number }>();

  if ((row?.count ?? 0) >= limit) return false;

  await env.DB.prepare(`UPDATE rate_limit SET count = count + 1 WHERE bucket = ?`)
    .bind(bucket)
    .run();
  return true;
}
