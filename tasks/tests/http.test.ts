import { describe, expect, it } from 'vitest';
import { createHttpProbe } from '@cf-bench/tasks';

/** Builds a fetch stand-in that replays a scripted map of url -> response. */
function scriptedFetch(script: Record<string, { status: number; location?: string; headers?: Record<string, string> }>) {
  return (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const entry = script[url];
    if (entry === undefined) throw new Error(`no scripted response for ${url}`);
    const headers = new Headers(entry.headers ?? {});
    if (entry.location !== undefined) headers.set('location', entry.location);
    return Promise.resolve(new Response('body', { status: entry.status, headers }));
  };
}

describe('http probe', () => {
  it('follows a normal redirect and reports the hop count', async () => {
    const probe = createHttpProbe(scriptedFetch({
      'http://a.test/': { status: 301, location: 'https://a.test/' },
      'https://a.test/': { status: 200, headers: { 'x-cfbench-site': 'main' } },
    }) as unknown as typeof fetch);

    const result = await probe.get('http://a.test/');
    expect(result.loop).toBe(false);
    expect(result.status).toBe(200);
    expect(result.redirects).toBe(1);
    expect(result.headers['x-cfbench-site']).toBe('main');
  });

  it('detects a two-URL ping-pong loop instead of hanging', async () => {
    const probe = createHttpProbe(scriptedFetch({
      'http://a.test/': { status: 301, location: 'https://a.test/' },
      'https://a.test/': { status: 301, location: 'http://a.test/' },
    }) as unknown as typeof fetch);

    const result = await probe.get('http://a.test/');
    expect(result.loop).toBe(true);
    expect(result.status).toBe(0);
  });

  it('reports transport failures rather than throwing', async () => {
    const probe = createHttpProbe((() => Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof fetch);
    const result = await probe.get('https://down.test/');
    expect(result.error).toBe('ECONNREFUSED');
    expect(result.status).toBe(0);
    expect(result.loop).toBe(false);
  });
});
