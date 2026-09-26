import type { AccessApp, AccessPolicy, RulesetRule } from '@cf-bench/cf';
import type { BenchConfig, CfApi, ProbeResult, TaskContext } from '@cf-bench/tasks';
import type { HttpProbe } from '@cf-bench/tasks';

export const testConfig: BenchConfig = {
  accountId: 'acct_test',
  zoneId: 'zone_test',
  zoneName: 'example.test',
  teamDomain: 'team.cloudflareaccess.com',
  allowedEmailDomain: 'example.edu',
  originAIp: '203.0.113.10',
  adminAllowedIp: '198.51.100.7',
};

export interface FakeAccess {
  apps?: AccessApp[];
  policies?: Record<string, AccessPolicy[]>;
}

export function fakeCf(
  settings: Record<string, unknown> = {},
  rulesets: Record<string, RulesetRule[]> = {},
  access: FakeAccess = {},
): CfApi {
  const store = { ...settings };
  const phases: Record<string, RulesetRule[]> = { ...rulesets };
  let apps: AccessApp[] = [...(access.apps ?? [])];
  const policies: Record<string, AccessPolicy[]> = { ...(access.policies ?? {}) };
  return {
    getZoneSetting: (_zone, name) => Promise.resolve((store[name] ?? null) as never),
    setZoneSetting: (_zone, name, value) => { store[name] = value; return Promise.resolve(); },
    listDnsRecords: () => Promise.resolve([]),
    createDnsRecord: () => Promise.reject(new Error('not used')),
    updateDnsRecord: () => Promise.reject(new Error('not used')),
    deleteDnsRecord: () => Promise.resolve(),
    getEntrypointRuleset: (_zone, phase) =>
      Promise.resolve(
        phases[phase] === undefined
          ? null
          : { id: 'rs_test', name: phase, kind: 'zone', phase, rules: phases[phase] },
      ),
    putEntrypointRuleset: (_zone, phase, rules) => {
      phases[phase] = rules;
      return Promise.resolve({ id: 'rs_test', name: phase, kind: 'zone', phase, rules });
    },
    listAccessApps: () => Promise.resolve(apps),
    createAccessApp: (_account, app) => {
      const created: AccessApp = { id: `app_${String(apps.length + 1)}`, ...app };
      apps.push(created);
      return Promise.resolve(created);
    },
    deleteAccessApp: (_account, appId) => {
      apps = apps.filter((a) => a.id !== appId);
      return Promise.resolve();
    },
    listAccessPolicies: (_account, appId) => Promise.resolve(policies[appId] ?? []),
    createAccessPolicy: (_account, appId, policy) => {
      const created: AccessPolicy = { id: `pol_${appId}`, ...policy };
      policies[appId] = [...(policies[appId] ?? []), created];
      return Promise.resolve(created);
    },
  };
}

/** Read back the Access apps a seed/reset left behind. */
export function appsOf(cf: CfApi): Promise<AccessApp[]> {
  return cf.listAccessApps('acct_test');
}

/** Read back what a seed/reset wrote, for idempotency assertions. */
export async function rulesOf(cf: CfApi, phase: string): Promise<RulesetRule[]> {
  return (await cf.getEntrypointRuleset('z', phase))?.rules ?? [];
}

export function probeResult(partial: Partial<ProbeResult> & { url: string }): ProbeResult {
  return {
    finalUrl: partial.url,
    status: 200,
    headers: {},
    body: '',
    chain: [],
    redirects: 0,
    loop: false,
    ...partial,
  };
}

/**
 * Routes by longest-matching URL prefix. A route may be a single result or a
 * queue of them, so a test can say "first call stale, second call fresh".
 * Once a queue runs dry the last entry repeats.
 */
export function fakeProbe(routes: Record<string, ProbeResult | ProbeResult[]>): HttpProbe {
  const queues: Record<string, ProbeResult[]> = {};
  for (const [key, value] of Object.entries(routes)) {
    queues[key] = Array.isArray(value) ? [...value] : [value];
  }
  return {
    get: (url) => {
      const match = Object.keys(queues)
        .filter((k) => url.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      if (match === undefined) throw new Error(`fakeProbe has no route for ${url}`);
      const queue = queues[match] as ProbeResult[];
      const next = queue.length > 1 ? (queue.shift() as ProbeResult) : (queue[0] as ProbeResult);
      return Promise.resolve(next);
    },
  };
}

export function ctx(cf: CfApi, http: HttpProbe): TaskContext {
  return { cf, config: testConfig, http, sleep: () => Promise.resolve() };
}

export function check(result: { checks: { name: string; pass: boolean }[] }, name: string): boolean {
  const found = result.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found.pass;
}
