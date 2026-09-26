import type { CfErrorItem } from './types.ts';

/**
 * A failed Cloudflare API call. Carries the structured `errors` array so
 * callers can branch on Cloudflare's numeric codes rather than on message text.
 */
export class CfError extends Error {
  readonly status: number;
  readonly errors: CfErrorItem[];
  readonly path: string;

  constructor(path: string, status: number, errors: CfErrorItem[]) {
    const detail =
      errors.length > 0
        ? errors.map((e) => `${String(e.code)}: ${e.message}`).join('; ')
        : `HTTP ${String(status)}`;
    super(`Cloudflare API ${path} failed - ${detail}`);
    this.name = 'CfError';
    this.status = status;
    this.errors = errors;
    this.path = path;
  }

  /** True when Cloudflare reported any of the given numeric error codes. */
  hasCode(...codes: number[]): boolean {
    return this.errors.some((e) => codes.includes(e.code));
  }
}
