import { describe, expect, it } from 'vitest';
import { cacheStaleApi } from '@cf-bench/tasks';
import { check, ctx, fakeCf, fakeProbe, probeResult, rulesOf } from './helpers.ts';

const BASE = 'https://www.example.test';
const API = `${BASE}/api/time`;
const PHASE = 'http_request_cache_settings';

const home = probeResult({ url: `${BASE}/`, status: 200, headers: { 'x-cfbench-site': 'main' } });

const apiHit = (body: string, cacheStatus: string) =>
  probeResult({ url: API, status: 200, body, headers: { 'cf-cache-status': cacheStatus } });

/** Fixed: each call returns a new payload and is not a cache hit. */
const fresh = {
  [API]: [apiHit('{"epoch":"1000.1"}', 'BYPASS'), apiHit('{"epoch":"1001.7"}', 'BYPASS')],
  [`${BASE}/`]: home,
};

/** Seeded: the same stored copy comes back every time. */
const stale = {
  [API]: [apiHit('{"epoch":"1000.1"}', 'HIT'), apiHit('{"epoch":"1000.1"}', 'HIT')],
  [`${BASE}/`]: home,
};

describe('05-cache-stale-api grade()', () => {
  it('passes when the API returns current data and is no longer cached', async () => {
    const result = await cacheStaleApi.grade(ctx(fakeCf(), fakeProbe(fresh)));
    expect(result.pass).toBe(true);
  });

  it('fails on the seeded state - identical payload served from cache', async () => {
    const result = await cacheStaleApi.grade(ctx(fakeCf(), fakeProbe(stale)));
    expect(result.pass).toBe(false);
    expect(check(result, 'api_returns_fresh_data')).toBe(false);
    expect(check(result, 'api_not_served_from_cache')).toBe(false);
  });

  it('accepts deleting the bad rule, not only adding a bypass rule', async () => {
    // The origin already sends no-store, so removing the override restores
    // correct behaviour. Requiring a bypass rule specifically would grade the
    // method and fail this perfectly valid fix.
    const noRulesAtAll = fakeCf({}, { [PHASE]: [] });
    const result = await cacheStaleApi.grade(ctx(noRulesAtAll, fakeProbe(fresh)));
    expect(result.pass).toBe(true);
  });

  it('fails when data is fresh but the site itself is broken', async () => {
    const brokenHome = {
      ...fresh,
      [`${BASE}/`]: probeResult({ url: `${BASE}/`, status: 521 }),
    };
    const result = await cacheStaleApi.grade(ctx(fakeCf(), fakeProbe(brokenHome)));
    expect(result.pass).toBe(false);
    expect(check(result, 'site_still_served')).toBe(false);
  });

  it('still fails when payloads differ but the edge reports a cache HIT', async () => {
    const odd = {
      [API]: [apiHit('{"epoch":"1000.1"}', 'HIT'), apiHit('{"epoch":"1002.9"}', 'HIT')],
      [`${BASE}/`]: home,
    };
    const result = await cacheStaleApi.grade(ctx(fakeCf(), fakeProbe(odd)));
    expect(result.pass).toBe(false);
    expect(check(result, 'api_returns_fresh_data')).toBe(true);
    expect(check(result, 'api_not_served_from_cache')).toBe(false);
  });
});

describe('05-cache-stale-api seed/reset', () => {
  it('reset is idempotent and re-installs the caching bug', async () => {
    const cf = fakeCf();
    const c = ctx(cf, fakeProbe(stale));
    await cacheStaleApi.reset(c);
    const first = await rulesOf(cf, PHASE);
    await cacheStaleApi.reset(c);
    const second = await rulesOf(cf, PHASE);

    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
    expect(first[0]?.action_parameters).toMatchObject({
      cache: true,
      edge_ttl: { mode: 'override_origin' },
    });
  });
});
