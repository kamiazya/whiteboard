// Clock drift between client and daemon can make (now - t) negative; clamp
// so the label never reads "-5s ago".
//
// `pastDay` is the one knob a surface may legitimately want: a files list
// keeps counting ("3d ago" indefinitely), while the version timeline
// switches to an absolute local M/D HH:MM stamp — a saved version's age
// stops being the interesting fact once it is days old, its date is. One
// formatter with a parameter, because the fork this replaces diverged
// silently at exactly that boundary.
export function formatRelative(
  iso: string,
  options: { pastDay?: 'days-ago' | 'absolute'; invalid?: 'empty' | 'echo' } = {},
): string {
  const t = new Date(iso).getTime()
  // An unparsable stamp renders as nothing by default; the version timeline
  // echoes the raw string instead (its test pins that a corrupt createdAt is
  // at least visible rather than silently blank).
  if (!Number.isFinite(t)) return options.invalid === 'echo' ? iso : ''
  const diff = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (options.pastDay === 'absolute') {
    const d = new Date(t)
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${Math.floor(diff / 86400)}d ago`
}
