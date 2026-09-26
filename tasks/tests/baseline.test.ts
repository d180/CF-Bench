import { describe, expect, it } from 'vitest';
import { cacheStaleApi, sslRedirectLoop, wafAdminLockdown } from '@cf-bench/tasks';
import { ctx, fakeCf, fakeProbe, probeResult, rulesOf } from './helpers.ts';

const anyProbe = fakeProbe({ 'http': probeResult({ url: 'http://x', status: 200 }) });
const FIREWALL = 'http_request_firewall_custom';
const CACHE = 'http_request_cache_settings';

describe('cross-task isolation', () => {
  it('seeding one task heals damage left by another', async () => {
    // The zone is shared. Seeding task 3 while task 1 sits broken must not
    // leave the site looping, or task 3 would fail on something that is not
    // task 3's fault and results would depend on execution order.
    const cf = fakeCf({}, {});
    const c = ctx(cf, anyProbe);

    await sslRedirectLoop.seed(c);
    expect(await cf.getZoneSetting('z', 'ssl')).toBe('flexible');

    await wafAdminLockdown.seed(c);
    expect(await cf.getZoneSetting('z', 'ssl')).toBe('strict');
  });

  it('seeding a task clears another task’s rules', async () => {
    const cf = fakeCf({}, {});
    const c = ctx(cf, anyProbe);

    await cacheStaleApi.seed(c);
    expect(await rulesOf(cf, CACHE)).toHaveLength(1);

    await sslRedirectLoop.seed(c);
    expect(await rulesOf(cf, CACHE)).toEqual([]);
    expect(await rulesOf(cf, FIREWALL)).toEqual([]);
  });

  it('every task seeds from the same healthy baseline', async () => {
    // Whatever wreckage is present beforehand, seeding lands on one state.
    const messy = () =>
      fakeCf(
        { ssl: 'off', ssl_automatic_mode: 'auto' },
        { [FIREWALL]: [{ action: 'block', expression: 'leftover' }], [CACHE]: [{ action: 'set_cache_settings', expression: 'leftover' }] },
      );

    for (const task of [sslRedirectLoop, wafAdminLockdown, cacheStaleApi]) {
      const cf = messy();
      await task.seed(ctx(cf, anyProbe));
      expect(await cf.getZoneSetting('z', 'ssl_automatic_mode'), task.id).toBe('custom');
      expect(await rulesOf(cf, FIREWALL), task.id).toEqual([]);
    }
  });
});
