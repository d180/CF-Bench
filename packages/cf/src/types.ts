/** Cloudflare REST API response envelope. Every endpoint returns this shape. */
export interface CfEnvelope<T> {
  success: boolean;
  errors: CfErrorItem[];
  messages: unknown[];
  result: T;
}

export interface CfErrorItem {
  code: number;
  message: string;
}

/** Zone settings hold heterogeneous values; callers narrow at the call site. */
export type SettingValue = string | number | boolean | Record<string, unknown> | null;

export interface ZoneSetting {
  id: string;
  value: SettingValue;
  editable?: boolean;
  modified_on?: string | null;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  plan: { id: string; name: string };
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
  ttl: number;
  comment?: string | null;
}

export interface DnsRecordInput {
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  comment?: string;
}

export interface RulesetRule {
  id?: string;
  action: string;
  expression: string;
  description?: string;
  enabled?: boolean;
  action_parameters?: Record<string, unknown>;
}

export interface Ruleset {
  id: string;
  name: string;
  kind: string;
  phase: string;
  rules?: RulesetRule[];
}
