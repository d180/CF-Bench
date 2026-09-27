import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CloudflareClient } from '@cf-bench/cf';
import { createHttpProbe } from '@cf-bench/tasks';
import type { BenchConfig, TaskContext } from '@cf-bench/tasks';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Minimal .env reader - avoids a dependency for a dozen lines of parsing. */
function loadEnvFile(path: string): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`Could not read ${path}. Copy .env.example to .env and fill it in.`);
  }
  const out: Record<string, string> = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return out;
}

function required(env: Record<string, string>, key: string): string {
  const value = env[key] ?? process.env[key] ?? '';
  if (value === '') throw new Error(`Missing ${key} in .env`);
  return value;
}

export interface LoadedContext extends TaskContext {
  cf: CloudflareClient;
}

/**
 * The raw .env map.
 *
 * `loadContext` deliberately does not write into `process.env`, so anything
 * that spawns a child process has to pass the variables it needs explicitly
 * rather than relying on inheritance.
 */
export function loadEnv(): Record<string, string> {
  return loadEnvFile(resolve(repoRoot, '.env'));
}

export function loadContext(): LoadedContext {
  const env = loadEnvFile(resolve(repoRoot, '.env'));

  const config: BenchConfig = {
    accountId: required(env, 'CF_ACCOUNT_ID'),
    zoneId: required(env, 'CF_ZONE_ID'),
    zoneName: required(env, 'CF_ZONE_NAME'),
    teamDomain: required(env, 'CF_TEAM_DOMAIN'),
    allowedEmailDomain: required(env, 'ACCESS_ALLOWED_EMAIL_DOMAIN'),
    originAIp: required(env, 'ORIGIN_A_IP'),
    originBAddr: (env['ORIGIN_B_ADDR'] ?? '') === '' ? null : (env['ORIGIN_B_ADDR'] as string),
    adminAllowedIp: required(env, 'ADMIN_ALLOWED_IP'),
  };

  return {
    cf: new CloudflareClient({ token: required(env, 'CF_API_TOKEN') }),
    config,
    http: createHttpProbe(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
