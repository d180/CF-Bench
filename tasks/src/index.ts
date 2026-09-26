import { sslRedirectLoop } from './01-ssl-redirect-loop.ts';
import type { Task } from './types.ts';

export const tasks: Task[] = [sslRedirectLoop];

export function getTask(id: string): Task {
  const task = tasks.find((t) => t.id === id);
  if (task === undefined) {
    throw new Error(`Unknown task "${id}". Known tasks: ${tasks.map((t) => t.id).join(', ')}`);
  }
  return task;
}

export { sslRedirectLoop };
export { createHttpProbe } from './http.ts';
export type { HttpProbe, ProbeOptions, ProbeResult } from './http.ts';
export { gradeUntilSettled } from './runner.ts';
export type { SettleOptions } from './runner.ts';
export { summarize } from './types.ts';
export type {
  BenchConfig, CfApi, Check, CheckKind, Difficulty, GradeResult, Task, TaskContext,
} from './types.ts';
