import { sslRedirectLoop } from './01-ssl-redirect-loop.ts';
import { wafAdminLockdown } from './03-waf-admin-lockdown.ts';
import { cacheStaleApi } from './05-cache-stale-api.ts';
import type { Task } from './types.ts';

export const tasks: Task[] = [sslRedirectLoop, wafAdminLockdown, cacheStaleApi];

export function getTask(id: string): Task {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) {
    throw new Error(`Unknown task "${id}". Known tasks: ${tasks.map((t) => t.id).join(', ')}`);
  }
  return task;
}

export { sslRedirectLoop, wafAdminLockdown, cacheStaleApi };
export { createHttpProbe } from './http.ts';
export type { HttpProbe, ProbeOptions, ProbeResult } from './http.ts';
export { gradeUntilSettled, gradeUntilBroken, seedAndConfirm } from './runner.ts';
export type { SettleOptions, SeedConfirmation } from './runner.ts';
export { applyHealthyBaseline } from './baseline.ts';
export { summarize, renderPrompt } from './types.ts';
export type {
  BenchConfig, CfApi, Check, CheckKind, Difficulty, GradeResult, Task, TaskContext,
} from './types.ts';
