// Convert an ISO string into "Nm ago", "Nh ago", "Nd ago", or YYYY-MM-DD.
// Used for the update timestamp shown in the sidebar.
// Fall back to an absolute date after 30 days.
export function formatRelativeTime(fromIso: string, nowMs: number = Date.now()): string {
  const diffMs = nowMs - new Date(fromIso).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 30) return `${diffDay}d ago`
  return fromIso.slice(0, 10)
}
