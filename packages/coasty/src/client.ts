import type {
  CoastyRun,
  CreateMachineRequest,
  CreateMachineResponse,
  CreateRunRequest,
} from './types.ts';

const DEFAULT_BASE_URL = 'https://coasty.ai/v1';

export class CoastyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | null;

  constructor(status: number, code: string, message: string, requestId: string | null) {
    super(`Coasty ${code} (${String(status)}): ${message}`);
    this.name = 'CoastyError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export interface CoastyClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface ErrorEnvelope {
  error?: { code?: string; message?: string; request_id?: string };
}

export class CoastyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CoastyClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  /** True for sandbox keys, which never bill and run a deterministic sandbox. */
  get isTestKey(): boolean {
    return this.apiKey.startsWith('sk-coasty-test-');
  }

  /**
   * Provision a machine for an attempt to drive.
   *
   * Uses machines + runs rather than the newer submit-and-forget POST /v1/tasks
   * for two reasons: owning the machine is what makes it possible to pre-seed
   * an authenticated browser session, so a demo password never has to travel
   * inside the task text; and the cookbook's offline mock implements this
   * surface but not /v1/tasks, so the whole flow stays testable without
   * spending anything.
   *
   * `Idempotency-Key` is mandatory by policy: an unkeyed retry after a dropped
   * connection can leave a second machine running and billing.
   */
  async createMachine(
    request: CreateMachineRequest,
    idempotencyKey: string,
  ): Promise<CreateMachineResponse> {
    return this.parse<CreateMachineResponse>(
      await this.post('/machines', request, idempotencyKey),
    );
  }

  /** Terminate a machine we provisioned. Skipping this bills by the hour. */
  async deleteMachine(machineId: string): Promise<void> {
    const response = await this.fetchImpl(`${this.baseUrl}/machines/${machineId}`, {
      method: 'DELETE',
      headers: { 'X-API-Key': this.apiKey },
    });
    if (!response.ok) await this.parse<unknown>(response);
  }

  async createRun(request: CreateRunRequest, idempotencyKey: string): Promise<CoastyRun> {
    return this.parse<CoastyRun>(await this.post('/runs', request, idempotencyKey));
  }

  private post(path: string, body: unknown, idempotencyKey: string): Promise<Response> {
    return this.fetchImpl(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.apiKey,
        'Content-Type': 'application/json',
        // Documented as global across endpoints for one credential, so each
        // call site needs its own suffix or the second one 422s.
        'Idempotency-Key': idempotencyKey,
      },
      body: JSON.stringify(body),
    });
  }

  async getRun(runId: string): Promise<CoastyRun> {
    const response = await this.fetchImpl(`${this.baseUrl}/runs/${runId}`, {
      headers: { 'X-API-Key': this.apiKey },
    });
    return this.parse<CoastyRun>(response);
  }

  async cancelRun(runId: string): Promise<CoastyRun> {
    const response = await this.fetchImpl(`${this.baseUrl}/runs/${runId}/cancel`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey },
    });
    return this.parse<CoastyRun>(response);
  }

  private async parse<T>(response: Response): Promise<T> {
    const text = await response.text();
    if (!response.ok) {
      let envelope: ErrorEnvelope = {};
      try {
        envelope = JSON.parse(text) as ErrorEnvelope;
      } catch {
        envelope = {};
      }
      // Branch on `code`, never on `message` - the docs say message wording
      // is not stable.
      throw new CoastyError(
        response.status,
        envelope.error?.code ?? 'UNKNOWN',
        envelope.error?.message ?? text.slice(0, 200),
        response.headers.get('X-Coasty-Request-Id'),
      );
    }
    return JSON.parse(text) as T;
  }
}
