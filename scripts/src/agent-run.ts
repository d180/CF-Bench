import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gradeUntilSettled, renderBriefedPrompt, seedAndConfirm } from '@cf-bench/tasks';
import type { GradeResult, Task, TaskContext } from '@cf-bench/tasks';
import { loadEnv } from './config.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const agentDir = resolve(repoRoot, 'agents/browser-use');

export interface BrowserUseResult {
  ok: boolean;
  steps?: number;
  seconds?: number;
  model?: string;
  agent_claims_success?: boolean | null;
  agent_self_report?: string;
  errors?: string[];
  urls_visited?: string[];
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

  const env = loadEnv();
  if ((env['OPENROUTER_API_KEY'] ?? '') === '') {
    console.error('OPENROUTER_API_KEY is empty in .env - the agent has no model to call.');
    return 1;
  }

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
  const result = await spawnRunner(python, task, ctx, { ...options, env });

  console.log(`\n   agent finished: ${result.ok ? 'ran to completion' : `error - ${result.error ?? 'unknown'}`}`);
  if (result.steps !== undefined) {
    console.log(`   steps: ${String(result.steps)}  |  seconds: ${String(result.seconds ?? 0)}`);
  }
  if (result.agent_claims_success !== undefined && result.agent_claims_success !== null) {
    console.log(`   agent claims success: ${String(result.agent_claims_success)} (not the verdict - the zone is)`);
  }
  if (result.agent_self_report !== undefined && result.agent_self_report !== '') {
    console.log(`   agent's own account: ${result.agent_self_report.slice(0, 300)}`);
  }
  if (result.errors !== undefined && result.errors.length > 0) {
    console.log(`   agent errors: ${result.errors.slice(0, 3).join(' | ')}`);
  }

  // An attempt that never reached the browser is not a failed attempt, it is a
  // void one, and the distinction matters when comparing agents.
  //
  // Recovered errors are NOT the signal. Agents hit stale element indexes and
  // transient click failures constantly and carry on; an earlier version of
  // this check voided any run with a single error and mislabelled a clean 9/9
  // as invalid. A run is void only when the runner itself failed, or when the
  // agent never completed a step, or when every step it took errored.
  const errorCount = (result.errors ?? []).length;
  const steps = result.steps ?? 0;
  const voided = !result.ok || steps === 0 || (errorCount > 0 && errorCount >= steps);
  if (voided) {
    console.log(
      '\n   NOTE: this run is not a valid attempt - the agent never completed a step.\n' +
      '         The verdict below still reflects the real state of the zone.',
    );
  } else if (errorCount > 0) {
    console.log(`   (recovered from ${String(errorCount)} transient error(s) during the run)`);
  }

  console.log('\n4. grading the zone');
  const grade = await gradeUntilSettled(task, ctx, { settleMs: 30_000 });
  printGrade(grade);

  if (runId !== null) {
    await recordGrade(options.workerUrl, task.id, runId, {
      model: result.model ?? options.model ?? env['BROWSER_USE_MODEL'],
      steps: result.steps,
      durationSeconds: result.seconds,
    });
  }

  return grade.pass ? 0 : 1;
}

function spawnRunner(
  python: string,
  task: Task,
  ctx: TaskContext,
  options: { maxSteps: number; model?: string; env: Record<string, string> },
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
      // .env is never written into process.env, so the child is handed the
      // variables it needs explicitly.
      env: {
        ...process.env,
        OPENROUTER_API_KEY: options.env['OPENROUTER_API_KEY'] ?? '',
        BROWSER_USE_MODEL: options.env['BROWSER_USE_MODEL'] ?? 'openai/gpt-5.1',
        BROWSER_USE_MAX_TOKENS: options.env['BROWSER_USE_MAX_TOKENS'] ?? '16000',
      },
      stdio: ['pipe', 'pipe', 'inherit'], // stderr streams through so progress is visible
    });

    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stdin.write(renderBriefedPrompt(task, ctx.config));
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

async function recordGrade(
  workerUrl: string,
  taskId: string,
  runId: string,
  meta: { model?: string; steps?: number; durationSeconds?: number },
): Promise<void> {
  try {
    await fetch(`${workerUrl}/api/tasks/${taskId}/grade`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, ...meta }),
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
