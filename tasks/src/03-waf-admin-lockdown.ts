import type { RulesetRule } from '@cf-bench/cf';
import { applyHealthyBaseline } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

const PHASE = 'http_request_firewall_custom';

const PROMPT = `Ticket #4488 - admin area is reachable from the public internet

Our security scanner flagged that the admin area on https://www.{{ZONE}}/admin
is publicly reachable. Anyone on the internet can load it right now.

We want this refused at the edge, so those requests never touch our web server
at all - blocking it in the application is not good enough, and the ops team
does not want to redeploy anything.

Ops administers the site from our jump host at {{ADMIN_ALLOWED_IP}}. That one
address has to keep working, including after the lockdown. Everybody else
should be refused.

Please make sure the whole admin area is covered and not just that one exact
URL - the scanner also reported /admin/settings.`;

/**
 * Task 03 - lock /admin down at the edge with a single-IP exception.
 *
 * Graded almost entirely on observed behaviour rather than rule text. The Free
 * plan has no regex in custom rules, and there are many correct ways to write
 * this - `eq` plus `starts_with`, a wildcard, inverted operand order, an `and`
 * of negations. Comparing expression strings would fail correct work, so the
 * grader asks the site what it does instead.
 */
export const wafAdminLockdown: Task = {
  id: '03-waf-admin-lockdown',
  title: 'Admin area exposed to the public internet',
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
      action: 'block',
      description: 'cfbench:03: restrict /admin to the ops jump host',
      expression:
        `(http.request.uri.path eq "/admin" or starts_with(http.request.uri.path, "/admin/"))` +
        ` and ip.src ne ${ctx.config.adminAllowedIp}`,
    };
    await ctx.cf.putEntrypointRuleset(ctx.config.zoneId, PHASE, [rule]);
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const base = `https://www.${ctx.config.zoneName}`;
    const checks: Check[] = [];

    // --- The admin area must be refused from anywhere but the jump host ---
    // The grader runs from an address that is NOT the allowed one, so a
    // correct configuration blocks it.
    const admin = await ctx.http.get(`${base}/admin`, { maxRedirects: 3 });
    checks.push({
      name: 'admin_blocked_for_unlisted_ip',
      kind: 'http',
      pass: isBlocked(admin.status),
      detail: `GET /admin from an unlisted address returned ${String(admin.status)} (expected 403).`,
    });

    const nested = await ctx.http.get(`${base}/admin/settings`, { maxRedirects: 3 });
    checks.push({
      name: 'whole_admin_area_covered',
      kind: 'http',
      pass: isBlocked(nested.status),
      detail: `GET /admin/settings returned ${String(nested.status)} (expected 403). Blocking only the exact path /admin leaves the area reachable.`,
    });

    // --- ...without taking the rest of the site down with it ---
    const home = await ctx.http.get(`${base}/`, { maxRedirects: 3 });
    checks.push({
      name: 'homepage_still_served',
      kind: 'http',
      pass: home.status === 200 && home.headers['x-cfbench-site'] === 'main',
      detail: `GET / returned ${String(home.status)}${
        home.headers['x-cfbench-site'] === 'main' ? ' from the origin.' : ' and did not come from the origin.'
      }`,
    });

    const api = await ctx.http.get(`${base}/api/time`, { maxRedirects: 3, cacheBust: true });
    checks.push({
      name: 'api_still_served',
      kind: 'http',
      pass: api.status === 200,
      detail: `GET /api/time returned ${String(api.status)} (expected 200 - the lockdown must not be over-broad).`,
    });

    // --- The exception has to actually exist -----------------------------
    // Blocking /admin for everyone would satisfy every check above while
    // locking ops out, which the ticket explicitly forbids. The allowed
    // address cannot be tested live from here (the grader is not that
    // address), so this one check reads configuration.
    const ruleset = await ctx.cf.getEntrypointRuleset(ctx.config.zoneId, PHASE);
    const rules = ruleset?.rules ?? [];
    const exception = rules.find(
      (r) => r.enabled !== false && (r.expression ?? '').includes(ctx.config.adminAllowedIp),
    );
    checks.push({
      name: 'jump_host_exception_configured',
      kind: 'config',
      pass: exception !== undefined,
      detail:
        exception !== undefined
          ? `An enabled rule carves out ${ctx.config.adminAllowedIp}: ${exception.expression ?? ''}`
          : `No enabled rule references ${ctx.config.adminAllowedIp}. Blocking the admin area for everyone locks the ops team out too.`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function isBlocked(status: number): boolean {
  return status === 403;
}

/**
 * Starting state: the admin area wide open.
 *
 * Replaces the whole phase rather than deleting matched rules, so the zone
 * lands in one known state no matter what a previous attempt left behind.
 */
async function converge(ctx: TaskContext): Promise<void> {
  // The healthy baseline already clears every custom rule, which is exactly
  // this task's starting state: the admin area wide open.
  await applyHealthyBaseline(ctx);
}
