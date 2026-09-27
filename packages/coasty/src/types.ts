/** Terminal and pause states from the documented run lifecycle. */
export type CoastyRunStatus =
  | 'queued' | 'running' | 'awaiting_human'
  | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

export interface CoastyMachineSpec {
  provider?: 'auto' | 'aws' | 'daytona' | 'azure';
  os_type?: 'linux' | 'windows';
  desktop_enabled?: boolean;
  cpu_cores?: number;
  memory_gb?: number;
}

/** POST /v1/machines */
export interface CreateMachineRequest extends CoastyMachineSpec {
  display_name: string;
  /**
   * Auto-terminate after this many minutes (5-10080).
   *
   * A backstop, not an optimisation: if a terminal webhook is never delivered
   * the machine would otherwise bill by the hour indefinitely. The TTL is the
   * only thing that bounds the cost of a lost webhook.
   */
  ttl_minutes?: number;
}

export interface CreateMachineResponse {
  machine: { id: string; status: string; is_test?: boolean; os_type?: string };
  request_id?: string;
}

/** POST /v1/runs - machine-bound run. */
export interface CreateRunRequest {
  machine_id: string;
  task: string;
  cua_version?: string;
  instructions?: string;
  max_steps?: number;
  deadline_seconds?: number;
  on_awaiting_human?: 'pause' | 'fail' | 'cancel';
  webhook_url?: string;
  metadata?: Record<string, string>;
}

export interface CoastyRun {
  id: string;
  object: string;
  status: CoastyRunStatus;
  cua_version?: string;
  machine_id: string | null;
  task?: string;
  steps_completed?: number;
  credits_charged?: number;
  cost_cents?: number;
  result?: { passed?: boolean; status?: string; summary?: string } | null;
  error?: { code: string; message: string } | null;
  metadata?: Record<string, string>;
  /** Returned ONCE on create and null on every subsequent read. */
  webhook_secret?: string | null;
  created_at?: string;
  finished_at?: string | null;
  request_id?: string;
}

export interface CoastyWebhookPayload {
  event: string;
  run_id: string;
  status?: CoastyRunStatus;
  reason?: string;
}

export const TERMINAL_EVENTS = new Set([
  'run.succeeded', 'run.failed', 'run.cancelled', 'run.timed_out',
]);
