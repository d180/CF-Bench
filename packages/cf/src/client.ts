import { CfError } from './errors.ts';
import type {
  CfEnvelope,
  DnsRecord,
  DnsRecordInput,
  Ruleset,
  RulesetRule,
  SettingValue,
  Zone,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://api.cloudflare.com/client/v4';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface CloudflareClientOptions {
  token: string;
  baseUrl?: string;
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Attempts for retryable failures, including the first try. Default 4. */
  maxAttempts?: number;
  /** Injectable for tests so retry backoff does not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A thin typed wrapper over the Cloudflare REST API.
 *
 * Deliberately `fetch`-only with no Node built-ins, so the same client runs in
 * the CLI (Node) and inside the Worker that will later serve the dashboard.
 *
 * Retries 429/5xx with exponential backoff and full jitter, honouring
 * `Retry-After`. Other 4xx are never retried - they will not become true.
 */
export class CloudflareClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly timeoutMs: number;

  constructor(options: CloudflareClientOptions) {
    this.token = options.token;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = options.maxAttempts ?? 4;
    this.sleep = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        // Transport failure - retryable.
        lastError = cause;
        if (attempt === this.maxAttempts) throw cause;
        await this.sleep(backoffMs(attempt, null));
        continue;
      }

      const text = await response.text();
      let envelope: CfEnvelope<T> | null = null;
      try {
        envelope = JSON.parse(text) as CfEnvelope<T>;
      } catch {
        envelope = null;
      }

      if (response.ok && envelope?.success === true) {
        return envelope.result;
      }

      const errors = envelope?.errors ?? [];
      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxAttempts) {
        lastError = new CfError(path, response.status, errors);
        await this.sleep(backoffMs(attempt, response.headers.get('retry-after')));
        continue;
      }

      throw new CfError(path, response.status, errors);
    }

    throw lastError instanceof Error ? lastError : new Error(`Cloudflare API ${path} failed`);
  }

  // --- Zones -------------------------------------------------------------

  getZone(zoneId: string): Promise<Zone> {
    return this.request<Zone>('GET', `/zones/${zoneId}`);
  }

  async getZoneSetting(zoneId: string, setting: string): Promise<SettingValue> {
    const result = await this.request<{ id: string; value: SettingValue }>(
      'GET',
      `/zones/${zoneId}/settings/${setting}`,
    );
    return result.value;
  }

  async setZoneSetting(zoneId: string, setting: string, value: SettingValue): Promise<void> {
    await this.request('PATCH', `/zones/${zoneId}/settings/${setting}`, { value });
  }

  // --- DNS ---------------------------------------------------------------

  listDnsRecords(zoneId: string, query: { name?: string; type?: string } = {}): Promise<DnsRecord[]> {
    const params = new URLSearchParams({ per_page: '100' });
    if (query.name !== undefined) params.set('name', query.name);
    if (query.type !== undefined) params.set('type', query.type);
    return this.request<DnsRecord[]>('GET', `/zones/${zoneId}/dns_records?${params.toString()}`);
  }

  createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecord> {
    return this.request<DnsRecord>('POST', `/zones/${zoneId}/dns_records`, record);
  }

  updateDnsRecord(zoneId: string, recordId: string, record: DnsRecordInput): Promise<DnsRecord> {
    return this.request<DnsRecord>('PUT', `/zones/${zoneId}/dns_records/${recordId}`, record);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<void> {
    await this.request('DELETE', `/zones/${zoneId}/dns_records/${recordId}`);
  }

  // --- Rulesets ----------------------------------------------------------

  /**
   * The entrypoint ruleset for a phase, or `null` when the zone has never had
   * one. A zone with no custom rules genuinely 404s here, which is a normal
   * state rather than an error.
   */
  async getEntrypointRuleset(zoneId: string, phase: string): Promise<Ruleset | null> {
    try {
      return await this.request<Ruleset>('GET', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`);
    } catch (error) {
      if (error instanceof CfError && error.status === 404) return null;
      throw error;
    }
  }

  /** Replaces every rule in the phase. Callers own the full desired state. */
  putEntrypointRuleset(zoneId: string, phase: string, rules: RulesetRule[]): Promise<Ruleset> {
    return this.request<Ruleset>('PUT', `/zones/${zoneId}/rulesets/phases/${phase}/entrypoint`, {
      rules,
    });
  }
}

function backoffMs(attempt: number, retryAfter: string | null): number {
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 8000);
  }
  const cap = Math.min(500 * 2 ** (attempt - 1), 8000);
  return Math.random() * cap; // full jitter
}
