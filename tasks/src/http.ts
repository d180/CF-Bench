/** One hop in a redirect chain. */
export interface ProbeHop {
  url: string;
  status: number;
  location: string | null;
}

export interface ProbeResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  chain: ProbeHop[];
  redirects: number;
  /** True when the chain revisited a URL or blew the redirect budget. */
  loop: boolean;
  /** Set when the request could not complete at all (DNS, TLS, timeout). */
  error?: string;
}

export interface ProbeOptions {
  maxRedirects?: number;
  /**
   * Append a unique query param to dodge caches. Off by default - the cache
   * task needs to actually observe caching, so cache-busting must be opt-in.
   */
  cacheBust?: boolean;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface HttpProbe {
  get(url: string, options?: ProbeOptions): Promise<ProbeResult>;
}

/**
 * An HTTP probe that follows redirects manually.
 *
 * Graders need to distinguish "redirected once to HTTPS and served the page"
 * from "bounced forever", which `fetch`'s automatic redirect handling hides
 * behind a generic error. Following hops by hand makes the chain itself
 * observable, so a grader can report *why* a site is down.
 */
export function createHttpProbe(fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)): HttpProbe {
  return {
    async get(url: string, options: ProbeOptions = {}): Promise<ProbeResult> {
      const maxRedirects = options.maxRedirects ?? 10;
      const timeoutMs = options.timeoutMs ?? 20_000;

      let current = options.cacheBust === true ? addCacheBust(url) : url;
      const chain: ProbeHop[] = [];
      const seen = new Set<string>();

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        if (seen.has(current)) {
          return {
            url, finalUrl: current, status: 0, headers: {}, body: '',
            chain, redirects: chain.length, loop: true,
          };
        }
        seen.add(current);

        let response: Response;
        try {
          response = await fetchImpl(current, {
            method: 'GET',
            redirect: 'manual',
            headers: options.headers ?? {},
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (cause) {
          return {
            url, finalUrl: current, status: 0, headers: {}, body: '',
            chain, redirects: chain.length, loop: false,
            error: cause instanceof Error ? cause.message : String(cause),
          };
        }

        const location = response.headers.get('location');
        chain.push({ url: current, status: response.status, location });

        if (isRedirect(response.status) && location !== null) {
          current = new URL(location, current).toString();
          continue;
        }

        return {
          url,
          finalUrl: current,
          status: response.status,
          headers: headersToObject(response.headers),
          body: (await response.text()).slice(0, 8192),
          chain,
          redirects: chain.length - 1,
          loop: false,
        };
      }

      // Budget exhausted while still being redirected.
      return {
        url, finalUrl: current, status: 0, headers: {}, body: '',
        chain, redirects: chain.length, loop: true,
      };
    },
  };
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

function addCacheBust(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set('_cfb', Math.random().toString(36).slice(2));
  return parsed.toString();
}
