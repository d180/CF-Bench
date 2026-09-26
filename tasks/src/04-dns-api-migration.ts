import { applyHealthyBaseline } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

/**
 * TEST-NET-1 (RFC 5737). Reserved for documentation and guaranteed never to be
 * routable, so the seeded outage is a real, deterministic outage rather than
 * traffic quietly landing on somebody else's server.
 */
const DECOMMISSIONED_IP = '192.0.2.1';

const PROMPT = `Ticket #4560 - api.{{ZONE}} has been down since the server move

We migrated the API onto our new web server yesterday and api.{{ZONE}} has
been unreachable ever since. Customers get nothing at all from it.

The main website is fine and serving normally from the new server, so the
server itself is clearly up - it looks like the cutover itself was botched.
The person who did it was working from a runbook we had not updated, and I
think they pointed it at the machine we decommissioned last month.

I am also told the record got pulled out of the proxy at some point "just to
test something" and nobody put it back. All of our public traffic is supposed
to go through Cloudflare rather than hitting the server directly, so that
needs fixing too while you are in there.

Please get api.{{ZONE}} answering again, served the same way as the rest of
the site.`;

/**
 * Task 04 - finish a botched DNS cutover.
 *
 * Two faults, one ticket: the record points at a decommissioned host, and it
 * was left unproxied. Fixing only the address gets the API answering while
 * quietly exposing the origin and losing every Cloudflare feature in front of
 * it - so the grader checks both, and checks proxying behaviourally rather
 * than trusting the flag alone.
 */
export const dnsApiMigration: Task = {
  id: '04-dns-api-migration',
  title: 'API subdomain down after a botched cutover',
  difficulty: 'medium',
  prompt: PROMPT,

  async seed(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async reset(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async applyKnownFix(ctx: TaskContext): Promise<void> {
    const { zoneId, zoneName, originAIp } = ctx.config;
    const host = apiHost(zoneName);
    const records = await ctx.cf.listDnsRecords(zoneId, { name: host });
    const record = records[0];
    if (record === undefined) {
      await ctx.cf.createDnsRecord(zoneId, { type: 'A', name: host, content: originAIp, proxied: true });
      return;
    }
    await ctx.cf.updateDnsRecord(zoneId, record.id, {
      type: 'A',
      name: host,
      content: originAIp,
      proxied: true,
    });
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const { zoneId, zoneName } = ctx.config;
    const host = apiHost(zoneName);
    const checks: Check[] = [];

    const probe = await ctx.http.get(`https://${host}/`, { maxRedirects: 4, timeoutMs: 10_000 });

    checks.push({
      name: 'api_answers_again',
      kind: 'http',
      pass: probe.status === 200,
      detail:
        probe.error !== undefined
          ? `https://${host}/ could not be reached: ${probe.error}`
          : `https://${host}/ returned ${String(probe.status)}.`,
    });

    checks.push({
      name: 'served_by_the_live_api',
      kind: 'http',
      pass: probe.headers['x-cfbench-origin'] === 'A',
      detail:
        probe.headers['x-cfbench-origin'] === undefined
          ? 'The response carried no origin marker, so it did not come from the API server.'
          : `Origin marker X-CFBench-Origin: ${probe.headers['x-cfbench-origin']}`,
    });

    // Behavioural proof of proxying: Cloudflare stamps cf-ray on anything it
    // serves. A direct hit on the origin has no such header, so this catches
    // a record that resolves and answers while bypassing Cloudflare entirely.
    const proxiedLive = probe.headers['cf-ray'] !== undefined;
    checks.push({
      name: 'traffic_goes_through_cloudflare',
      kind: 'http',
      pass: proxiedLive,
      detail: proxiedLive
        ? 'Responses carry a cf-ray header, so the hostname is served through Cloudflare.'
        : 'No cf-ray header on the response - traffic is reaching the origin directly instead of through Cloudflare.',
    });

    const records = await ctx.cf.listDnsRecords(zoneId, { name: host });
    const record = records.find((r) => r.type === 'A' || r.type === 'AAAA' || r.type === 'CNAME');
    checks.push({
      name: 'dns_record_is_proxied',
      kind: 'config',
      pass: record?.proxied === true,
      detail:
        record === undefined
          ? `No A, AAAA or CNAME record exists for ${host}.`
          : `${record.type} ${host} -> ${record.content} (proxied: ${String(record.proxied)})`,
    });

    checks.push({
      name: 'no_longer_points_at_decommissioned_host',
      kind: 'config',
      pass: record !== undefined && record.content !== DECOMMISSIONED_IP,
      detail:
        record?.content === DECOMMISSIONED_IP
          ? `The record still points at the decommissioned host ${DECOMMISSIONED_IP}.`
          : `The record no longer points at ${DECOMMISSIONED_IP}.`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function apiHost(zoneName: string): string {
  return `api.${zoneName}`;
}

/**
 * Starting state: the botched cutover.
 *
 * Deletes every record on the hostname before writing the broken one, so the
 * zone lands in one known state no matter what a previous attempt created -
 * an attempt that added a second record would otherwise leave the hostname
 * round-robining between a working and a dead address.
 */
async function converge(ctx: TaskContext): Promise<void> {
  await applyHealthyBaseline(ctx);
  const { zoneId, zoneName } = ctx.config;
  const host = apiHost(zoneName);

  for (const record of await ctx.cf.listDnsRecords(zoneId, { name: host })) {
    await ctx.cf.deleteDnsRecord(zoneId, record.id);
  }

  await ctx.cf.createDnsRecord(zoneId, {
    type: 'A',
    name: host,
    content: DECOMMISSIONED_IP,
    proxied: false,
    ttl: 60,
    comment: 'cfbench:04 seeded - decommissioned host, unproxied',
  });
}
