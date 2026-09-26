import type { AccessApp, AccessPolicy } from '@cf-bench/cf';
import { applyHealthyBaseline } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

const PROMPT = `Ticket #4531 - staging site is public

Someone outside the company found https://staging.{{ZONE}} and sent us a
screenshot. It is wide open - no login, nothing. It has been indexed and
anyone who knows the URL can read it.

Staging needs to be reachable only by our own people. We all have
@{{EMAIL_DOMAIN}} addresses, so that is the line to draw: if someone can prove
they have an address on that domain they get in, and everyone else is stopped
before they see any of it.

We do not have an SSO provider set up and we are not buying one for this, so
whatever you use has to work with what is already available to us.

The public website on www must keep working exactly as it does now - please
do not put a login in front of our actual customers.`;

/**
 * Task 02 - put Cloudflare Access in front of the staging subdomain.
 *
 * The outcome that matters is that an unauthenticated stranger never sees
 * staging's content and is sent to an identity challenge instead. Which
 * identity provider or policy wording achieves that is not the grader's
 * business - on a Free plan the built-in one-time PIN is the realistic answer,
 * but the ticket deliberately never names it.
 */
export const accessStagingLockdown: Task = {
  id: '02-access-staging-lockdown',
  title: 'Staging subdomain is publicly readable',
  difficulty: 'hard',
  prompt: PROMPT,

  async seed(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async reset(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async applyKnownFix(ctx: TaskContext): Promise<void> {
    const { accountId, zoneName, allowedEmailDomain } = ctx.config;
    const app = await ctx.cf.createAccessApp(accountId, {
      name: 'cfbench:02 staging',
      type: 'self_hosted',
      domain: stagingHost(zoneName),
      session_duration: '24h',
    });
    await ctx.cf.createAccessPolicy(accountId, app.id, {
      name: `Allow ${allowedEmailDomain}`,
      decision: 'allow',
      include: [{ email_domain: { domain: allowedEmailDomain } }],
    });
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const { accountId, zoneName, teamDomain, allowedEmailDomain } = ctx.config;
    const host = stagingHost(zoneName);
    const checks: Check[] = [];

    // --- What a stranger actually gets -----------------------------------
    const probe = await ctx.http.get(`https://${host}/`, { maxRedirects: 4 });

    const leakedOrigin =
      probe.headers['x-cfbench-site'] === 'staging' || probe.body.includes('cf-bench staging');
    checks.push({
      name: 'staging_content_not_public',
      kind: 'http',
      pass: !leakedOrigin,
      detail: leakedOrigin
        ? 'An unauthenticated request was served the staging page itself.'
        : 'An unauthenticated request did not receive staging content.',
    });

    const sawLogin =
      probe.finalUrl.includes(teamDomain) ||
      probe.chain.some((hop) => (hop.location ?? '').includes(teamDomain));
    checks.push({
      name: 'unauthenticated_sent_to_identity_challenge',
      kind: 'http',
      pass: sawLogin,
      detail: sawLogin
        ? `Unauthenticated requests are redirected to ${teamDomain}.`
        : `Request ended at ${probe.finalUrl} with status ${String(probe.status)} and never reached an identity challenge at ${teamDomain}.`,
    });

    // --- The protection has to be bound to staging specifically ----------
    const apps = await ctx.cf.listAccessApps(accountId);
    const app = apps.find((a) => coversHost(a, host));
    checks.push({
      name: 'access_application_covers_staging',
      kind: 'config',
      pass: app !== undefined,
      detail:
        app === undefined
          ? `No Access application covers ${host}.`
          : `Access application "${app.name}" covers ${host}.`,
    });

    // --- ...and scoped to the company's email domain ---------------------
    let policies: AccessPolicy[] = [];
    if (app !== undefined) {
      policies = await ctx.cf.listAccessPolicies(accountId, app.id);
    }
    const allowPolicies = policies.filter((p) => p.decision === 'allow');
    const scoped = allowPolicies.find((p) => JSON.stringify(p.include ?? []).includes(allowedEmailDomain));
    checks.push({
      name: 'policy_limited_to_company_domain',
      kind: 'config',
      pass: scoped !== undefined,
      detail:
        scoped === undefined
          ? `No allow policy references ${allowedEmailDomain}.`
          : `Allow policy "${scoped.name}" admits ${allowedEmailDomain}.`,
    });

    // A policy that admits everyone still produces a login screen, so the
    // behavioural checks above cannot catch it - but it hands staging to the
    // whole internet with one extra click, which is the bug being fixed.
    const openToEveryone = allowPolicies.some((p) => JSON.stringify(p.include ?? []).includes('everyone'));
    checks.push({
      name: 'not_open_to_everyone',
      kind: 'config',
      pass: !openToEveryone,
      detail: openToEveryone
        ? 'An allow policy admits everyone, so any visitor can authenticate and read staging.'
        : 'No allow policy admits everyone.',
    });

    // --- The public site must be left alone ------------------------------
    const www = await ctx.http.get(`https://www.${zoneName}/`, { maxRedirects: 4 });
    checks.push({
      name: 'public_site_unaffected',
      kind: 'http',
      pass: www.status === 200 && www.headers['x-cfbench-site'] === 'main',
      detail: `GET https://www.${zoneName}/ returned ${String(www.status)}${
        www.headers['x-cfbench-site'] === 'main' ? ' from the origin.' : ' and did not come from the origin.'
      } Customers must not be put behind a login.`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function stagingHost(zoneName: string): string {
  return `staging.${zoneName}`;
}

/** Cloudflare returns both the legacy `domain` and the newer `destinations`. */
function coversHost(app: AccessApp, host: string): boolean {
  if (app.domain === host) return true;
  return (app.destinations ?? []).some((d) => (d.uri ?? '').includes(host));
}

/**
 * Starting state: staging reachable by anyone.
 *
 * Removes every Access application guarding the staging hostname, whatever it
 * is called, rather than only one this task created - a previous attempt may
 * have left its own app behind under a different name.
 */
async function converge(ctx: TaskContext): Promise<void> {
  await applyHealthyBaseline(ctx);
  const host = stagingHost(ctx.config.zoneName);
  const apps = await ctx.cf.listAccessApps(ctx.config.accountId);
  for (const app of apps) {
    if (coversHost(app, host)) {
      await ctx.cf.deleteAccessApp(ctx.config.accountId, app.id);
    }
  }
}
