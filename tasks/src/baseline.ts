import type { TaskContext } from './types.ts';

export const FIREWALL_PHASE = 'http_request_firewall_custom';
export const CACHE_PHASE = 'http_request_cache_settings';

/**
 * Drive the whole zone to a known-healthy state.
 *
 * Every task shares one zone, so a task's starting state has to include
 * "everything this task is not about is working". Without this, seeding task 3
 * while task 1 sat broken would fail task 3's grader for an unrelated reason,
 * and a run's outcome would depend on whatever ran before it - precisely the
 * non-determinism the benchmark is built to eliminate.
 *
 * Each task therefore seeds by applying this baseline first, then breaking the
 * one dimension it owns. Expressed as a convergence, so it is idempotent.
 */
export async function applyHealthyBaseline(ctx: TaskContext): Promise<void> {
  const { zoneId } = ctx.config;

  // Pinning off Automatic SSL/TLS first: while the zone is on `auto`,
  // Cloudflare rescans and can move the encryption mode underneath us.
  await ctx.cf.setZoneSetting(zoneId, 'ssl_automatic_mode', 'custom');
  await ctx.cf.setZoneSetting(zoneId, 'ssl', 'strict');

  // Replace rather than prune: the zone lands in one known state regardless of
  // what a previous attempt left behind.
  await ctx.cf.putEntrypointRuleset(zoneId, FIREWALL_PHASE, []);
  await ctx.cf.putEntrypointRuleset(zoneId, CACHE_PHASE, []);
}
