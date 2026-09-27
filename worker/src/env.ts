import { CloudflareClient } from '@cf-bench/cf';
import { createHttpProbe } from '@cf-bench/tasks';
import type { BenchConfig, TaskContext } from '@cf-bench/tasks';

export interface Env {
  DB: D1Database;

  // Non-secret deployment config (wrangler.toml [vars])
  CF_ACCOUNT_ID: string;
  CF_ZONE_ID: string;
  CF_ZONE_NAME: string;
  CF_TEAM_DOMAIN: string;
  ACCESS_ALLOWED_EMAIL_DOMAIN: string;
  ORIGIN_A_IP: string;
  ORIGIN_B_ADDR?: string;
  ADMIN_ALLOWED_IP: string;

  // Secrets (wrangler secret put / .dev.vars) - never reach the frontend
  CF_API_TOKEN: string;
  COASTY_API_KEY?: string;
  COASTY_BASE_URL?: string;

  /** Set to "1" in .dev.vars to skip the Access check while developing. */
  DEV_ALLOW_UNAUTHENTICATED?: string;
}

export function benchConfig(env: Env): BenchConfig {
  return {
    accountId: env.CF_ACCOUNT_ID,
    zoneId: env.CF_ZONE_ID,
    zoneName: env.CF_ZONE_NAME,
    teamDomain: env.CF_TEAM_DOMAIN,
    allowedEmailDomain: env.ACCESS_ALLOWED_EMAIL_DOMAIN,
    originAIp: env.ORIGIN_A_IP,
    originBAddr: (env.ORIGIN_B_ADDR ?? '') === '' ? null : (env.ORIGIN_B_ADDR as string),
    adminAllowedIp: env.ADMIN_ALLOWED_IP,
  };
}

export function taskContext(env: Env): TaskContext {
  return {
    cf: new CloudflareClient({ token: env.CF_API_TOKEN }),
    config: benchConfig(env),
    http: createHttpProbe(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
