import type { BenchConfig, CfApi, ProbeResult, TaskContext } from '@cf-bench/tasks';
import type { HttpProbe } from '@cf-bench/tasks';

export const testConfig: BenchConfig = {
  accountId: 'acct_test',
  zoneId: 'zone_test',
  zoneName: 'example.test',
  teamDomain: 'team.cloudflareaccess.com',
  allowedEmailDomain: 'example.edu',
  originAIp: '203.0.113.10',
  originBAddr: null,
};

export function fakeCf(settings: Record<string, unknown> = {}): CfApi {
  const store = { ...settings };
  return {
    getZoneSetting: (_zone, name) => Promise.resolve((store[name] ?? null) as never),
    setZoneSetting: (_zone, name, value) => { store[name] = value; return Promise.resolve(); },
    listDnsRecords: () => Promise.resolve([]),
    createDnsRecord: () => Promise.reject(new Error('not used')),
    updateDnsRecord: () => Promise.reject(new Error('not used')),
    deleteDnsRecord: () => Promise.resolve(),
    getEntrypointRuleset: () => Promise.resolve(null),
    putEntrypointRuleset: () => Promise.reject(new Error('not used')),
  };
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

/** Routes by URL prefix so a test can describe http:// and https:// separately. */
export function fakeProbe(routes: Record<string, ProbeResult>): HttpProbe {
  return {
    get: (url) => {
      const match = Object.keys(routes).find((k) => url.startsWith(k));
      if (match === undefined) throw new Error(`fakeProbe has no route for ${url}`);
      return Promise.resolve(routes[match] as ProbeResult);
    },
  };
}

export function ctx(cf: CfApi, http: HttpProbe): TaskContext {
  return { cf, config: testConfig, http };
}

export function check(result: { checks: { name: string; pass: boolean }[] }, name: string): boolean {
  const found = result.checks.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no check named ${name}`);
  return found.pass;
}
