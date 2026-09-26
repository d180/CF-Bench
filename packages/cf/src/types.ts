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

export interface AccessDestination {
  type: string;
  uri?: string;
}

export interface AccessApp {
  id: string;
  name: string;
  type: string;
  /** Legacy single-hostname field. Cloudflare still populates it alongside `destinations`. */
  domain?: string;
  destinations?: AccessDestination[];
  session_duration?: string;
  aud?: string;
}

export interface AccessAppInput {
  name: string;
  type: string;
  domain: string;
  session_duration?: string;
}

/** Access policy rule selectors are open-ended; kept loose on purpose. */
export type AccessRule = Record<string, unknown>;

export interface AccessPolicy {
  id: string;
  name: string;
  decision: string;
  include?: AccessRule[];
  exclude?: AccessRule[];
  require?: AccessRule[];
}

export interface AccessPolicyInput {
  name: string;
  decision: string;
  include: AccessRule[];
}
