import { describe, expect, it } from 'vitest';
import { accessStagingLockdown } from '@cf-bench/tasks';
import type { AccessApp, AccessPolicy } from '@cf-bench/cf';
import { appsOf, check, ctx, fakeCf, fakeProbe, probeResult, testConfig } from './helpers.ts';

const STAGING = 'https://staging.example.test/';
const WWW = 'https://www.example.test/';
const TEAM = testConfig.teamDomain;
const EMAIL = testConfig.allowedEmailDomain;

const wwwOk = probeResult({ url: WWW, status: 200, headers: { 'x-cfbench-site': 'main' } });

/** Protected: the stranger is bounced to the identity challenge. */
const challenged = {
  [STAGING]: probeResult({
    url: STAGING,
    finalUrl: `https://${TEAM}/cdn-cgi/access/login/staging.example.test`,
    status: 200,
    redirects: 1,
    chain: [{ url: STAGING, status: 302, location: `https://${TEAM}/cdn-cgi/access/login/staging.example.test` }],
  }),
  [WWW]: wwwOk,
};

/** Seeded: staging served straight from the origin. */
const wideOpen = {
  [STAGING]: probeResult({ url: STAGING, status: 200, headers: { 'x-cfbench-site': 'staging' } }),
  [WWW]: wwwOk,
};

const app = (overrides: Partial<AccessApp> = {}): AccessApp => ({
  id: 'app_1', name: 'staging', type: 'self_hosted', domain: 'staging.example.test', ...overrides,
});
const policy = (include: unknown[], decision = 'allow'): AccessPolicy => ({
  id: 'pol_app_1', name: 'p', decision, include: include as AccessPolicy['include'],
});

const guarded = (policies: AccessPolicy[], a: AccessApp = app()) =>
  fakeCf({}, {}, { apps: [a], policies: { [a.id]: policies } });

describe('02-access-staging-lockdown grade()', () => {
  it('passes when strangers are challenged and the policy is domain-scoped', async () => {
    const cf = guarded([policy([{ email_domain: { domain: EMAIL } }])]);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(challenged)));
    expect(result.pass).toBe(true);
  });

  it('fails on the seeded public state', async () => {
    const result = await accessStagingLockdown.grade(ctx(fakeCf(), fakeProbe(wideOpen)));
    expect(result.pass).toBe(false);
    expect(check(result, 'staging_content_not_public')).toBe(false);
    expect(check(result, 'access_application_covers_staging')).toBe(false);
  });

  it('accepts an app declared via destinations rather than the legacy domain field', async () => {
    // The dashboard writes `destinations`; the API accepts `domain`. Both are
    // the same configuration and neither is more correct.
    const viaDestinations = app({
      domain: undefined,
      destinations: [{ type: 'public', uri: 'staging.example.test' }],
    });
    const cf = guarded([policy([{ email_domain: { domain: EMAIL } }])], viaDestinations);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(challenged)));
    expect(result.pass).toBe(true);
  });

  it('fails a policy that admits everyone', async () => {
    // Still produces a login screen, so every behavioural check passes - and
    // staging is still one click away for the entire internet.
    const cf = guarded([policy([{ everyone: {} }])]);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(challenged)));
    expect(result.pass).toBe(false);
    expect(check(result, 'unauthenticated_sent_to_identity_challenge')).toBe(true);
    expect(check(result, 'not_open_to_everyone')).toBe(false);
    expect(check(result, 'policy_limited_to_company_domain')).toBe(false);
  });

  it('fails when the app exists but staging still serves its content', async () => {
    const cf = guarded([policy([{ email_domain: { domain: EMAIL } }])]);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(wideOpen)));
    expect(result.pass).toBe(false);
    expect(check(result, 'staging_content_not_public')).toBe(false);
  });

  it('fails when the public site got put behind the login too', async () => {
    const overReach = {
      ...challenged,
      [WWW]: probeResult({ url: WWW, finalUrl: `https://${TEAM}/login`, status: 200 }),
    };
    const cf = guarded([policy([{ email_domain: { domain: EMAIL } }])]);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(overReach)));
    expect(result.pass).toBe(false);
    expect(check(result, 'public_site_unaffected')).toBe(false);
  });

  it('ignores deny policies when looking for the domain scope', async () => {
    const cf = guarded([policy([{ email_domain: { domain: EMAIL } }], 'deny')]);
    const result = await accessStagingLockdown.grade(ctx(cf, fakeProbe(challenged)));
    expect(check(result, 'policy_limited_to_company_domain')).toBe(false);
  });
});

describe('02-access-staging-lockdown seed/reset', () => {
  it('removes any app guarding staging, not just one it created', async () => {
    const strays = fakeCf({}, {}, {
      apps: [
        app({ id: 'app_x', name: 'left over from a previous attempt' }),
        app({ id: 'app_y', name: 'unrelated', domain: 'other.example.test' }),
      ],
    });
    await accessStagingLockdown.reset(ctx(strays, fakeProbe(wideOpen)));
    const remaining = await appsOf(strays);
    expect(remaining.map((a) => a.id)).toEqual(['app_y']);
  });

  it('reset is idempotent', async () => {
    const cf = fakeCf({}, {}, { apps: [app()] });
    const c = ctx(cf, fakeProbe(wideOpen));
    await accessStagingLockdown.reset(c);
    const first = await appsOf(cf);
    await accessStagingLockdown.reset(c);
    expect(await appsOf(cf)).toEqual(first);
  });
});
