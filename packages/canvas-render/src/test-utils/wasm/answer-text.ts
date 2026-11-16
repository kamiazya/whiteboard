/**
 * A value as `scene_wire`'s JSON writes it: JavaScript's own number spelling
 * but `-0` kept, so the replay compares every double; undefined when a number
 * has no JSON spelling, which the core declines.
 */
export function answerText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined
    return Object.is(value, -0) ? '-0' : String(value)
  }
  if (typeof value !== 'object' || value === null) return JSON.stringify(value)
  const parts = Array.isArray(value)
    ? value.map(answerText)
    : Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => {
          const text = answerText(item)
          return text === undefined ? undefined : `${JSON.stringify(key)}:${text}`
        })
  if (parts.includes(undefined)) return undefined
  return Array.isArray(value) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
}
