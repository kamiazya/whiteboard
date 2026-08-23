const CONTEXT_RADIUS = 60

/**
 * A short plain-text excerpt around [index, index+length), whitespace
 * collapsed, ellipsised at cut edges. Shared by reference extraction and
 * search results so "where is this in the document" reads the same way
 * from both surfaces.
 */
export function snippetAround(value: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_RADIUS)
  const end = Math.min(value.length, index + length + CONTEXT_RADIUS)
  const text = value.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${text}${end < value.length ? '…' : ''}`
}
