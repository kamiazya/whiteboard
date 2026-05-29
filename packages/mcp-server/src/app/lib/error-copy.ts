// UI copy helper for error banners (P-HTTP-005 level).
//
// Contract:
//   - Error.message is never forwarded — it may contain internal paths, tokens, or stack traces.
//   - body.message is never forwarded — it is not a standard Problem Details field and may be internal.
//   - body.title (RFC 9457 Problem Details) IS forwarded — it is a static, human-readable string
//     that server authors intend for display and is not derived from user input or request context.
//   - All other values return fallback.

export function safeErrorCopy(err: unknown, fallback: string): string {
  if (err instanceof Error) return fallback
  if (err && typeof err === 'object') {
    const body = (err as { body?: Record<string, unknown> }).body
    if (body && typeof body === 'object') {
      // RFC 9457 §3.1: 'title' is a short, human-readable summary of the problem type.
      if (typeof body['title'] === 'string' && body['title'].length > 0) return body['title']
    }
  }
  return fallback
}
