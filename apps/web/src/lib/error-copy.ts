// UI copy helper for error banners (P-HTTP-005 level).
//
// Contract:
//   - Error.message is never forwarded — it may contain internal paths, tokens, or stack traces.
//   - body.title (RFC 9457 Problem Details) IS forwarded — static, display-intended copy.
//   - body.message IS forwarded ONLY beside an `error` code: that pairing is the daemon's own
//     code+reason family (branch conflicts, unsupported merge), where `message` is
//     daemon-authored display copy. A bare `message` with no code is out of contract and stays
//     unforwarded.
//   - All other values return fallback.
//
// The reading goes through the shared apiErrorBodySchema — the single owner of what a daemon
// error body may look like — rather than hand-rolled field checks; three separate readers is
// how the branch routes' reasons got discarded while every test stayed green.
import { apiErrorReason } from '@kamiazya/whiteboard-daemon-client/api-contracts/index'

export function safeErrorCopy(err: unknown, fallback: string): string {
  if (err instanceof Error) return fallback
  if (err && typeof err === 'object') {
    const body = (err as { body?: unknown }).body
    const reason = apiErrorReason(body)
    if (reason !== undefined) return reason
  }
  return fallback
}
