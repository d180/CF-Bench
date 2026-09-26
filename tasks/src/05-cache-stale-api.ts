import type { RulesetRule } from '@cf-bench/cf';
import { applyHealthyBaseline } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

const PHASE = 'http_request_cache_settings';
const EDGE_TTL_SECONDS = 3600;

const PROMPT = `Ticket #4502 - /api is serving stale data

Support has three tickets open about our API returning old data.

If you call https://www.{{ZONE}}/api/time over and over you get the exact same
response back every time, for an hour at a stretch, even though that endpoint
generates a fresh timestamp on every request.

Our web server already marks these responses as not cacheable, and curling the
server directly always returns current data - so whatever is holding on to the
old response is sitting in front of the server, not the server itself.

The rest of the website should carry on being cached as normal. This is
specifically about the /api area returning current data again.`;

/**
 * Task 05 - a cache rule forcing stale API responses.
 *
 * Graded purely on the outcome: does /api/time return fresh data, and did the
 * response stop coming out of cache.
 *
 * Deliberately NOT graded on "a bypass rule exists". Deleting the offending
 * rule is an equally valid fix - the origin already sends `no-store`, so
 * default behaviour is correct once nothing overrides it. Requiring a specific
 * rule would grade the method rather than the result, and would fail a
 * perfectly good solution.
 */
export const cacheStaleApi: Task = {
  id: '05-cache-stale-api',
  title: 'API endpoint serving stale responses',
  difficulty: 'medium',
  prompt: PROMPT,

  async seed(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async reset(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async applyKnownFix(ctx: TaskContext): Promise<void> {
    const rule: RulesetRule = {
      action: 'set_cache_settings',
      description: 'cfbench:05: do not cache the API',
      expression: '(starts_with(http.request.uri.path, "/api/"))',
      action_parameters: { cache: false },
    };
    await ctx.cf.putEntrypointRuleset(ctx.config.zoneId, PHASE, [rule]);
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const base = `https://www.${ctx.config.zoneName}`;
    const checks: Check[] = [];

    // Two hits on the SAME url, deliberately without cache-busting: adding a
    // unique query param would route around the cache and make even a broken
    // configuration look fixed.
    const first = await ctx.http.get(`${base}/api/time`, { maxRedirects: 3 });
    await (ctx.sleep ?? delay)(1500);
    const second = await ctx.http.get(`${base}/api/time`, { maxRedirects: 3 });

    const fresh = first.body !== '' && first.body !== second.body;
    checks.push({
      name: 'api_returns_fresh_data',
      kind: 'http',
      pass: fresh,
      detail: fresh
        ? 'Two consecutive requests to /api/time returned different payloads, so responses are current.'
        : `Two consecutive requests returned an identical payload, so the response is still stale: ${first.body.trim().slice(0, 120)}`,
    });

    const status = second.headers['cf-cache-status'] ?? '(absent)';
    const servedFromCache = status.toUpperCase() === 'HIT';
    checks.push({
      name: 'api_not_served_from_cache',
      kind: 'http',
      pass: !servedFromCache,
      detail: `cf-cache-status on /api/time is ${status}. A cached HIT means visitors keep getting the stored copy.`,
    });

    // The fix must not be "turn caching off everywhere" or "break the site".
    const home = await ctx.http.get(`${base}/`, { maxRedirects: 3 });
    checks.push({
      name: 'site_still_served',
      kind: 'http',
      pass: home.status === 200 && home.headers['x-cfbench-site'] === 'main',
      detail: `GET / returned ${String(home.status)}${
        home.headers['x-cfbench-site'] === 'main' ? ' from the origin.' : ' and did not come from the origin.'
      }`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Starting state: force the API into the cache for an hour.
 *
 * The origin sends `no-store`, so the breakage has to be manufactured - an
 * edge TTL override is exactly how this happens in the wild, when a broad
 * "cache everything" rule is written without carving out the dynamic paths.
 */
async function converge(ctx: TaskContext): Promise<void> {
  await applyHealthyBaseline(ctx);
  const rule: RulesetRule = {
    action: 'set_cache_settings',
    description: 'cfbench:05: cache everything under /api (the bug)',
    expression: '(starts_with(http.request.uri.path, "/api/"))',
    action_parameters: {
      cache: true,
      edge_ttl: { mode: 'override_origin', default: EDGE_TTL_SECONDS },
    },
  };
  await ctx.cf.putEntrypointRuleset(ctx.config.zoneId, PHASE, [rule]);
}
