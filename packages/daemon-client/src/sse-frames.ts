/** The SSE wire format: frames out of a byte stream, events out of frames. */

interface SseEvent {
  event: string
  data: string
}

/**
 * One SSE frame — the text between two blank lines — as an event. `null` for
 * a frame carrying no `data:` line at all, which is what a comment or a bare
 * keep-alive is: something arrived, and there is nothing to deliver.
 *
 * Exported for its own test and for nothing else. Measured: every consumer in
 * `dispatch` re-validates through `parseFrame`, so dropping this rule changes
 * nothing a hub-level test can observe — a mutation of it survives the whole
 * suite. The rule is still the right one (an empty event is not an event),
 * and testing it where it lives is the only way to hold it.
 */
export function parseSseEvent(part: string): SseEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of part.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    // Per the SSE grammar a single event may carry several data: lines,
    // which concatenate with newlines.
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  return dataLines.length > 0 ? { event, data: dataLines.join('\n') } : null
}

/**
 * Split a raw SSE byte stream into events. Separate from the reader loop so a
 * frame arriving split across chunk boundaries — the normal case on a real
 * network — is a testable concern rather than an emergent one. The trailing
 * part is held back rather than parsed: with no blank line after it, it is
 * the start of a frame the next chunk finishes.
 */
export function createSseFrameParser(): (chunk: string) => SseEvent[] {
  let buffer = ''
  return (chunk: string) => {
    buffer += chunk
    const parts = buffer.split('\n\n')
    buffer = parts.pop() ?? ''
    return parts.map(parseSseEvent).filter((event): event is SseEvent => event !== null)
  }
}
