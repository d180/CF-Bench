import type { RulesetRule } from '@cf-bench/cf';
import { applyHealthyBaseline, CACHE_PHASE, FIREWALL_PHASE } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

const PROMPT = `Ticket #5829 - production API unstable after infrastructure migration

Reported by: platform-oncall@

We moved our production API to a new server yesterday evening. The migration
looked successful at the time, but we are getting several different reports
this morning.

Some customers are seeing the new version of the API, while others still
appear to be hitting the old deployment.

The new server itself appears healthy. When I connect directly to it, the
health endpoint responds and it is serving the current release.

A few requirements have to remain true once this is fixed:

- api.{{ZONE}} must continue to be served through Cloudflare. Do not bypass
  Cloudflare or turn off proxying just to make the service reachable.
- Traffic between Cloudflare and the production origin must be encrypted, and
  Cloudflare must verify the certificate the origin presents.
- Responses under /api/* contain frequently changing data. Customers must not
  keep receiving an old response after the origin has returned newer data.
- /admin is part of the same application but must not be reachable from the
  public internet. Only our office address, {{ADMIN_ALLOWED_IP}}, should reach it.
- The API itself must stay publicly accessible.

Current production hostname: api.{{ZONE}}
New production origin:       {{ORIGIN_A}}

The old server is still online because we have not finished decommissioning
it, so a successful HTTP response on its own does not prove that traffic is
reaching the correct server.

Please get api.{{ZONE}} consistently reaching the new deployment, confirm the
origin connection meets our TLS requirement, make sure API responses are not
served stale, and verify the admin endpoint is restricted without affecting
normal API traffic.`;

/**
 * Task 06 - four faults in one incident.
 *
 * Unlike the single-fault tasks, this one can be partially fixed in ways that
 * look like success. Repointing DNS gets a 200 from the right box while the
 * origin connection is still unverified; locking down /admin with a broad
 * enough rule takes the API down with it; turning off proxying would make
 * everything reachable and violate the first requirement outright.
 *
 * The grader is therefore mostly behavioural, and deliberately reads the
 * origin marker rather than the status code: the old deployment is still
 * running and answers 200 perfectly happily.
 */
