// Redaction primitives for diagnostic surfaces (JSONL logs, support bundles).
// These functions replace sensitive patterns — Bearer tokens and absolute paths —
// with stable sentinel strings so callers never forward raw credentials or local
// filesystem layout to external destinations.

export interface RedactionOptions {
  keepPaths?: boolean
}

// Bearer <token> → Bearer [REDACTED]
// The marker word "Bearer" is intentionally preserved so that downstream callers
// (e.g. log-jsonl scrubAuthMarkers) can apply a second pass if even the keyword
// is unwanted on that surface.
const BEARER_TOKEN_RE = /Bearer\s+\S+/g

// Absolute Unix paths: /letter-or-underscore followed by at least one more char.
// Matches paths like /opt/wb/server.ts or /Users/me/project.
const UNIX_PATH_RE = /\/[A-Za-z_][A-Za-z0-9_\-/.]+/g

export function redactDiagnosticText(text: string, options?: RedactionOptions): string {
  let result = text.replace(BEARER_TOKEN_RE, 'Bearer [REDACTED]')
  if (!options?.keepPaths) {
    result = result.replace(UNIX_PATH_RE, '[REDACTED_PATH]')
  }
  return result
}

export function redactDiagnosticValue(value: unknown, options?: RedactionOptions): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value, options)
  if (typeof value === 'bigint' || typeof value === 'function' || typeof value === 'symbol') {
    return '[REDACTED_NON_SERIALIZABLE]'
  }
  if (Array.isArray(value)) return value.map((v) => redactDiagnosticValue(v, options))
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDiagnosticValue(v, options)
    }
    return out
  }
  return value
}
