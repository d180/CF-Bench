import type { GradeResult, Task, TaskContext } from './types.ts';

export interface SettleOptions {
  /** Total time to keep retrying a failing grade before accepting it. */
  settleMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, result: GradeResult) => void;
}

const sleepReal = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Grade with a settling window.
 *
 * Cloudflare configuration changes take a few seconds to reach every edge
 * location. A grader that ran the instant a fix was applied would fail correct
 * work for being three seconds young. Retrying until the deadline removes that
 * race without ever turning a genuine failure into a pass - a task that is
 * still broken simply stays broken for the whole window.
 *
 * Tasks stay pure: `grade()` itself performs exactly one observation, which is
 * what makes it straightforward to unit test.
 */
export async function gradeUntilSettled(
  task: Task,
  ctx: TaskContext,
  options: SettleOptions = {},
): Promise<GradeResult> {
  const settleMs = options.settleMs ?? 30_000;
  const intervalMs = options.intervalMs ?? 5_000;
  const sleep = options.sleep ?? sleepReal;
  const deadline = Date.now() + settleMs;

  let attempt = 0;
  let result = await task.grade(ctx);
  attempt += 1;

  while (!result.pass && Date.now() + intervalMs < deadline) {
    options.onRetry?.(attempt, result);
    await sleep(intervalMs);
    result = await task.grade(ctx);
    attempt += 1;
  }

  return result;
}
