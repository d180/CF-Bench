import type {
  AccessApp,
  AccessAppInput,
  AccessPolicy,
  AccessPolicyInput,
  DnsRecord,
  DnsRecordInput,
  Ruleset,
  RulesetRule,
  SettingValue,
} from '@cf-bench/cf';
import type { HttpProbe } from './http.ts';

/**
 * The slice of the Cloudflare client that tasks are allowed to touch.
 *
 * Declared structurally rather than importing the concrete class so graders can
 * be unit-tested against a small hand-written fake. `CloudflareClient`
 * satisfies this without knowing the interface exists.
 */
export interface CfApi {
  getZoneSetting(zoneId: string, setting: string): Promise<SettingValue>;
  setZoneSetting(zoneId: string, setting: string, value: SettingValue): Promise<void>;
  listDnsRecords(zoneId: string, query?: { name?: string; type?: string }): Promise<DnsRecord[]>;
  createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecord>;
  updateDnsRecord(zoneId: string, recordId: string, record: DnsRecordInput): Promise<DnsRecord>;
  deleteDnsRecord(zoneId: string, recordId: string): Promise<void>;
  getEntrypointRuleset(zoneId: string, phase: string): Promise<Ruleset | null>;
  putEntrypointRuleset(zoneId: string, phase: string, rules: RulesetRule[]): Promise<Ruleset>;
  listAccessApps(accountId: string): Promise<AccessApp[]>;
  createAccessApp(accountId: string, app: AccessAppInput): Promise<AccessApp>;
  deleteAccessApp(accountId: string, appId: string): Promise<void>;
  listAccessPolicies(accountId: string, appId: string): Promise<AccessPolicy[]>;
  createAccessPolicy(accountId: string, appId: string, policy: AccessPolicyInput): Promise<AccessPolicy>;
}

export interface BenchConfig {
  accountId: string;
  zoneId: string;
  zoneName: string;
  teamDomain: string;
  allowedEmailDomain: string;
  originAIp: string;
  adminAllowedIp: string;
}

export type CheckKind = 'config' | 'http';

export interface Check {
  name: string;
  pass: boolean;
  /** Human-readable evidence. Always states what was observed, not just pass/fail. */
  detail: string;
  kind: CheckKind;
}

export interface GradeResult {
  pass: boolean;
  checks: Check[];
}

export interface TaskContext {
  cf: CfApi;
  config: BenchConfig;
  http: HttpProbe;
  /**
   * Injectable delay. Some graders must let real time pass - cache freshness
   * cannot be observed in zero seconds - and tests should not pay for it.
   */
  sleep?: (ms: number) => Promise<void>;
}

export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Task {
  id: string;
  title: string;
  difficulty: Difficulty;
  /**
   * Written as a support ticket: symptom and goal only, never the solution.
   *
   * May contain `{{ZONE}}` and `{{ADMIN_ALLOWED_IP}}` placeholders so no real
   * hostname or address is baked into the repo. Render with `renderPrompt`
   * before handing the text to a human or an agent.
   */
  prompt: string;

  /** Put the zone into this task's starting state. */
  seed(ctx: TaskContext): Promise<void>;

  /** Restore that exact starting state. Must be idempotent. */
  reset(ctx: TaskContext): Promise<void>;

  /**
   * Verify the END STATE only, via config reads and live HTTP. Must not care
   * how the fix was reached, and must accept any valid solution.
   */
  grade(ctx: TaskContext): Promise<GradeResult>;

  /**
   * One known-good solution, applied via the API.
   *
   * Used ONLY by the integration test to prove the grader can actually be
   * satisfied. Never consulted during grading - a grader that compared against
   * this would be checking the method, not the outcome.
   */
  applyKnownFix(ctx: TaskContext): Promise<void>;
}

export function summarize(result: GradeResult): string {
  const passed = result.checks.filter((c) => c.pass).length;
  return `${result.pass ? 'PASS' : 'FAIL'} (${String(passed)}/${String(result.checks.length)} checks)`;
}

/** Substitute deployment-specific values into a task's ticket text. */
export function renderPrompt(task: Task, config: BenchConfig): string {
  return task.prompt
    .replaceAll('{{ZONE}}', config.zoneName)
    .replaceAll('{{ADMIN_ALLOWED_IP}}', config.adminAllowedIp)
    .replaceAll('{{EMAIL_DOMAIN}}', config.allowedEmailDomain);
}
