import { getTask, gradeUntilSettled, tasks } from '@cf-bench/tasks';
import type { GradeResult, Task, TaskContext } from '@cf-bench/tasks';
import { loadContext } from './config.ts';

const USAGE = `cf-bench

  npm run cf-bench -- list
  npm run cf-bench -- show   <task-id>
  npm run cf-bench -- seed   <task-id>
  npm run cf-bench -- reset  <task-id>
  npm run cf-bench -- grade  <task-id>
  npm run cf-bench -- fix    <task-id>    (apply the known-good solution)
  npm run cf-bench -- verify <task-id>    (full integration loop)
`;

function printGrade(result: GradeResult): void {
  for (const check of result.checks) {
    const mark = check.pass ? 'PASS' : 'FAIL';
    console.log(`  [${mark}] ${check.name}  (${check.kind})`);
    console.log(`         ${check.detail}`);
  }
  const passed = result.checks.filter((c) => c.pass).length;
  console.log(`\n  => ${result.pass ? 'PASS' : 'FAIL'} (${String(passed)}/${String(result.checks.length)})`);
}

/**
 * Fingerprint the CONFIG checks only, as (name, pass) pairs.
 *
 * Idempotency is a claim about the configuration reset converges to, not about
 * edge propagation timing. HTTP checks lag a config write by seconds, so
 * including them would compare how fast Cloudflare propagated rather than
 * whether the two resets agreed. Free-text details are excluded so wording
 * cannot trip the comparison.
 */
function configShape(result: GradeResult): string {
  return JSON.stringify(
    result.checks.filter((c) => c.kind === 'config').map((c) => [c.name, c.pass]),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Wait for the seeded breakage to be observable at the edge, not just written. */
async function gradeUntilBroken(task: Task, ctx: TaskContext, budgetMs = 30_000): Promise<GradeResult> {
  const deadline = Date.now() + budgetMs;
  let result = await task.grade(ctx);
  while (result.pass && Date.now() < deadline) {
    await sleep(5_000);
    result = await task.grade(ctx);
  }
  return result;
}

async function verify(task: Task, ctx: TaskContext): Promise<number> {
  let failures = 0;
  const step = (ok: boolean, label: string): void => {
    if (!ok) failures += 1;
    console.log(`${ok ? '  OK  ' : ' FAIL '} ${label}`);
  };

  console.log(`\n=== verify ${task.id} ===\n`);

  console.log('1. seed');
  await task.seed(ctx);

  console.log('2. grade (expect FAIL)');
  const seeded = await task.grade(ctx);
  printGrade(seeded);
  step(!seeded.pass, 'seeded state grades as FAIL');

  console.log('\n3. apply known-good fix');
  await task.applyKnownFix(ctx);

  console.log('4. grade (expect PASS, settling)');
  const fixed = await gradeUntilSettled(task, ctx, {
    settleMs: 45_000,
    onRetry: (attempt) => { console.log(`   ...not settled yet (attempt ${String(attempt)}), retrying`); },
  });
  printGrade(fixed);
  step(fixed.pass, 'fixed state grades as PASS');

  console.log('\n5. reset, then reset again (idempotency)');
  await task.reset(ctx);
  const afterFirst = await task.grade(ctx);
  await task.reset(ctx);
  const afterSecond = await task.grade(ctx);
  step(
    configShape(afterFirst) === configShape(afterSecond),
    'reset is idempotent - two resets converge to identical configuration',
  );

  console.log('6. confirm the broken starting state is live again');
  const restored = await gradeUntilBroken(task, ctx);
  printGrade(restored);
  step(!restored.pass, 'reset restored the broken starting state');

  console.log(`\n=== ${failures === 0 ? 'VERIFY PASSED' : `VERIFY FAILED (${String(failures)} problem(s))`} ===\n`);
  return failures === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  const [command, taskId] = process.argv.slice(2);

  if (command === undefined || command === 'help' || command === '--help') {
    console.log(USAGE);
    return 0;
  }

  if (command === 'list') {
    for (const t of tasks) console.log(`${t.id}  [${t.difficulty}]  ${t.title}`);
    return 0;
  }

  if (taskId === undefined) {
    console.error(`"${command}" needs a task id.\n`);
    console.log(USAGE);
    return 1;
  }

  const task = getTask(taskId);

  if (command === 'show') {
    console.log(`${task.id}  [${task.difficulty}]\n${task.title}\n`);
    console.log(task.prompt);
    return 0;
  }

  const ctx = loadContext();

  switch (command) {
    case 'seed':
      await task.seed(ctx);
      console.log(`seeded ${task.id}`);
      return 0;
    case 'reset':
      await task.reset(ctx);
      console.log(`reset ${task.id}`);
      return 0;
    case 'fix':
      await task.applyKnownFix(ctx);
      console.log(`applied known fix for ${task.id}`);
      return 0;
    case 'grade': {
      printGrade(await task.grade(ctx));
      return 0;
    }
    case 'verify':
      return await verify(task, ctx);
    default:
      console.error(`Unknown command "${command}"\n`);
      console.log(USAGE);
      return 1;
  }
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
