/**
 * Coasty webhook signature verification.
 *
 * Header: `Coasty-Signature: t=<unix>,v1=<hex>`
 * Signed payload: `"<t>." + raw_body`
 * v1 = hex(HMAC_SHA256(webhook_secret, signed_payload))
 *
 * Implemented on WebCrypto rather than node:crypto so it runs inside the
 * Worker. The cookbook's reference implementation is Node-only; the algorithm
 * and its published test vectors are identical, and this module is tested
 * against those exact vectors.
 */

export const DEFAULT_TOLERANCE_SECONDS = 300;

export interface VerifyOptions {
  toleranceSeconds?: number;
  /** Unix seconds "now" override, for tests. */
  now?: number;
}

const TIMESTAMP = /^\d{1,15}$/;
const HEX_64 = /^[0-9a-fA-F]{64}$/;

/**
 * Verify a signature against the RAW request bytes.
 *
 * Returns false rather than throwing for every malformed input: a webhook
 * receiver that throws on a hostile header hands an attacker a way to tell
 * failure modes apart.
 */
export async function verifySignature(
  rawBody: string,
  header: string | null,
  secret: string,
  options: VerifyOptions = {},
): Promise<boolean> {
  try {
    if (header === null || secret === '') return false;

    const parts = new Map<string, string>();
    for (const piece of header.split(',')) {
      const eq = piece.indexOf('=');
      if (eq === -1) continue;
      const key = piece.slice(0, eq).trim();
      if (!parts.has(key)) parts.set(key, piece.slice(eq + 1).trim());
    }

    const timestamp = parts.get('t');
    const provided = parts.get('v1');
    if (timestamp === undefined || provided === undefined) return false;
    if (!TIMESTAMP.test(timestamp) || !HEX_64.test(provided)) return false;

    const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - Number(timestamp)) > tolerance) return false;

    const expected = await hmacHex(secret, `${timestamp}.${rawBody}`);
    return timingSafeEqualHex(expected, provided);
  } catch {
    return false;
  }
}

/** Sign a payload. Used by tests and by the offline mock to emit valid webhooks. */
export async function signPayload(rawBody: string, secret: string, timestamp: number): Promise<string> {
  const signature = await hmacHex(secret, `${String(timestamp)}.${rawBody}`);
  return `t=${String(timestamp)},v1=${signature}`;
}

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant time within a fixed length; length mismatch is rejected up front. */
function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}

/** SHA-256 of the raw body, used to make duplicate deliveries a no-op. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
