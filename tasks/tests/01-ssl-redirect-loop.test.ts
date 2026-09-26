import { describe, expect, it } from 'vitest';
import { sslRedirectLoop } from '@cf-bench/tasks';
import { check, ctx, fakeCf, fakeProbe, probeResult } from './helpers.ts';

const HTTP = 'http://www.example.test/';
const HTTPS = 'https://www.example.test/';

/** A site that is genuinely working: one hop to HTTPS, 200, origin marker. */
const healthy = {
  [HTTP]: probeResult({
    url: HTTP, finalUrl: HTTPS, status: 200, redirects: 1,
    headers: { 'x-cfbench-site': 'main' },
    chain: [{ url: HTTP, status: 301, location: HTTPS }, { url: HTTPS, status: 200, location: null }],
  }),
  [HTTPS]: probeResult({ url: HTTPS, status: 200, headers: { 'x-cfbench-site': 'main' } }),
};

/** The seeded bug: the chain never terminates. */
const looping = {
  [HTTP]: probeResult({ url: HTTP, status: 0, loop: true, redirects: 10 }),
  [HTTPS]: probeResult({ url: HTTPS, status: 0, loop: true, redirects: 10 }),
};

describe('01-ssl-redirect-loop grade()', () => {
  it('passes when the mode verifies the origin cert and the site actually serves', async () => {
    const result = await sslRedirectLoop.grade(ctx(fakeCf({ ssl: 'strict' }), fakeProbe(healthy)));
    expect(result.pass).toBe(true);
    expect(result.checks.every((c) => c.pass)).toBe(true);
  });

  it('fails on the seeded state - flexible mode and a redirect loop', async () => {
    const result = await sslRedirectLoop.grade(ctx(fakeCf({ ssl: 'flexible' }), fakeProbe(looping)));
    expect(result.pass).toBe(false);
    expect(check(result, 'no_redirect_loop')).toBe(false);
    expect(check(result, 'ssl_mode_verifies_origin_certificate')).toBe(false);
  });

  it('accepts a valid solution regardless of how the mode was reached', async () => {
    // Reaching "strict" by re-enabling Automatic SSL/TLS is just as valid as
    // picking it by hand. The grader must not care which route was taken, so
    // it never reads ssl_automatic_mode.
    const viaAutomatic = fakeCf({ ssl: 'strict', ssl_automatic_mode: 'auto' });
    const byHand = fakeCf({ ssl: 'strict', ssl_automatic_mode: 'custom' });

    const a = await sslRedirectLoop.grade(ctx(viaAutomatic, fakeProbe(healthy)));
    const b = await sslRedirectLoop.grade(ctx(byHand, fakeProbe(healthy)));

    expect(a.pass).toBe(true);
    expect(b.pass).toBe(true);
  });

  it('fails when the config looks right but visitors still cannot load the site', async () => {
    // The whole point of grading the outcome: setting the dropdown correctly
    // while the site stays down is not a fix.
    const result = await sslRedirectLoop.grade(ctx(fakeCf({ ssl: 'strict' }), fakeProbe(looping)));
    expect(result.pass).toBe(false);
    expect(check(result, 'ssl_mode_verifies_origin_certificate')).toBe(true);
    expect(check(result, 'no_redirect_loop')).toBe(false);
  });

  it('fails when Cloudflare serves its own page instead of the origin', async () => {
    // A 200 from a Cloudflare interstitial is still not the website.
    const noMarker = {
      [HTTP]: probeResult({ url: HTTP, finalUrl: HTTPS, status: 200, redirects: 1 }),
      [HTTPS]: probeResult({ url: HTTPS, status: 200, headers: { server: 'cloudflare' } }),
    };
    const result = await sslRedirectLoop.grade(ctx(fakeCf({ ssl: 'strict' }), fakeProbe(noMarker)));
    expect(result.pass).toBe(false);
    expect(check(result, 'response_came_from_origin')).toBe(false);
  });

  it('rejects Full (non-strict) even though the site loads', async () => {
    // "full" clears the redirect loop but does not verify the origin
    // certificate, which the ticket explicitly requires.
    const result = await sslRedirectLoop.grade(ctx(fakeCf({ ssl: 'full' }), fakeProbe(healthy)));
    expect(result.pass).toBe(false);
    expect(check(result, 'ssl_mode_verifies_origin_certificate')).toBe(false);
    expect(check(result, 'no_redirect_loop')).toBe(true);
  });
});

describe('01-ssl-redirect-loop seed/reset', () => {
  it('reset is idempotent - running it twice lands on identical settings', async () => {
    const cf = fakeCf({ ssl: 'strict', ssl_automatic_mode: 'auto' });
    const c = ctx(cf, fakeProbe(looping));

    await sslRedirectLoop.reset(c);
    const first = [await cf.getZoneSetting('z', 'ssl'), await cf.getZoneSetting('z', 'ssl_automatic_mode')];
    await sslRedirectLoop.reset(c);
    const second = [await cf.getZoneSetting('z', 'ssl'), await cf.getZoneSetting('z', 'ssl_automatic_mode')];

    expect(first).toEqual(second);
    expect(first).toEqual(['flexible', 'custom']);
  });

  it('pins the zone off Automatic SSL/TLS so the bug cannot self-heal', async () => {
    const cf = fakeCf({ ssl: 'strict', ssl_automatic_mode: 'auto' });
    await sslRedirectLoop.seed(ctx(cf, fakeProbe(looping)));
    expect(await cf.getZoneSetting('z', 'ssl_automatic_mode')).toBe('custom');
  });
});
