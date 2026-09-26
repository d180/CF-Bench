import { applyHealthyBaseline } from './baseline.ts';
import type { Check, GradeResult, Task, TaskContext } from './types.ts';

const PROMPT = `Ticket #4417 - Website down, "too many redirects"

Reported by: sales@ (forwarded from three separate customers)

Nobody can load our website any more. Chrome shows ERR_TOO_MANY_REDIRECTS
and Safari just spins forever. It was working fine yesterday afternoon.

We did not deploy anything. I logged into the web server and nginx is up -
running curl against the server itself returns the homepage normally, so the
box looks healthy from the inside.

One more thing: last month's security review left us an open action item
saying traffic between Cloudflare and our web server has to be encrypted,
and our server's certificate actually verified - not just trusted blindly.
Whatever you do here, please make sure we end up satisfying that too, rather
than only getting the page to load again.

Please get the site back up for visitors.`;

/**
 * Task 01 - the classic Flexible-SSL redirect loop.
 *
 * The origin redirects HTTP to HTTPS (as any sane web server does). With the
 * zone's encryption mode set to Flexible, Cloudflare fetches the origin over
 * plain HTTP, receives that redirect, passes it back to the browser, and the
 * browser asks again - forever.
 *
 * Seeding also pins the zone off Automatic SSL/TLS. Left on `auto`, Cloudflare
 * rescans the origin and can silently upgrade the mode, which would heal the
 * bug behind the benchmark's back and destroy reproducibility.
 */
export const sslRedirectLoop: Task = {
  id: '01-ssl-redirect-loop',
  title: 'Site unreachable - redirect loop',
  difficulty: 'easy',
  prompt: PROMPT,

  async seed(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async reset(ctx: TaskContext): Promise<void> {
    await converge(ctx);
  },

  async applyKnownFix(ctx: TaskContext): Promise<void> {
    await ctx.cf.setZoneSetting(ctx.config.zoneId, 'ssl', 'strict');
  },

  async grade(ctx: TaskContext): Promise<GradeResult> {
    const host = `www.${ctx.config.zoneName}`;
    const checks: Check[] = [];

    // --- Config: the security requirement in the ticket ------------------
    const mode = await ctx.cf.getZoneSetting(ctx.config.zoneId, 'ssl');
    checks.push({
      name: 'ssl_mode_verifies_origin_certificate',
      kind: 'config',
      pass: mode === 'strict',
      detail:
        mode === 'strict'
          ? 'Encryption mode is Full (strict): Cloudflare connects to the origin over HTTPS and validates its certificate.'
          : `Encryption mode is "${String(mode)}", which does not validate the origin certificate. The ticket requires verified origin encryption.`,
    });

    // --- Live behaviour: what a visitor actually experiences -------------
    const plain = await ctx.http.get(`http://${host}/`, { maxRedirects: 10 });
    checks.push({
      name: 'no_redirect_loop',
      kind: 'http',
      pass: !plain.loop,
      detail: plain.loop
        ? `http://${host}/ still loops: ${describeChain(plain.chain)}`
        : `http://${host}/ resolved in ${String(plain.redirects)} redirect(s) without looping.`,
    });

    checks.push({
      name: 'visitor_gets_200_over_http_entry',
      kind: 'http',
      pass: !plain.loop && plain.status === 200,
      detail: plain.loop
        ? 'Not reached - the request never terminated.'
        : `Final status ${String(plain.status)} at ${plain.finalUrl}.`,
    });

    const secure = await ctx.http.get(`https://${host}/`, { maxRedirects: 5 });
    checks.push({
      name: 'https_returns_200',
      kind: 'http',
      pass: secure.status === 200,
      detail:
        secure.error !== undefined
          ? `Request failed: ${secure.error}`
          : `https://${host}/ returned ${String(secure.status)}.`,
    });

    // Proves Cloudflare actually reached the origin rather than serving its
    // own error page, which can also be a 5xx-free response.
    const marker = secure.headers['x-cfbench-site'];
    checks.push({
      name: 'response_came_from_origin',
      kind: 'http',
      pass: marker === 'main',
      detail:
        marker === undefined
          ? 'Origin marker header X-CFBench-Site was absent - the response did not come from the origin web server.'
          : `Origin marker X-CFBench-Site: ${marker}`,
    });

    return { pass: checks.every((c) => c.pass), checks };
  },
};

function describeChain(chain: { url: string; status: number }[]): string {
  return chain.map((hop) => `${String(hop.status)} ${hop.url}`).join(' -> ');
}

/**
 * Drive the zone to the task's starting state.
 *
 * Written as a convergence rather than a sequence of mutations: it states the
 * desired values unconditionally, so running it once or five times leaves the
 * zone identical. Order matters - pinning to a custom mode first means the
 * subsequent Flexible write cannot be undone by a scan.
 */
async function converge(ctx: TaskContext): Promise<void> {
  await applyHealthyBaseline(ctx);
  await ctx.cf.setZoneSetting(ctx.config.zoneId, 'ssl', 'flexible');
}