export const apiMigrationIncident: Task = {
  id: '06-api-migration-incident',
  title: 'Production API unstable after migration',
  difficulty: 'hard',
  prompt: PROMPT,

  async seed(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async reset(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async applyKnownFix(ctx: TaskContext): Promise<void> {
    const { zoneId, zoneName, originAIp, adminAllowedIp } = ctx.config;
    const host = apiHost(zoneName);

    await ctx.cf.setZoneSetting(zoneId, 'ssl', 'strict');

    for (const record of await ctx.cf.listDnsRecords(zoneId, { name: host })) {
      await ctx.cf.deleteDnsRecord(zoneId, record.id);
    }
    await ctx.cf.createDnsRecord(zoneId, {
      type: 'A', name: host, content: originAIp, proxied: true,
    });

    await ctx.cf.putEntrypointRuleset(zoneId, CACHE_PHASE, [
      {
        action: 'set_cache_settings',
        description: 'cfbench:06: do not cache the API',
        expression: '(starts_with(http.request.uri.path, "/api/"))',
        action_parameters: { cache: false },
      },
    ]);

    await ctx.cf.putEntrypointRuleset(zoneId, FIREWALL_PHASE, [
      {
        action: 'block',
        description: 'cfbench:06: restrict /admin to the office',
        expression:
          `(http.request.uri.path eq "/admin" or starts_with(http.request.uri.path, "/admin/"))` +
          ` and ip.src ne ${adminAllowedIp}`,
      },
    ]);
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const { zoneId, zoneName, adminAllowedIp } = ctx.config;
    const host = apiHost(zoneName);
    const base = `https://${host}`;
    const checks: Check[] = [];

    const root = await ctx.http.get(`${base}/`, { maxRedirects: 4, timeoutMs: 15_000 });

    // --- Reaching the right server ---------------------------------------
    // The old deployment is still up and answers 200, so status alone proves
    // nothing. The marker is the only evidence of which box replied.
    const origin = root.headers['x-cfbench-origin'];
    checks.push({
      name: 'traffic_reaches_the_new_deployment',
      kind: 'http',
      pass: origin === 'A',
      detail:
        origin === undefined
          ? `No origin marker on the response from ${host} - it did not come from either deployment.`
          : `Origin marker is "${origin}" (release ${String(root.headers['x-cfbench-release'] ?? '?')}). The new deployment reports "A".`,
    });

    checks.push({
      name: 'api_publicly_reachable',
      kind: 'http',
      pass: root.status === 200,
      detail:
        root.error !== undefined
          ? `${base}/ could not be reached: ${root.error}`
          : `${base}/ returned ${String(root.status)}.`,
    });

    // --- Still behind Cloudflare -----------------------------------------
    const proxiedLive = root.headers['cf-ray'] !== undefined;
    checks.push({
      name: 'served_through_cloudflare',
      kind: 'http',
      pass: proxiedLive,
      detail: proxiedLive
        ? 'Responses carry cf-ray, so the hostname is still served through Cloudflare.'
        : 'No cf-ray header - traffic is reaching the origin directly, bypassing Cloudflare.',
    });

    const records = await ctx.cf.listDnsRecords(zoneId, { name: host });
    const record = records.find((r) => ['A', 'AAAA', 'CNAME'].includes(r.type));
    checks.push({
      name: 'dns_record_is_proxied',
      kind: 'config',
      pass: record?.proxied === true,
      detail:
        record === undefined
          ? `No A, AAAA or CNAME record exists for ${host}.`
          : `${record.type} ${host} -> ${record.content} (proxied: ${String(record.proxied)})`,
    });

    // --- Verified origin TLS ----------------------------------------------
    const mode = await ctx.cf.getZoneSetting(zoneId, 'ssl');
    checks.push({
      name: 'origin_certificate_verified',
      kind: 'config',
      pass: mode === 'strict',
      detail:
        mode === 'strict'
          ? 'Encryption mode is Full (strict): the origin connection is encrypted and its certificate validated.'
          : `Encryption mode is "${String(mode)}". Full and Flexible do not verify the origin certificate, which the ticket requires.`,
    });

    // --- Fresh API responses ----------------------------------------------
    const first = await ctx.http.get(`${base}/api/time`, { maxRedirects: 3, timeoutMs: 15_000 });
    await (ctx.sleep ?? delay)(1500);
    const second = await ctx.http.get(`${base}/api/time`, { maxRedirects: 3, timeoutMs: 15_000 });

    const fresh = first.body !== '' && first.body !== second.body;
    checks.push({
      name: 'api_responses_not_stale',
      kind: 'http',
      pass: fresh,
      detail: fresh
        ? 'Two consecutive requests to /api/time returned different payloads.'
        : `Two consecutive requests returned an identical payload: ${first.body.trim().slice(0, 110)}`,
    });

    const cacheStatus = second.headers['cf-cache-status'] ?? '(absent)';
    checks.push({
      name: 'api_not_served_from_cache',
      kind: 'http',
      pass: cacheStatus.toUpperCase() !== 'HIT',
      detail: `cf-cache-status on /api/time is ${cacheStatus}.`,
    });

    // --- Admin locked down, API untouched ---------------------------------
    const admin = await ctx.http.get(`${base}/admin`, { maxRedirects: 3, timeoutMs: 15_000 });
    checks.push({
      name: 'admin_blocked_from_public_internet',
      kind: 'http',
      pass: admin.status === 403,
      detail: `GET /admin from an address other than the office returned ${String(admin.status)} (expected 403).`,
    });

    const ruleset = await ctx.cf.getEntrypointRuleset(zoneId, FIREWALL_PHASE);
    const exception = (ruleset?.rules ?? []).find(
      (r) => r.enabled !== false && (r.expression ?? '').includes(adminAllowedIp),
    );
    checks.push({
      name: 'office_address_still_allowed',
      kind: 'config',
      pass: exception !== undefined,
      detail:
        exception !== undefined
          ? `An enabled rule carves out ${adminAllowedIp}.`
          : `No enabled rule references ${adminAllowedIp}. Blocking /admin for everyone locks the office out too.`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function apiHost(zoneName: string): string {
  return `api.${zoneName}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The botched migration, as four separate faults.
 *
 * `full` rather than `flexible` for the encryption mode on purpose: Flexible
 * would make the origin redirect-loop, and the ticket describes a site that
 * answers inconsistently rather than one that is down. Full answers fine and
 * still fails the requirement, because it accepts any certificate without
 * checking it.
 */
async function converge(ctx: TaskContext): Promise<void> {
  await applyHealthyBaseline(ctx);

  const { zoneId, zoneName, originBAddr } = ctx.config;
  const host = apiHost(zoneName);

  if (originBAddr === null) {
    throw new Error('ORIGIN_B_ADDR is not configured; task 06 needs the old deployment to exist.');
  }

  await ctx.cf.setZoneSetting(zoneId, 'ssl', 'full');

  for (const record of await ctx.cf.listDnsRecords(zoneId, { name: host })) {
    await ctx.cf.deleteDnsRecord(zoneId, record.id);
  }
  await ctx.cf.createDnsRecord(zoneId, {
    type: originBAddr.includes(':') ? 'AAAA' : 'A',
    name: host,
    content: originBAddr,
    proxied: true,
    comment: 'cfbench:06 seeded - still pointing at the old deployment',
  });

  const staleCache: RulesetRule = {
    action: 'set_cache_settings',
    description: 'cfbench:06: cache everything under /api (the bug)',
    expression: '(starts_with(http.request.uri.path, "/api/"))',
    action_parameters: { cache: true, edge_ttl: { mode: 'override_origin', default: 3600 } },
  };
  await ctx.cf.putEntrypointRuleset(zoneId, CACHE_PHASE, [staleCache]);
}
