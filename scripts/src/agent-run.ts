import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeUntilSettled, renderPrompt, seedAndConfirm } from '@cf-bench/tasks';
import type { GradeResult, Task, TaskContext } from '@cf-bench/tasks';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const agentDir = resolve(repoRoot, 'agents/browser-use');

export interface BrowserUseResult {
  ok: boolean;
  steps?: number;
  seconds?: number;
  model?: string;
  agent_self_report?: string;
  error?: string;
}

/**
 * Run the local browser-use agent against a task.
 *
 * The Worker is used only to record the attempt so it shows up in the
 * dashboard; grading happens here through the same task modules the Worker
 * uses. If the Worker is not running the attempt still runs and still grades -
 * it just is not recorded.
 */
export async function runBrowserUseAgent(
  task: Task,
  ctx: TaskContext,
  options: { workerUrl: string; maxSteps: number; model?: string },
): Promise<number> {
  console.log(`\n=== agent-run ${task.id} (browser-use) ===\n`);

  const python = resolve(agentDir, '.venv/bin/python3');
  if (!existsSync(python)) {
    console.error(`No virtualenv at ${python}`);
    console.error('Set it up first:');
    console.error(`  cd ${agentDir} && python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt`);
    return 1;
  }

  console.log('1. reset, and wait for the breakage to be observable');
  const seeded = await seedAndConfirm(task, ctx, {
    settleMs: 60_000,
    onRetry: () => { console.log('   ...not visible at the edge yet'); },
  });
  if (!seeded.confirmed) {
    console.error('Refusing to dispatch: the task still grades as PASS after reset.');
    return 1;
  }
  console.log('   broken state confirmed live');

  const runId = await registerRun(options.workerUrl, task.id);
  console.log(`2. run recorded${runId === null ? ' (worker unreachable - not recorded)' : `: ${runId}`}`);

  console.log('3. handing the ticket to browser-use (a Chrome window will open)\n');
  const result = await spawnRunner(python, task, ctx, options);

  console.log(`\n   agent finished: ${result.ok ? 'ran to completion' : `error - ${result.error ?? 'unknown'}`}`);
  if (result.steps !== undefined) {
    console.log(`   steps: ${String(result.steps)}  |  seconds: ${String(result.seconds ?? 0)}`);
  }
  if (result.agent_self_report !== undefined && result.agent_self_report !== '') {
    console.log(`   agent's own account: ${result.agent_self_report.slice(0, 300)}`);
  }

  // Graded regardless of what the agent claims. Its self-report is a trace
  // artefact, not a verdict.
  console.log('\n4. grading the zone');
  const grade = await gradeUntilSettled(task, ctx, { settleMs: 30_000 });
  printGrade(grade);

  if (runId !== null) await recordGrade(options.workerUrl, task.id, runId);

  return grade.pass ? 0 : 1;
}

function spawnRunner(
  python: string,
  task: Task,
  ctx: TaskContext,
  options: { maxSteps: number; model?: string },
): Promise<BrowserUseResult> {
  return new Promise((resolvePromise) => {
    const args = [
      resolve(agentDir, 'runner.py'),
      '--task-id', task.id,
      '--max-steps', String(options.maxSteps),
    ];
    if (options.model !== undefined) args.push('--model', options.model);

    const child = spawn(python, args, {
      cwd: agentDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'inherit'], // stderr streams through so progress is visible
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.write(renderPrompt(task, ctx.config));
    child.stdin.end();

    child.on('close', () => {
      const line = stdout.trim().split('\n').pop() ?? '';
      try {
        resolvePromise(JSON.parse(line) as BrowserUseResult);
      } catch {
        resolvePromise({ ok: false, error: `Could not parse runner output: ${line.slice(0, 200)}` });
      }
    });
  });
}

async function registerRun(workerUrl: string, taskId: string): Promise<string | null> {
  try {
    const response = await fetch(`${workerUrl}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actor: 'agent', agentKind: 'browser-use' }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    return ((await response.json()) as { runId: string }).runId;
  } catch {
    return null;
  }
}

async function recordGrade(workerUrl: string, taskId: string, runId: string): Promise<void> {
  try {
    await fetch(`${workerUrl}/api/tasks/${taskId}/grade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    console.log('   (worker unreachable - grade not recorded in the dashboard)');
  }
}

function printGrade(result: GradeResult): void {
  for (const check of result.checks) {
    console.log(`  [${check.pass ? 'PASS' : 'FAIL'}] ${check.name}  (${check.kind})`);
    console.log(`         ${check.detail}`);
  }
  const passed = result.checks.filter((c) => c.pass).length;
  console.log(`\n  => ${result.pass ? 'PASS' : 'FAIL'} (${String(passed)}/${String(result.checks.length)})`);
}
