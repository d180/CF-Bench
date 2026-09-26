import { describe, expect, it } from 'vitest';
import { signPayload, verifySignature } from '@cf-bench/coasty';

/**
 * The shared HMAC vectors published in the Coasty cookbook's API_NOTES.md,
 * used verbatim. Matching the reference implementation's own fixtures is the
 * only way to be confident this WebCrypto port agrees with the Node one the
 * cookbook ships - and that the Worker will accept real webhooks.
 */
const V1 = {
  secret: 'whsec_test_secret_123',
  t: 1750000000,
  body: '{"event":"run.succeeded","run_id":"run_123","status":"succeeded"}',
  v1: '5f70978eab52dbf5838da76e5eb6c6c465560ce8e746ed8e6113c159d8bbb2d4',
};

const V2 = {
  secret: 'whsec_other_secret_456',
  t: 1750000300,
  body: '{"event":"run.awaiting_human","run_id":"run_456","reason":"captcha"}',
  v1: '844504f42b7498094a83cedd7e050fc2f7fa32593b0814cc514c4be52a932e63',
};

const header = (t: number, v1: string): string => `t=${String(t)},v1=${v1}`;

describe('Coasty webhook signatures - published vectors', () => {
  it('reproduces vector 1 exactly', async () => {
    await expect(signPayload(V1.body, V1.secret, V1.t)).resolves.toBe(header(V1.t, V1.v1));
  });

  it('reproduces vector 2 exactly', async () => {
    await expect(signPayload(V2.body, V2.secret, V2.t)).resolves.toBe(header(V2.t, V2.v1));
  });

  it('accepts both valid vectors', async () => {
    await expect(verifySignature(V1.body, header(V1.t, V1.v1), V1.secret, { now: V1.t })).resolves.toBe(true);
    await expect(verifySignature(V2.body, header(V2.t, V2.v1), V2.secret, { now: V2.t })).resolves.toBe(true);
  });
});

describe('Coasty webhook signatures - the documented negative cases', () => {
  it('(a) rejects a flipped body byte', async () => {
    const tampered = V1.body.replace('run_123', 'run_124');
    await expect(verifySignature(tampered, header(V1.t, V1.v1), V1.secret, { now: V1.t })).resolves.toBe(false);
  });

  it('(b) rejects a timestamp outside the +/-300s replay window', async () => {
    const stale = { now: V1.t + 301 };
    await expect(verifySignature(V1.body, header(V1.t, V1.v1), V1.secret, stale)).resolves.toBe(false);
    // ...and accepts one right at the boundary.
    await expect(
      verifySignature(V1.body, header(V1.t, V1.v1), V1.secret, { now: V1.t + 300 }),
    ).resolves.toBe(true);
  });

  it('(c) rejects malformed headers', async () => {
    const cases = [`v1=${V1.v1}`, `t=${String(V1.t)}`, 'garbage', '', 't=abc,v1=' + V1.v1, `t=${String(V1.t)},v1=short`];
    for (const bad of cases) {
      await expect(verifySignature(V1.body, bad, V1.secret, { now: V1.t }), bad).resolves.toBe(false);
    }
  });

  it("(d) rejects a signature computed with another run's secret", async () => {
    await expect(verifySignature(V1.body, header(V1.t, V1.v1), V2.secret, { now: V1.t })).resolves.toBe(false);
  });

  it('rejects a null header or empty secret rather than throwing', async () => {
    await expect(verifySignature(V1.body, null, V1.secret, { now: V1.t })).resolves.toBe(false);
    await expect(verifySignature(V1.body, header(V1.t, V1.v1), '', { now: V1.t })).resolves.toBe(false);
  });

  it('is case-insensitive on the hex digest', async () => {
    await expect(
      verifySignature(V1.body, header(V1.t, V1.v1.toUpperCase()), V1.secret, { now: V1.t }),
    ).resolves.toBe(true);
  });
});
