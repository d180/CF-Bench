import { describe, expect, it } from 'vitest';
import { dnsApiMigration } from '@cf-bench/tasks';
import type { DnsRecord } from '@cf-bench/cf';
import { check, ctx, fakeCf, fakeProbe, probeResult } from './helpers.ts';

const API = 'https://api.example.test/';
const DEAD = '192.0.2.1';
const LIVE = '203.0.113.10'; // matches testConfig.originAIp

const working = {
  [API]: probeResult({
    url: API, status: 200,
    headers: { 'x-cfbench-origin': 'A', 'cf-ray': 'abc123-LAX' },
  }),
};

/** Seeded: the hostname resolves to a decommissioned box and never answers. */
const unreachable = {
  [API]: probeResult({ url: API, status: 0, error: 'timeout' }),
};

/** Answers, but Cloudflare is not in the path - no cf-ray. */
const direct = {
  [API]: probeResult({ url: API, status: 200, headers: { 'x-cfbench-origin': 'A' } }),
};

const record = (overrides: Partial<DnsRecord> = {}): DnsRecord => ({
  id: 'rec_1', type: 'A', name: 'api.example.test', content: LIVE, proxied: true, ttl: 1, ...overrides,
});

function cfWith(records: DnsRecord[]) {
  const store = [...records];
  const base = fakeCf();
  return {
    ...base,
    listDnsRecords: (_z: string, q: { name?: string } = {}) =>
      Promise.resolve(q.name === undefined ? store : store.filter((r) => r.name === q.name)),
    createDnsRecord: (_z: string, r: Partial<DnsRecord>) => {
      const created = { ...record(), id: `rec_${String(store.length + 1)}`, ...r } as DnsRecord;
      store.push(created);
      return Promise.resolve(created);
    },
    updateDnsRecord: (_z: string, id: string, r: Partial<DnsRecord>) => {
      const i = store.findIndex((x) => x.id === id);
      store[i] = { ...(store[i] as DnsRecord), ...r } as DnsRecord;
      return Promise.resolve(store[i] as DnsRecord);
    },
    deleteDnsRecord: (_z: string, id: string) => {
      const i = store.findIndex((x) => x.id === id);
      if (i >= 0) store.splice(i, 1);
      return Promise.resolve();
    },
    _store: store,
  };
}

describe('04-dns-api-migration grade()', () => {
  it('passes when the API answers through Cloudflare from the live server', async () => {
    const result = await dnsApiMigration.grade(ctx(cfWith([record()]), fakeProbe(working)));
    expect(result.pass).toBe(true);
  });

  it('fails on the seeded state - dead address, unproxied', async () => {
    const cf = cfWith([record({ content: DEAD, proxied: false, ttl: 60 })]);
    const result = await dnsApiMigration.grade(ctx(cf, fakeProbe(unreachable)));
    expect(result.pass).toBe(false);
    expect(check(result, 'api_answers_again')).toBe(false);
    expect(check(result, 'dns_record_is_proxied')).toBe(false);
    expect(check(result, 'no_longer_points_at_decommissioned_host')).toBe(false);
  });

  it('fails a half fix: right address, still bypassing Cloudflare', async () => {
    // Fixing only the address gets the API answering while exposing the origin
    // and losing every Cloudflare feature in front of it. The ticket asks for
    // both, so this must not pass.
    const cf = cfWith([record({ proxied: false, ttl: 60 })]);
    const result = await dnsApiMigration.grade(ctx(cf, fakeProbe(direct)));
    expect(result.pass).toBe(false);
    expect(check(result, 'api_answers_again')).toBe(true);
    expect(check(result, 'traffic_goes_through_cloudflare')).toBe(false);
    expect(check(result, 'dns_record_is_proxied')).toBe(false);
  });

  it('accepts a CNAME as readily as an A record', async () => {
    // Pointing the hostname at the web server by name is just as valid as by
    // address; the grader cares that it resolves, answers and is proxied.
    const cf = cfWith([record({ type: 'CNAME', content: 'www.example.test' })]);
    const result = await dnsApiMigration.grade(ctx(cf, fakeProbe(working)));
    expect(result.pass).toBe(true);
  });

  it('fails when the record is gone entirely', async () => {
    const result = await dnsApiMigration.grade(ctx(cfWith([]), fakeProbe(unreachable)));
    expect(result.pass).toBe(false);
    expect(check(result, 'dns_record_is_proxied')).toBe(false);
  });

  it('fails when something else answers on the hostname', async () => {
    const wrongOrigin = {
      [API]: probeResult({ url: API, status: 200, headers: { 'cf-ray': 'x', 'x-cfbench-site': 'main' } }),
    };
    const result = await dnsApiMigration.grade(ctx(cfWith([record()]), fakeProbe(wrongOrigin)));
    expect(result.pass).toBe(false);
    expect(check(result, 'served_by_the_live_api')).toBe(false);
  });
});

describe('04-dns-api-migration seed/reset', () => {
  it('collapses duplicate records so the hostname cannot round-robin', async () => {
    // An attempt that added a second record would otherwise leave the
    // hostname alternating between a working and a dead address.
    const cf = cfWith([record({ id: 'a' }), record({ id: 'b', content: '198.51.100.9' })]);
    await dnsApiMigration.reset(ctx(cf, fakeProbe(unreachable)));
    const after = await cf.listDnsRecords('z', { name: 'api.example.test' });
    expect(after).toHaveLength(1);
    expect(after[0]?.content).toBe(DEAD);
    expect(after[0]?.proxied).toBe(false);
  });

  it('reset is idempotent', async () => {
    const cf = cfWith([record()]);
    const c = ctx(cf, fakeProbe(unreachable));
    await dnsApiMigration.reset(c);
    const first = await cf.listDnsRecords('z', { name: 'api.example.test' });
    await dnsApiMigration.reset(c);
    const second = await cf.listDnsRecords('z', { name: 'api.example.test' });
    expect(first.map((r) => [r.type, r.content, r.proxied])).toEqual(
      second.map((r) => [r.type, r.content, r.proxied]),
    );
  });
});
