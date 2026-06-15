import { type ServerTextMessage, serverTextMessageSchema } from '../../shared/ws-messages.js'

export function parseServerTextMessage(
  raw: string,
  warn: (...args: unknown[]) => void = console.warn,
): ServerTextMessage | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    warn('[whiteboard] ignored invalid server text message:', 'malformed JSON', raw)
    return null
  }
  const result = serverTextMessageSchema.safeParse(parsed)
  if (!result.success) {
    warn(
      '[whiteboard] ignored invalid server text message:',
      result.error.issues[0]?.message ?? 'schema mismatch',
      parsed,
    )
    return null
  }
  return result.data
}
