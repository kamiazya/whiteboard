import { timingSafeEqualStrings } from './timing-safe.js'

// Returns the raw Bearer token from a well-formed `Authorization: Bearer <token>`
// header, or null for any malformed / missing input. Strict: requires exactly one
// space after "Bearer", a non-empty token, and no whitespace, commas, or quotes
// in the token (those shapes indicate multi-value or non-token inputs).
export function parseBearerAuthorizationHeader(header: string | undefined): string | null {
  if (typeof header !== 'string') return null
  if (!header.startsWith('Bearer ')) return null
  const token = header.slice('Bearer '.length)
  if (token.length === 0 || /[\s,"]/.test(token)) return null
  return token
}

export function isAuthorized(
  authorization: string | undefined,
  token: string | undefined,
): boolean {
  if (!token) return true
  const parsed = parseBearerAuthorizationHeader(authorization)
  return parsed !== null && timingSafeEqualStrings(parsed, token)
}
