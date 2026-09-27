import { describe, expect, it } from 'vitest';
import { apiMigrationIncident } from '@cf-bench/tasks';
import type { DnsRecord, RulesetRule } from '@cf-bench/cf';
import { check, ctx, fakeCf, fakeProbe, probeResult, testConfig } from './helpers.ts';

const HOST = 'api.example.test';
const BASE = `https://${HOST}`;
const OFFICE = testConfig.adminAllowedIp;
const FIREWALL = 'http_request_firewall_custom';

/** The new deployment: correct marker, behind Cloudflare. */
const newDeployment = (extra: Record<string, string> = {}) =>
  probeResult({
    url: `${BASE}/`, status: 200,
    headers: { 'x-cfbench-origin': 'A', 'x-cfbench-release': '2026.09.27', 'cf-ray': 'r1', ...extra },
  });

/** The old one, still running and perfectly happy to return 200. */
const oldDeployment = probeResult({
  url: `${BASE}/`, status: 200,
  headers: { 'x-cfbench-origin': 'B', 'x-cfbench-release': '2026.08.02', 'cf-ray': 'r1' },
});

const apiTime = (epoch: string, cache = 'BYPASS') =>
  probeResult({
    url: `${BASE}/api/time`, status: 200, body: `{"epoch":"${epoch}"}`,
    headers: { 'cf-cache-status': cache, 'cf-ray': 'r1' },
  });

const routes = (over: Record<string, unknown> = {}) => ({
  [`${BASE}/api/time`]: [apiTime('1000.1'), apiTime('1001.9')],
  [`${BASE}/admin`]: probeResult({ url: `${BASE}/admin`, status: 403 }),
  [`${BASE}/`]: newDeployment(),
  ...over,
}) as Parameters<typeof fakeProbe>[0];

const record = (over: Partial<DnsRecord> = {}): DnsRecord => ({
  id: 'r1', type: 'A', name: HOST, content: '203.0.113.10', proxied: true, ttl: 1, ...over,
});

const blockRule: RulesetRule = {
  action: 'block',
  expression: `starts_with(http.request.uri.path, "/admin") and ip.src ne ${OFFICE}`,
};

function cfWith(records: DnsRecord[], settings: Record<string, unknown>, rules: RulesetRule[]) {
  const base = fakeCf(settings, { [FIREWALL]: rules });
  return {
    ...base,
    listDnsRecords: () => Promise.resolve(records),
  };
}

const healthy = () => cfWith([record()], { ssl: 'strict' }, [blockRule]);

describe('06-api-migration-incident grade()', () => {
  it('passes when all four faults are fixed', async () => {
    const result = await apiMigrationIncident.grade(ctx(healthy(), fakeProbe(routes())));
    expect(result.pass).toBe(true);
  });

  it('a 200 from the OLD deployment does not count as fixed', async () => {
    // The whole point of the ticket: the decommissioned box is still up and
    // answers 200. Anything grading on status alone would pass this.
    const cf = cfWith([record({ type: 'AAAA', content: '2001:db8::1' })], { ssl: 'strict' }, [blockRule]);
    const result = await apiMigrationIncident.grade(
      ctx(cf, fakeProbe(routes({ [`${BASE}/`]: oldDeployment }))),
    );
    expect(result.pass).toBe(false);
    expect(check(result, 'api_publicly_reachable')).toBe(true);
    expect(check(result, 'traffic_reaches_the_new_deployment')).toBe(false);
  });

  it('fails a half fix: right server, origin certificate still unverified', async () => {
    const cf = cfWith([record()], { ssl: 'full' }, [blockRule]);
    const result = await apiMigrationIncident.grade(ctx(cf, fakeProbe(routes())));
    expect(result.pass).toBe(false);
    expect(check(result, 'traffic_reaches_the_new_deployment')).toBe(true);
    expect(check(result, 'origin_certificate_verified')).toBe(false);
  });

  it('fails when proxying was turned off to make it reachable', async () => {
    // Explicitly forbidden by the ticket, and it exposes the origin.
    const cf = cfWith([record({ proxied: false })], { ssl: 'strict' }, [blockRule]);
    const direct = newDeployment();
    delete direct.headers['cf-ray'];
    const result = await apiMigrationIncident.grade(
      ctx(cf, fakeProbe(routes({ [`${BASE}/`]: direct }))),
    );
    expect(result.pass).toBe(false);
    expect(check(result, 'served_through_cloudflare')).toBe(false);
    expect(check(result, 'dns_record_is_proxied')).toBe(false);
  });

  it('fails a blanket /admin block that locks the office out', async () => {
    const cf = cfWith([record()], { ssl: 'strict' }, [
      { action: 'block', expression: 'starts_with(http.request.uri.path, "/admin")' },
    ]);
    const result = await apiMigrationIncident.grade(ctx(cf, fakeProbe(routes())));
    expect(result.pass).toBe(false);
    expect(check(result, 'admin_blocked_from_public_internet')).toBe(true);
    expect(check(result, 'office_address_still_allowed')).toBe(false);
  });

  it('fails an over-broad rule that takes the API down with /admin', async () => {
    const cf = cfWith([record()], { ssl: 'strict' }, [
      { action: 'block', expression: `ip.src ne ${OFFICE}` },
    ]);
    const result = await apiMigrationIncident.grade(
      ctx(cf, fakeProbe(routes({ [`${BASE}/`]: probeResult({ url: `${BASE}/`, status: 403 }) }))),
    );
    expect(result.pass).toBe(false);
    expect(check(result, 'api_publicly_reachable')).toBe(false);
  });

  it('fails while /api is still served from cache', async () => {
    const stale = {
      [`${BASE}/api/time`]: [apiTime('1000.1', 'HIT'), apiTime('1000.1', 'HIT')],
    };
    const result = await apiMigrationIncident.grade(ctx(healthy(), fakeProbe(routes(stale))));
    expect(result.pass).toBe(false);
    expect(check(result, 'api_responses_not_stale')).toBe(false);
    expect(check(result, 'api_not_served_from_cache')).toBe(false);
  });

  it('fails while /admin is still public', async () => {
    const open = { [`${BASE}/admin`]: probeResult({ url: `${BASE}/admin`, status: 200 }) };
    const result = await apiMigrationIncident.grade(ctx(healthy(), fakeProbe(routes(open))));
    expect(result.pass).toBe(false);
    expect(check(result, 'admin_blocked_from_public_internet')).toBe(false);
  });
});

describe('06-api-migration-incident seed', () => {
  it('refuses to seed without an old deployment to point at', async () => {
    const noOrigin = { ...ctx(fakeCf(), fakeProbe(routes())), config: { ...testConfig, originBAddr: null } };
    await expect(apiMigrationIncident.seed(noOrigin)).rejects.toThrow(/ORIGIN_B_ADDR/);
  });
});
