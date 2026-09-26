import { describe, expect, it } from 'vitest';
import { wafAdminLockdown } from '@cf-bench/tasks';
import { check, ctx, fakeCf, fakeProbe, probeResult, rulesOf, testConfig } from './helpers.ts';

const BASE = 'https://www.example.test';
const ALLOWED = testConfig.adminAllowedIp;
const PHASE = 'http_request_firewall_custom';

const origin = (url: string) =>
  probeResult({ url, status: 200, headers: { 'x-cfbench-site': 'main' } });
const blocked = (url: string) => probeResult({ url, status: 403 });

/** Every path behaving as a correct lockdown should. */
const lockedDown = {
  [`${BASE}/admin/settings`]: blocked(`${BASE}/admin/settings`),
  [`${BASE}/admin`]: blocked(`${BASE}/admin`),
  [`${BASE}/api/time`]: probeResult({ url: `${BASE}/api/time`, status: 200 }),
  [`${BASE}/`]: origin(`${BASE}/`),
};

/** The seeded state: nothing is blocked. */
const wideOpen = {
  [`${BASE}/admin/settings`]: origin(`${BASE}/admin/settings`),
  [`${BASE}/admin`]: origin(`${BASE}/admin`),
  [`${BASE}/api/time`]: probeResult({ url: `${BASE}/api/time`, status: 200 }),
  [`${BASE}/`]: origin(`${BASE}/`),
};

const ruleAllowing = (expression: string) => ({
  [PHASE]: [{ action: 'block', expression, description: 'x' }],
});

describe('03-waf-admin-lockdown grade()', () => {
  it('passes when the area is refused and the jump host is carved out', async () => {
    const cf = fakeCf({}, ruleAllowing(`http.request.uri.path contains "/admin" and ip.src ne ${ALLOWED}`));
    const result = await wafAdminLockdown.grade(ctx(cf, fakeProbe(lockedDown)));
    expect(result.pass).toBe(true);
  });

  it('fails on the seeded wide-open state', async () => {
    const result = await wafAdminLockdown.grade(ctx(fakeCf({}, { [PHASE]: [] }), fakeProbe(wideOpen)));
    expect(result.pass).toBe(false);
    expect(check(result, 'admin_blocked_for_unlisted_ip')).toBe(false);
    expect(check(result, 'jump_host_exception_configured')).toBe(false);
  });

  it('accepts any expression that produces the right behaviour', async () => {
    // Free plan has no regex, and these are all legitimate ways to write it.
    // The grader must not care which one an operator chose.
    const forms = [
      `(http.request.uri.path eq "/admin" or starts_with(http.request.uri.path, "/admin/")) and ip.src ne ${ALLOWED}`,
      `not (ip.src eq ${ALLOWED}) and http.request.uri.path wildcard "/admin*"`,
      `ip.src ne ${ALLOWED} and starts_with(http.request.uri.path, "/admin")`,
    ];
    for (const expression of forms) {
      const result = await wafAdminLockdown.grade(
        ctx(fakeCf({}, ruleAllowing(expression)), fakeProbe(lockedDown)),
      );
      expect(result.pass, expression).toBe(true);
    }
  });

  it('fails when only the exact path is blocked and the area stays reachable', async () => {
    const partial = { ...lockedDown, [`${BASE}/admin/settings`]: origin(`${BASE}/admin/settings`) };
    const cf = fakeCf({}, ruleAllowing(`http.request.uri.path eq "/admin" and ip.src ne ${ALLOWED}`));
    const result = await wafAdminLockdown.grade(ctx(cf, fakeProbe(partial)));
    expect(result.pass).toBe(false);
    expect(check(result, 'admin_blocked_for_unlisted_ip')).toBe(true);
    expect(check(result, 'whole_admin_area_covered')).toBe(false);
  });

  it('fails a blanket block that locks the ops team out too', async () => {
    // Behaviourally indistinguishable from a correct fix at every URL the
    // grader can reach - which is exactly why one config check is needed.
    const cf = fakeCf({}, ruleAllowing('starts_with(http.request.uri.path, "/admin")'));
    const result = await wafAdminLockdown.grade(ctx(cf, fakeProbe(lockedDown)));
    expect(result.pass).toBe(false);
    expect(check(result, 'admin_blocked_for_unlisted_ip')).toBe(true);
    expect(check(result, 'jump_host_exception_configured')).toBe(false);
  });

  it('fails an over-broad rule that takes the whole site down', async () => {
    const overBroad = { ...lockedDown, [`${BASE}/`]: blocked(`${BASE}/`) };
    const cf = fakeCf({}, ruleAllowing(`ip.src ne ${ALLOWED}`));
    const result = await wafAdminLockdown.grade(ctx(cf, fakeProbe(overBroad)));
    expect(result.pass).toBe(false);
    expect(check(result, 'homepage_still_served')).toBe(false);
  });

  it('ignores a disabled rule when looking for the exception', async () => {
    const cf = fakeCf({}, {
      [PHASE]: [{ action: 'block', expression: `ip.src ne ${ALLOWED}`, enabled: false }],
    });
    const result = await wafAdminLockdown.grade(ctx(cf, fakeProbe(lockedDown)));
    expect(check(result, 'jump_host_exception_configured')).toBe(false);
  });
});

describe('03-waf-admin-lockdown seed/reset', () => {
  it('reset is idempotent and leaves the area open', async () => {
    const cf = fakeCf({}, { [PHASE]: [{ action: 'block', expression: 'leftover' }] });
    const c = ctx(cf, fakeProbe(wideOpen));
    await wafAdminLockdown.reset(c);
    const first = await rulesOf(cf, PHASE);
    await wafAdminLockdown.reset(c);
    const second = await rulesOf(cf, PHASE);
    expect(first).toEqual([]);
    expect(first).toEqual(second);
  });
});
