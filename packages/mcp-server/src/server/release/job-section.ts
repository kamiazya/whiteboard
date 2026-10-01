/**
 * The YAML section of one workflow job, sliced between adjacent job markers
 * (2-space-indented identifiers under `jobs:`). Scoping a check to a job
 * section prevents a field in one job satisfying a test that should fail for
 * another.
 *
 * `nextJobId` bounds the slice; without it the section runs to the end of the
 * file. An absent `jobId` answers the empty string, so a renamed job fails
 * the caller's assertion rather than matching nothing silently.
 */
export function jobSection(text: string, jobId: string, nextJobId?: string): string {
  const marker = `  ${jobId}:`
  const start = text.indexOf(marker)
  if (start === -1) return ''
  if (nextJobId) {
    const nextMarker = `  ${nextJobId}:`
    const end = text.indexOf(nextMarker, start)
    return end === -1 ? text.slice(start) : text.slice(start, end)
  }
  return text.slice(start)
}
